use axum::body::Body;
use chrono::{Duration as ChronoDuration, FixedOffset, SecondsFormat, Utc};
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use latitude_domain_service::{
    build_router, build_router_for_origins, build_router_for_web_port, AppState, Database,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tempfile::TempDir;
use tokio::time::{sleep, Duration};
use tower::ServiceExt;

async fn open_test_database() -> (TempDir, Database) {
    let directory = tempfile::tempdir().expect("temporary directory");
    let db_path = directory.path().join("latitude-domain.db");
    let backup_dir = directory.path().join("backups");
    let (database, report) = Database::open(&db_path, &backup_dir)
        .await
        .expect("fresh database migrates");
    assert_eq!(report.schema_version, "3");
    assert_eq!(report.migrations_applied, vec![1, 2, 3]);
    (directory, database)
}

#[tokio::test]
async fn concurrent_write_cannot_split_export_snapshot_and_clean_restore_stays_valid() {
    let (_source_directory, database) = open_test_database().await;
    let app = build_router(AppState::new(database.clone()));

    // Make the first exported table large enough to observe the export holding
    // the pool's single connection before queueing the concurrent relational
    // write. The payload is valid user data and remains inside the temp profile.
    let padding = "x".repeat(4 * 1_048_576);
    sqlx::query(
        "INSERT INTO source_records(\
         id, source_type, content_hash, privacy_level, storage_policy, model_access, \
         coverage_status, metadata_json, created_at) \
         VALUES ('source-export-barrier', 'import', 'sha256:export-barrier', 'low', \
         'local_only', 'forbidden', 'complete', ?, '2026-08-24T12:00:00.000Z')",
    )
    .bind(json!({ "padding": padding }).to_string())
    .execute(database.pool())
    .await
    .expect("seed large first export table");

    let exporting = {
        let database = database.clone();
        tokio::spawn(async move { database.export_document().await.expect("concurrent export") })
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        while database.pool().num_idle() != 0 {
            sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("export acquires the only SQLite connection");

    let writing = {
        let app = app.clone();
        tokio::spawn(async move {
            capture_user_message(
                &app,
                "concurrent-export",
                "concurrent message must be wholly before or after the snapshot",
                "low",
            )
            .await
        })
    };
    let snapshot = exporting.await.expect("export task joins");
    let write = writing.await.expect("write task joins");

    // The queued write began after the read transaction acquired the only pool
    // connection, so none of its related rows may leak into this snapshot.
    let source_id = write["value"]["sourceRecordId"].as_str().unwrap();
    let evidence_id = write["value"]["evidenceRefId"].as_str().unwrap();
    let node_id = write["value"]["nodeId"].as_str().unwrap();
    assert!(!snapshot.data["sourceRecords"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == source_id));
    assert!(!snapshot.data["evidenceRefs"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == evidence_id));
    assert!(!snapshot.data["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == node_id));

    let (_restore_directory, restored_database) = open_test_database().await;
    let restore_app = build_router(AppState::new(restored_database.clone()));
    let (prepare_status, prepared) = request_json(
        &restore_app,
        "POST",
        "/v1/admin/dangerous/prepare",
        Some(json!({ "operation": "restore", "snapshot": snapshot })),
        None,
    )
    .await;
    assert_eq!(prepare_status, StatusCode::ACCEPTED, "{prepared}");
    let (commit_status, restored) = request_json(
        &restore_app,
        "POST",
        "/v1/admin/dangerous/commit",
        Some(json!({
            "token": prepared["token"],
            "confirmation": "RESTORE LOCAL DATA"
        })),
        None,
    )
    .await;
    assert_eq!(commit_status, StatusCode::OK, "{restored}");
    let integrity = restored_database
        .integrity()
        .await
        .expect("restored integrity");
    assert_eq!(integrity["ok"], true, "{integrity}");
}

#[tokio::test]
async fn custom_browser_port_is_the_only_domain_cors_origin() {
    let (_directory, database) = open_test_database().await;
    let app = build_router_for_web_port(AppState::new(database), 51_234);

    for origin in ["http://127.0.0.1:51234", "http://localhost:51234"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .header("origin", origin)
                    .body(Body::empty())
                    .expect("cors request"),
            )
            .await
            .expect("router response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-origin")
                .and_then(|value| value.to_str().ok()),
            Some(origin)
        );
    }

    let rejected = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .header("origin", "http://127.0.0.1:1420")
                .body(Body::empty())
                .expect("rejected cors request"),
        )
        .await
        .expect("router response");
    assert_eq!(rejected.status(), StatusCode::OK);
    assert!(rejected
        .headers()
        .get("access-control-allow-origin")
        .is_none());
}

#[tokio::test]
async fn exact_public_browser_origin_can_be_added_without_broadening_cors() {
    let (_directory, database) = open_test_database().await;
    let public_origin = "https://latitude.baizhuo.online";
    let app = build_router_for_origins(
        AppState::new(database),
        51_234,
        Some(public_origin.parse().expect("public origin header")),
    );

    for origin in [public_origin, "https://other.example"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .header("origin", origin)
                    .body(Body::empty())
                    .expect("cors request"),
            )
            .await
            .expect("router response");
        assert_eq!(response.status(), StatusCode::OK);
        let allowed = response
            .headers()
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok());
        assert_eq!(allowed, (origin == public_origin).then_some(public_origin));
    }
}

async fn request_json(
    app: &axum::Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
    idempotency_key: Option<&str>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if body.is_some() {
        builder = builder.header("content-type", "application/json");
    }
    if let Some(key) = idempotency_key {
        builder = builder.header("idempotency-key", key);
    }
    let request = builder
        .body(match body {
            Some(body) => Body::from(serde_json::to_vec(&body).expect("json body")),
            None => Body::empty(),
        })
        .expect("request");
    let response = app.clone().oneshot(request).await.expect("router response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("response body")
        .to_bytes();
    let json = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }));
    (status, json)
}

async fn capture_user_message(
    app: &axum::Router,
    key: &str,
    content: &str,
    sensitivity: &str,
) -> Value {
    let body = json!({
        "clientRequestId": format!("message-{key}"),
        "messageId": format!("chat-{key}"),
        "content": content,
        "sensitivity": sensitivity,
        "audit": {
            "actor": "user",
            "sessionId": format!("session-{key}"),
            "turnId": format!("turn-{key}"),
            "authorizationMode": "automatic"
        }
    });
    let (status, response) = request_json(
        app,
        "POST",
        "/v1/evidence/message",
        Some(body),
        Some(&format!("idem-message-{key}")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    response
}

async fn create_evidenced_claim(
    app: &axum::Router,
    key: &str,
    statement: &str,
    sensitivity: &str,
    scope: Value,
) -> (Value, Value) {
    let message = capture_user_message(app, &format!("claim-{key}"), statement, sensitivity).await;
    let body = json!({
        "operation": "remember",
        "clientRequestId": format!("remember-{key}"),
        "label": format!("claim {key}"),
        "statement": statement,
        "kind": "claim",
        "payload": { "confidenceBand": "weak" },
        "scope": scope,
        "sensitivity": sensitivity,
        "evidenceRefs": [message["value"]["evidenceRefId"]],
        "audit": {
            "actor": "model",
            "sessionId": format!("session-{key}"),
            "turnId": format!("turn-{key}"),
            "toolCallId": format!("remember-{key}"),
            "authorizationMode": "automatic"
        }
    });
    let (status, response) = request_json(
        app,
        "POST",
        "/v1/changes",
        Some(body),
        Some(&format!("idem-remember-{key}")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    (response, message)
}

async fn create_action_for_claim(
    app: &axum::Router,
    key: &str,
    claim_id: &str,
    sensitivity: &str,
    review_at: &str,
) -> Value {
    let body = json!({
        "clientRequestId": format!("action-{key}"),
        "label": format!("action {key}"),
        "expectedOutcome": format!("observable result {key}"),
        "trigger": "when the planned window begins",
        "observationWindow": { "duration": "P1D", "sampleAt": "window_end" },
        "reviewAt": review_at,
        "payload": {},
        "scope": { "test": key },
        "sensitivity": sensitivity,
        "claimId": claim_id,
        "audit": {
            "actor": "model",
            "sessionId": format!("session-{key}"),
            "turnId": format!("action-{key}"),
            "authorizationMode": "automatic"
        }
    });
    let (status, response) = request_json(
        app,
        "POST",
        "/v1/actions",
        Some(body),
        Some(&format!("idem-action-{key}")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    response
}

fn encoded_rfc3339(value: &str) -> String {
    value.replace(':', "%3A").replace('+', "%2B")
}

async fn candidate_context(app: &axum::Router, candidate_id: &str) -> Value {
    let (status, response) = request_json(
        app,
        "POST",
        "/v1/context",
        Some(json!({
            "limit": 100,
            "sensitivityCeiling": "highest"
        })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    response["nodes"]
        .as_array()
        .and_then(|nodes| nodes.iter().find(|node| node["id"] == candidate_id))
        .cloned()
        .unwrap_or_else(|| panic!("candidate {candidate_id} missing from {response}"))
}

#[tokio::test]
async fn candidate_intervention_is_typed_due_only_reversible_and_profile_safe() {
    let (directory, database) = open_test_database().await;
    let db_path = database.path().to_path_buf();
    let backup_dir = directory.path().join("backups");
    let app = build_router(AppState::new(database.clone()));

    let (status, created) = request_json(
        &app,
        "POST",
        "/v1/candidates",
        Some(json!({
            "clientRequestId": "candidate-create",
            "label": "把上午写作变成可持续节律",
            "statement": "先观察哪一种启动方式值得继续共创",
            "sourceNodeIds": [],
            "evidenceRefs": [],
            "payload": { "theme": "writing" },
            "scope": { "domain": "work" },
            "sensitivity": "low",
            "audit": {
                "actor": "user",
                "sessionId": "candidate-session",
                "turnId": "candidate-create",
                "authorizationMode": "automatic"
            }
        })),
        Some("candidate-create"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let candidate_id = created["value"]["candidate"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(created["value"]["candidate"]["kind"], "experiment");
    assert_eq!(
        created["value"]["candidate"]["payload"]["interventionType"],
        "candidate"
    );
    assert_eq!(
        created["value"]["candidate"]["payload"]["candidateState"],
        "proposed"
    );
    assert_eq!(created["value"]["receipt"]["state"], "proposed");
    assert_eq!(
        created["value"]["receipt"]["changeSetId"],
        created["changeSetId"]
    );

    let (status, bypass) = request_json(
        &app,
        "POST",
        "/v1/changes",
        Some(json!({
            "operation": "update",
            "clientRequestId": "candidate-bypass",
            "id": candidate_id,
            "status": "concluded",
            "audit": { "actor": "user", "authorizationMode": "automatic" }
        })),
        Some("candidate-bypass"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{bypass}");

    let proposed_due_at = created["value"]["candidate"]["payload"]["proposedSilenceDueAt"]
        .as_str()
        .unwrap();
    let proposed_entered_at = chrono::DateTime::parse_from_rfc3339(
        created["value"]["candidate"]["payload"]["stateEnteredAt"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert!(
        chrono::DateTime::parse_from_rfc3339(proposed_due_at).unwrap() - proposed_entered_at
            >= ChronoDuration::days(3)
    );
    let proposed_fixture_due_at =
        (Utc::now() - ChronoDuration::seconds(1)).to_rfc3339_opts(SecondsFormat::Millis, true);
    sqlx::query(
        "UPDATE nodes SET payload_json=json_set(payload_json, '$.proposedSilenceDueAt', ?) WHERE id=?",
    )
    .bind(&proposed_fixture_due_at)
    .bind(&candidate_id)
    .execute(database.pool())
    .await
    .expect("advance proposed candidate fixture clock");
    let proposed_due_after = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let proposed_due_uri = format!(
        "/v1/candidates/due?at={}&limit=10&sensitivityCeiling=low",
        encoded_rfc3339(&proposed_due_after)
    );
    let (status, proposed_due) = request_json(&app, "GET", &proposed_due_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{proposed_due}");
    assert_eq!(proposed_due["items"][0]["dueKind"], "proposed_silence");
    assert_eq!(
        proposed_due["items"][0]["recommendedCommand"],
        "acknowledge_due"
    );
    assert_eq!(
        candidate_context(&app, &candidate_id).await["payload"]["candidateState"],
        "proposed",
        "a due query must never manufacture a transition"
    );

    let (status, proposed_acknowledged) = request_json(
        &app,
        "POST",
        &format!("/v1/candidates/{candidate_id}/commands"),
        Some(json!({
            "clientRequestId": "candidate-ack-proposed-due",
            "command": "acknowledge_due",
            "audit": { "actor": "system", "authorizationMode": "automatic" }
        })),
        Some("candidate-ack-proposed-due"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{proposed_acknowledged}");
    assert_eq!(
        proposed_acknowledged["value"]["receipt"]["dueKind"],
        "proposed_silence"
    );
    assert_eq!(
        proposed_acknowledged["value"]["receipt"]["state"], "proposed",
        "delivery acknowledgement must not park or conclude silence"
    );
    assert!(
        proposed_acknowledged["value"]["candidate"]["payload"]["proposedPromptedAt"].is_string()
    );
    let (status, proposed_no_repeat) =
        request_json(&app, "GET", &proposed_due_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{proposed_no_repeat}");
    assert!(proposed_no_repeat["items"].as_array().unwrap().is_empty());
    let restarted_app = build_router(AppState::new(database.clone()));
    let (status, proposed_after_restart) =
        request_json(&restarted_app, "GET", &proposed_due_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{proposed_after_restart}");
    assert!(proposed_after_restart["items"]
        .as_array()
        .unwrap()
        .is_empty());

    let (status, illegal_shape) = request_json(
        &app,
        "POST",
        &format!("/v1/candidates/{candidate_id}/commands"),
        Some(json!({
            "clientRequestId": "candidate-illegal-shape",
            "command": "shape",
            "audit": { "actor": "user", "authorizationMode": "automatic" }
        })),
        Some("candidate-illegal-shape"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{illegal_shape}");

    let (status, touched) = request_json(
        &app,
        "POST",
        &format!("/v1/candidates/{candidate_id}/commands"),
        Some(json!({
            "clientRequestId": "candidate-touch-1",
            "command": "touch",
            "audit": { "actor": "user", "authorizationMode": "automatic" }
        })),
        Some("candidate-touch-1"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{touched}");
    assert_eq!(touched["value"]["candidate"]["status"], "active");
    assert_eq!(touched["value"]["receipt"]["state"], "touched");
    let touch_change_set = touched["changeSetId"].as_str().unwrap();

    let (status, touch_rollback) = request_json(
        &app,
        "POST",
        "/v1/changes",
        Some(json!({
            "operation": "rollback",
            "clientRequestId": "candidate-touch-rollback",
            "changeSetId": touch_change_set,
            "reason": "verify candidate touch rollback",
            "audit": { "actor": "user", "authorizationMode": "automatic" }
        })),
        Some("candidate-touch-rollback"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{touch_rollback}");
    assert_eq!(
        candidate_context(&app, &candidate_id).await["payload"]["candidateState"],
        "proposed"
    );

    for (key, command, expected) in [
        ("candidate-touch-2", "touch", "touched"),
        ("candidate-shape", "shape", "shaping"),
    ] {
        let (status, response) = request_json(
            &app,
            "POST",
            &format!("/v1/candidates/{candidate_id}/commands"),
            Some(json!({
                "clientRequestId": key,
                "command": command,
                "audit": { "actor": "user", "authorizationMode": "automatic" }
            })),
            Some(key),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{response}");
        assert_eq!(response["value"]["receipt"]["state"], expected);
        assert_eq!(
            response["value"]["receipt"]["changeSetId"],
            response["changeSetId"]
        );
    }
    let shaping = candidate_context(&app, &candidate_id).await;
    let shaping_due_at = shaping["payload"]["shapingFollowupDueAt"].as_str().unwrap();
    let shaping_entered_at = chrono::DateTime::parse_from_rfc3339(
        shaping["payload"]["stateEnteredAt"].as_str().unwrap(),
    )
    .unwrap();
    assert!(
        chrono::DateTime::parse_from_rfc3339(shaping_due_at).unwrap() - shaping_entered_at
            >= ChronoDuration::days(7)
    );
    // Advance only this fixture's stored clock; production due reads remain
    // read-only and the typed acknowledgement still evaluates real wall time.
    let fixture_due_at =
        (Utc::now() - ChronoDuration::seconds(1)).to_rfc3339_opts(SecondsFormat::Millis, true);
    sqlx::query(
        "UPDATE nodes SET payload_json=json_set(payload_json, '$.shapingFollowupDueAt', ?) WHERE id=?",
    )
    .bind(&fixture_due_at)
    .bind(&candidate_id)
    .execute(database.pool())
    .await
    .expect("advance candidate fixture clock");
    let shaping_due_after = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let shaping_due_uri = format!(
        "/v1/candidates/due?at={}&limit=10&sensitivityCeiling=low",
        encoded_rfc3339(&shaping_due_after)
    );
    let (status, shaping_due) = request_json(&app, "GET", &shaping_due_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{shaping_due}");
    assert_eq!(shaping_due["items"][0]["dueKind"], "shaping_followup");

    let (status, acknowledged) = request_json(
        &app,
        "POST",
        &format!("/v1/candidates/{candidate_id}/commands"),
        Some(json!({
            "clientRequestId": "candidate-ack-due",
            "command": "acknowledge_due",
            "audit": { "actor": "system", "authorizationMode": "automatic" }
        })),
        Some("candidate-ack-due"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{acknowledged}");
    assert_eq!(acknowledged["value"]["receipt"]["state"], "shaping");
    let ack_change_set = acknowledged["changeSetId"].as_str().unwrap();
    let (status, no_repeat) = request_json(&app, "GET", &shaping_due_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{no_repeat}");
    assert!(no_repeat["items"].as_array().unwrap().is_empty());

    let (status, ack_rollback) = request_json(
        &app,
        "POST",
        "/v1/changes",
        Some(json!({
            "operation": "rollback",
            "clientRequestId": "candidate-ack-rollback",
            "changeSetId": ack_change_set,
            "reason": "verify one-time prompt receipt rollback",
            "audit": { "actor": "user", "authorizationMode": "automatic" }
        })),
        Some("candidate-ack-rollback"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{ack_rollback}");
    let (_, reopened_due) = request_json(&app, "GET", &shaping_due_uri, None, None).await;
    assert_eq!(reopened_due["items"].as_array().unwrap().len(), 1);

    let (status, concluded) = request_json(
        &app,
        "POST",
        &format!("/v1/candidates/{candidate_id}/commands"),
        Some(json!({
            "clientRequestId": "candidate-conclude",
            "command": "conclude",
            "note": "形成一个可继续验证的阶段结论",
            "audit": { "actor": "user", "authorizationMode": "automatic" }
        })),
        Some("candidate-conclude"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{concluded}");
    assert_eq!(concluded["value"]["candidate"]["status"], "concluded");
    assert_eq!(concluded["value"]["receipt"]["state"], "concluded");

    let period_start =
        (Utc::now() - ChronoDuration::days(1)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let period_end =
        (Utc::now() + ChronoDuration::days(1)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let (status, weekly) = request_json(
        &app,
        "POST",
        "/v1/reviews",
        Some(json!({
            "clientRequestId": "candidate-weekly",
            "periodStart": period_start,
            "periodEnd": period_end,
            "sensitivityCeiling": "low",
            "audit": { "actor": "user", "authorizationMode": "automatic" }
        })),
        Some("candidate-weekly"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{weekly}");
    assert_eq!(
        weekly["value"]["sections"]["doubleLoop"]["candidates"]["concluded"][0]["id"],
        candidate_id
    );

    let (status, snapshot) = request_json(&app, "GET", "/v1/admin/export", None, None).await;
    assert_eq!(status, StatusCode::OK, "{snapshot}");
    assert!(snapshot["data"]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|node| node["id"] == candidate_id));

    let (_restore_directory, restore_database) = open_test_database().await;
    let restore_app = build_router(AppState::new(restore_database.clone()));
    let (status, prepared) = request_json(
        &restore_app,
        "POST",
        "/v1/admin/dangerous/prepare",
        Some(json!({ "operation": "restore", "snapshot": snapshot })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{prepared}");
    let (status, restored) = request_json(
        &restore_app,
        "POST",
        "/v1/admin/dangerous/commit",
        Some(json!({
            "token": prepared["token"],
            "confirmation": prepared["requiredConfirmation"]
        })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    assert_eq!(
        candidate_context(&restore_app, &candidate_id).await["payload"]["candidateState"],
        "concluded"
    );
    restore_database.close().await;

    drop(app);
    database.close().await;
    let (reopened, report) = Database::open(&db_path, &backup_dir)
        .await
        .expect("v3 database with candidate reopens without enum migration");
    assert_eq!(report.schema_version, "3");
    assert!(report.migrations_applied.is_empty());
    let reopened_app = build_router(AppState::new(reopened.clone()));
    assert_eq!(
        candidate_context(&reopened_app, &candidate_id).await["payload"]["candidateState"],
        "concluded"
    );
    reopened.close().await;
}

async fn record_evidenced_outcome(
    app: &axum::Router,
    key: &str,
    action_id: &str,
    claim_id: &str,
    effect: &str,
    revised_statement: Option<&str>,
) -> Value {
    let statement = format!("observed {key} result for effect {effect}");
    let message = capture_user_message(app, &format!("outcome-{key}"), &statement, "low").await;
    let body = json!({
        "clientRequestId": format!("outcome-{key}"),
        "actionId": action_id,
        "label": format!("outcome {key}"),
        "outcome": statement,
        "effect": effect,
        "claimId": claim_id,
        "revisedStatement": revised_statement,
        "evidenceRefs": [message["value"]["evidenceRefId"]],
        "payload": {},
        "audit": {
            "actor": "model",
            "sessionId": format!("session-{key}"),
            "turnId": format!("outcome-{key}"),
            "toolCallId": format!("outcome-tool-{key}"),
            "authorizationMode": "automatic"
        }
    });
    let (status, response) = request_json(
        app,
        "POST",
        "/v1/outcomes",
        Some(body),
        Some(&format!("idem-outcome-{key}")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    response
}

#[tokio::test]
async fn linked_evidence_event_preempts_calendar_and_rollback_restores_fallback() {
    let (_directory, database) = open_test_database().await;
    let app = build_router(AppState::new(database.clone()));
    let (claim, _) = create_evidenced_claim(
        &app,
        "event-clock",
        "A short focus block improves delivery quality",
        "low",
        json!({ "domain": "work" }),
    )
    .await;
    let claim_id = claim["value"]["id"].as_str().unwrap();
    let review_at =
        (Utc::now() + ChronoDuration::days(30)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let action = create_action_for_claim(&app, "event-clock", claim_id, "low", &review_at).await;
    let action_id = action["value"]["action"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let event = capture_user_message(
        &app,
        "event-clock-signal",
        "The planned focus block just finished and there is a concrete observation.",
        "low",
    )
    .await;
    let event_node_id = event["value"]["nodeId"].as_str().unwrap();
    let evidence_ref_id = event["value"]["evidenceRefId"].as_str().unwrap();
    let query_at =
        (Utc::now() + ChronoDuration::hours(1)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let query_uri = format!(
        "/v1/actions/due?at={}&limit=100&sensitivityCeiling=low",
        query_at.replace(':', "%3A").replace('+', "%2B")
    );

    let (status, unrelated) = request_json(&app, "GET", &query_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{unrelated}");
    assert!(unrelated["items"].as_array().unwrap().is_empty());

    let (status, location) = request_json(
        &app,
        "POST",
        "/v1/star-map/apply-location",
        Some(json!({
            "clientRequestId": "event-clock-location",
            "eventNodeId": event_node_id,
            "starCenterNodeId": claim_id,
            "relationType": "about",
            "evidenceRefs": [evidence_ref_id],
            "basis": "explicit_statement",
            "proximity": "direct",
            "strength": "strong",
            "rationale": "The user explicitly described the observation as the result of this tested action.",
            "audit": {
                "actor": "model",
                "sessionId": "session-event-clock",
                "turnId": "turn-event-clock",
                "authorizationMode": "preauthorized"
            }
        })),
        Some("idem-event-clock-location"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{location}");

    let (status, event_due) = request_json(&app, "GET", &query_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{event_due}");
    let due = event_due["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == action_id)
        .expect("linked evidence makes the future action due immediately");
    assert_eq!(due["dueReason"], "linked_event");
    assert_ne!(due["dueAt"], review_at);
    assert_eq!(due["triggerEventReceipt"]["eventNodeId"], event_node_id);
    assert_eq!(
        due["triggerEventReceipt"]["relationKind"],
        "tested_claim_edge"
    );
    let period_start =
        (Utc::now() - ChronoDuration::days(1)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let (status, weekly) = request_json(
        &app,
        "POST",
        "/v1/reviews",
        Some(json!({
            "periodStart": period_start,
            "periodEnd": query_at,
            "sensitivityCeiling": "low",
            "audit": { "actor": "user", "authorizationMode": "automatic" }
        })),
        Some("idem-event-clock-weekly"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{weekly}");
    let weekly_action = weekly["value"]["sections"]["singleLoop"]["dueActions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == action_id)
        .expect("weekly fold reuses the event-first due-action read model");
    assert_eq!(weekly_action["dueReason"], "linked_event");
    assert_eq!(
        weekly_action["triggerEventReceipt"]["eventNodeId"],
        event_node_id
    );

    let (status, rollback) = request_json(
        &app,
        "POST",
        "/v1/changes",
        Some(json!({
            "operation": "rollback",
            "clientRequestId": "event-clock-rollback",
            "changeSetId": location["changeSetId"],
            "reason": "verify event relation rollback",
            "audit": { "actor": "user", "authorizationMode": "automatic" }
        })),
        Some("idem-event-clock-rollback"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{rollback}");
    let (status, after_rollback) = request_json(&app, "GET", &query_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{after_rollback}");
    assert!(after_rollback["items"].as_array().unwrap().is_empty());

    // Browser chat is medium by default. Its text stays sealed, but an explicit
    // relation may act as an opaque wake signal for an already-low action.
    let medium_event = capture_user_message(
        &app,
        "event-clock-medium-signal",
        "This medium chat message contains details that must not enter a low reminder.",
        "medium",
    )
    .await;
    let (status, medium_location) = request_json(
        &app,
        "POST",
        "/v1/star-map/apply-location",
        Some(json!({
            "clientRequestId": "event-clock-medium-location",
            "eventNodeId": medium_event["value"]["nodeId"],
            "starCenterNodeId": claim_id,
            "relationType": "about",
            "evidenceRefs": [medium_event["value"]["evidenceRefId"]],
            "basis": "explicit_statement",
            "rationale": "Explicit standard chat event related to the tested claim.",
            "audit": { "actor": "model", "authorizationMode": "preauthorized" }
        })),
        Some("idem-event-clock-medium-location"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{medium_location}");
    let (status, medium_due) = request_json(&app, "GET", &query_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{medium_due}");
    let medium_due_action = medium_due["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == action_id)
        .expect("an explicitly related medium chat event wakes the low action");
    assert_eq!(medium_due_action["dueReason"], "linked_event");
    assert_eq!(
        medium_due_action["triggerEventReceipt"]["eventNodeId"],
        medium_event["value"]["nodeId"]
    );
    let projected = serde_json::to_string(medium_due_action).unwrap();
    assert!(!projected.contains("contains details"));
    assert!(!projected.contains("This medium chat message"));
    let (status, medium_rollback) = request_json(
        &app,
        "POST",
        "/v1/changes",
        Some(json!({
            "operation": "rollback",
            "clientRequestId": "event-clock-medium-rollback",
            "changeSetId": medium_location["changeSetId"],
            "reason": "remove medium event wake fixture",
            "audit": { "actor": "user", "authorizationMode": "automatic" }
        })),
        Some("idem-event-clock-medium-rollback"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{medium_rollback}");
    let (_, after_medium_rollback) = request_json(&app, "GET", &query_uri, None, None).await;
    assert!(after_medium_rollback["items"]
        .as_array()
        .unwrap()
        .is_empty());

    let high_event = capture_user_message(
        &app,
        "event-clock-high-signal",
        "A private high-sensitivity observation is related to the same action.",
        "high",
    )
    .await;
    let (status, high_location) = request_json(
        &app,
        "POST",
        "/v1/star-map/apply-location",
        Some(json!({
            "clientRequestId": "event-clock-high-location",
            "eventNodeId": high_event["value"]["nodeId"],
            "starCenterNodeId": claim_id,
            "relationType": "about",
            "evidenceRefs": [high_event["value"]["evidenceRefId"]],
            "basis": "explicit_statement",
            "rationale": "Explicit high-sensitivity test fixture relation.",
            "audit": { "actor": "user", "authorizationMode": "automatic" }
        })),
        Some("idem-event-clock-high-location"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{high_location}");
    let (_, low_ceiling) = request_json(&app, "GET", &query_uri, None, None).await;
    assert!(
        low_ceiling["items"].as_array().unwrap().is_empty(),
        "unattended low-sensitivity collection must not reveal a high-sensitivity event receipt"
    );
    let high_query_uri = query_uri.replace("sensitivityCeiling=low", "sensitivityCeiling=high");
    let (status, high_ceiling) = request_json(&app, "GET", &high_query_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{high_ceiling}");
    assert_eq!(high_ceiling["items"][0]["dueReason"], "linked_event");
    assert_eq!(
        high_ceiling["items"][0]["triggerEventReceipt"]["eventNodeId"],
        high_event["value"]["nodeId"]
    );
    let (status, high_rollback) = request_json(
        &app,
        "POST",
        "/v1/changes",
        Some(json!({
            "operation": "rollback",
            "clientRequestId": "event-clock-high-rollback",
            "changeSetId": high_location["changeSetId"],
            "reason": "remove high-sensitivity test relation",
            "audit": { "actor": "user", "authorizationMode": "automatic" }
        })),
        Some("idem-event-clock-high-rollback"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{high_rollback}");

    let after_review =
        (Utc::now() + ChronoDuration::days(31)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let after_review_uri = format!(
        "/v1/actions/due?at={}&limit=100&sensitivityCeiling=low",
        after_review.replace(':', "%3A").replace('+', "%2B")
    );
    let (status, calendar_due) = request_json(&app, "GET", &after_review_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{calendar_due}");
    let fallback = calendar_due["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == action_id)
        .expect("reviewAt remains a calendar fallback after the event relation is rolled back");
    assert_eq!(fallback["dueReason"], "calendar_fallback");
    assert_eq!(fallback["dueAt"], review_at);
}

#[tokio::test]
async fn fresh_migration_is_transactional_and_reopen_creates_startup_backup() {
    let (directory, database) = open_test_database().await;
    let integrity = database.integrity().await.expect("integrity report");
    assert_eq!(integrity["ok"], true);
    assert_eq!(integrity["migrationCount"], 3);
    let db_path = database.path().to_path_buf();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let db_mode = std::fs::metadata(&db_path).unwrap().permissions().mode() & 0o777;
        let parent_mode = std::fs::metadata(db_path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let backup_mode = std::fs::metadata(directory.path().join("backups"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(db_mode, 0o600);
        assert_eq!(parent_mode, 0o700);
        assert_eq!(backup_mode, 0o700);
    }
    database.close().await;

    let (reopened, report) = Database::open(&db_path, directory.path().join("backups"))
        .await
        .expect("reopen database");
    assert!(report.migrations_applied.is_empty());
    let backup = report.startup_backup.expect("startup backup path");
    assert!(backup.exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&backup).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    reopened.close().await;
}

#[tokio::test]
async fn startup_backup_retention_keeps_ten_without_touching_other_recovery_files() {
    let (directory, database) = open_test_database().await;
    let db_path = database.path().to_path_buf();
    let backup_dir = directory.path().join("backups");
    database.close().await;

    for second in 0..13 {
        let primary = backup_dir.join(format!(
            "latitude-domain.db.20200101T1200{second:02}.000Z.startup.bak"
        ));
        std::fs::write(&primary, format!("startup-{second}")).unwrap();
        std::fs::write(
            PathBuf::from(format!("{}-wal", primary.display())),
            format!("wal-{second}"),
        )
        .unwrap();
    }
    let recovery = backup_dir.join("latitude-domain.db.20200101T130000.000Z.pre-delete-all.bak");
    std::fs::write(&recovery, b"recoverable-reset").unwrap();
    let unknown = backup_dir.join("personal-notes.txt");
    std::fs::write(&unknown, b"not owned by retention").unwrap();

    let (reopened, report) = Database::open(&db_path, &backup_dir)
        .await
        .expect("retention and startup backup succeed");
    assert_eq!(report.startup_backups_pruned.len(), 4);
    assert!(report
        .startup_backup
        .as_ref()
        .is_some_and(|path| path.exists()));
    let startup_primaries = std::fs::read_dir(&backup_dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .ends_with(".startup.bak")
        })
        .count();
    assert_eq!(startup_primaries, 10);
    assert!(!backup_dir
        .join("latitude-domain.db.20200101T120000.000Z.startup.bak-wal")
        .exists());
    assert!(
        recovery.exists(),
        "recovery backups are outside startup retention"
    );
    assert_eq!(std::fs::read(&unknown).unwrap(), b"not owned by retention");
    reopened.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn startup_backup_retention_refuses_a_forged_symlink_before_copying() {
    use std::os::unix::fs::symlink;

    let (directory, database) = open_test_database().await;
    let db_path = database.path().to_path_buf();
    let backup_dir = directory.path().join("backups");
    database.close().await;
    let external = directory.path().join("outside-startup-backup.txt");
    std::fs::write(&external, b"outside sentinel").unwrap();
    let forged = backup_dir.join("latitude-domain.db.20200101T120000.000Z.startup.bak");
    symlink(&external, &forged).unwrap();

    let error = Database::open(&db_path, &backup_dir)
        .await
        .err()
        .expect("forged startup backup symlink is rejected");
    assert!(format!("{error}").contains("startup backup"));
    assert_eq!(std::fs::read(&external).unwrap(), b"outside sentinel");
    let startup_primaries = std::fs::read_dir(&backup_dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .ends_with(".startup.bak")
        })
        .count();
    assert_eq!(
        startup_primaries, 1,
        "no new backup is copied after rejection"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn database_and_sidecar_symlinks_are_rejected_without_copying_external_content() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().unwrap();
    let external = directory.path().join("outside-secret.db");
    std::fs::write(&external, b"external sentinel").unwrap();
    let linked_database = directory.path().join("linked.db");
    symlink(&external, &linked_database).unwrap();
    let linked_error = Database::open(&linked_database, directory.path().join("linked-backups"))
        .await
        .err()
        .expect("main database symlink is rejected");
    assert!(format!("{linked_error}").contains("regular non-symlink"));
    assert_eq!(std::fs::read(&external).unwrap(), b"external sentinel");

    let normal_path = directory.path().join("normal.db");
    let backup_dir = directory.path().join("normal-backups");
    let (normal, _) = Database::open(&normal_path, &backup_dir).await.unwrap();
    normal.close().await;
    let sidecar = PathBuf::from(format!("{}-wal", normal_path.display()));
    if sidecar.exists() {
        std::fs::remove_file(&sidecar).unwrap();
    }
    symlink(&external, &sidecar).unwrap();
    let sidecar_error = Database::open(&normal_path, &backup_dir)
        .await
        .err()
        .expect("sidecar symlink is rejected before startup");
    assert!(format!("{sidecar_error}").contains("regular non-symlink"));
    assert_eq!(std::fs::read(&external).unwrap(), b"external sentinel");
    let copied_sidecars = std::fs::read_dir(&backup_dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with("-wal"))
        .count();
    assert_eq!(
        copied_sidecars, 0,
        "external sidecar target is never copied"
    );
}

#[tokio::test]
async fn weekly_due_requires_a_ceiling_eligible_loop_artifact_but_manual_review_stays_available() {
    let (_directory, database) = open_test_database().await;
    let app = build_router(AppState::new(database.clone()));
    let due_uri =
        "/v1/reviews?status=due&dueBefore=2030-01-08T00%3A00%3A00.000Z&limit=20&sensitivityCeiling=low";

    let (status, empty_week) = request_json(&app, "GET", due_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{empty_week}");
    assert!(empty_week["items"].as_array().unwrap().is_empty());
    assert_eq!(empty_week["latestCompleteWeek"]["status"], "empty");
    assert_eq!(empty_week["latestCompleteWeek"]["eligibleArtifactCount"], 0);
    let period_start = empty_week["latestCompleteWeek"]["periodStart"]
        .as_str()
        .unwrap()
        .to_string();
    let period_end = empty_week["latestCompleteWeek"]["periodEnd"]
        .as_str()
        .unwrap()
        .to_string();

    let (status, manual_empty_review) = request_json(
        &app,
        "POST",
        "/v1/reviews",
        Some(json!({
            "clientRequestId": "manual-empty-week",
            "periodStart": period_start,
            "periodEnd": period_end,
            "sensitivityCeiling": "medium",
            "audit": { "actor": "user", "authorizationMode": "automatic" }
        })),
        Some("idem-manual-empty-week"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{manual_empty_review}");
    assert!(manual_empty_review["value"]["outcomes"]
        .as_array()
        .unwrap()
        .is_empty());

    let high_review_at = "2030-01-01T12:00:00.000Z";
    let (high_claim, _) = create_evidenced_claim(
        &app,
        "empty-week-high-only",
        "high sensitivity weekly artifact",
        "high",
        json!({}),
    )
    .await;
    create_action_for_claim(
        &app,
        "empty-week-high-only",
        high_claim["value"]["id"].as_str().unwrap(),
        "high",
        high_review_at,
    )
    .await;
    let (status, still_empty_low) = request_json(&app, "GET", due_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{still_empty_low}");
    assert!(still_empty_low["items"].as_array().unwrap().is_empty());
    assert_eq!(still_empty_low["latestCompleteWeek"]["status"], "empty");

    let high_uri =
        "/v1/reviews?status=due&dueBefore=2030-01-08T00%3A00%3A00.000Z&limit=20&sensitivityCeiling=high";
    let (status, high_due) = request_json(&app, "GET", high_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{high_due}");
    assert_eq!(high_due["items"].as_array().unwrap().len(), 1);
    assert_eq!(high_due["items"][0]["status"], "due");

    let (low_claim, _) = create_evidenced_claim(
        &app,
        "empty-week-low",
        "low sensitivity weekly artifact",
        "low",
        json!({}),
    )
    .await;
    create_action_for_claim(
        &app,
        "empty-week-low",
        low_claim["value"]["id"].as_str().unwrap(),
        "low",
        high_review_at,
    )
    .await;
    let (status, first_due) = request_json(&app, "GET", due_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{first_due}");
    assert_eq!(first_due["items"].as_array().unwrap().len(), 1);
    assert_eq!(first_due["items"][0]["status"], "due");
    assert!(first_due["items"][0]["eligibleArtifactCount"]
        .as_i64()
        .is_some_and(|count| count >= 1));
    let first_receipt = first_due["items"][0]["receiptKey"].clone();
    let (status, repeated_due) = request_json(&app, "GET", due_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{repeated_due}");
    assert_eq!(repeated_due["items"][0]["receiptKey"], first_receipt);
}

#[tokio::test]
async fn review_status_keeps_revision_claim_and_candidate_bindings_in_their_own_slots() {
    let (_directory, database) = open_test_database().await;
    let app = build_router(AppState::new(database.clone()));
    let due_uri =
        "/v1/reviews?status=due&dueBefore=2030-01-08T00%3A00%3A00.000Z&limit=20&sensitivityCeiling=low";

    // A high-sensitivity pending revision must not leak through the sixth SQL
    // placeholder when the caller asks for a low ceiling.
    let (high_claim, _) = create_evidenced_claim(
        &app,
        "review-bind-high-pending",
        "high revision must remain outside low review",
        "high",
        json!({}),
    )
    .await;
    let high_claim_id = high_claim["value"]["id"].as_str().unwrap();
    let high_action = create_action_for_claim(
        &app,
        "review-bind-high-pending",
        high_claim_id,
        "high",
        "2040-01-01T12:00:00.000Z",
    )
    .await;
    record_evidenced_outcome(
        &app,
        "review-bind-high-pending",
        high_action["value"]["action"]["id"].as_str().unwrap(),
        high_claim_id,
        "unknown",
        None,
    )
    .await;
    let (status, low_empty) = request_json(&app, "GET", due_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{low_empty}");
    assert_eq!(low_empty["latestCompleteWeek"]["status"], "empty");
    assert_eq!(low_empty["latestCompleteWeek"]["eligibleArtifactCount"], 0);

    // Put exactly one low Claim ChangeSet inside the requested complete week.
    let (low_claim, _) = create_evidenced_claim(
        &app,
        "review-bind-low-claim",
        "low claim belongs in the complete-week review",
        "low",
        json!({}),
    )
    .await;
    sqlx::query("UPDATE change_sets SET applied_at=? WHERE id=?")
        .bind("2030-01-02T12:00:00.000Z")
        .bind(low_claim["changeSetId"].as_str().unwrap())
        .execute(database.pool())
        .await
        .expect("move claim fixture into complete week");
    let (status, claim_due) = request_json(&app, "GET", due_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{claim_due}");
    assert_eq!(claim_due["latestCompleteWeek"]["status"], "due");
    assert_eq!(claim_due["latestCompleteWeek"]["eligibleArtifactCount"], 1);

    // The Candidate has its own final three placeholders. Adding it must raise
    // the count by exactly one, without borrowing the Claim or revision binds.
    let (status, candidate) = request_json(
        &app,
        "POST",
        "/v1/candidates",
        Some(json!({
            "clientRequestId": "review-bind-candidate",
            "label": "review binding candidate",
            "statement": "candidate change belongs in the same complete week",
            "sensitivity": "low",
            "audit": { "actor": "user", "authorizationMode": "automatic" }
        })),
        Some("review-bind-candidate"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{candidate}");
    sqlx::query("UPDATE change_sets SET applied_at=? WHERE id=?")
        .bind("2030-01-03T12:00:00.000Z")
        .bind(candidate["changeSetId"].as_str().unwrap())
        .execute(database.pool())
        .await
        .expect("move candidate fixture into complete week");
    let (status, mixed_due) = request_json(&app, "GET", due_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{mixed_due}");
    assert_eq!(mixed_due["latestCompleteWeek"]["status"], "due");
    assert_eq!(mixed_due["latestCompleteWeek"]["eligibleArtifactCount"], 2);
}

#[tokio::test]
async fn browser_router_closes_memory_action_outcome_revision_and_rollback_loop() {
    let (_directory, database) = open_test_database().await;
    let app = build_router(AppState::new(database.clone()));

    let (status, message) = request_json(
        &app,
        "POST",
        "/v1/evidence/message",
        Some(json!({
            "clientRequestId": "message-1",
            "messageId": "chat-message-1",
            "content": "我发现上午通常是我高质量产出的主要时段。",
            "occurredAt": "2030-01-01T08:00:00.000Z",
            "sensitivity": "low",
            "audit": { "actor": "user", "sessionId": "session-1", "turnId": "turn-1", "authorizationMode": "automatic" }
        })),
        Some("idem-message-1"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{message}");
    let message_evidence_ref = message["value"]["evidenceRefId"]
        .as_str()
        .expect("message evidence ref")
        .to_string();

    let remember = json!({
        "operation": "remember",
        "clientRequestId": "remember-1",
        "label": "深度工作时段",
        "statement": "上午是高质量产出的主要时段",
        "kind": "claim",
        "payload": { "confidence": "medium" },
        "scope": { "domain": "work" },
        "sensitivity": "low",
        "evidenceRefs": [message_evidence_ref],
        "audit": {
            "actor": "model",
            "sessionId": "session-1",
            "turnId": "turn-1",
            "toolCallId": "tool-remember",
            "authorizationMode": "automatic"
        }
    });
    let (status, first) = request_json(
        &app,
        "POST",
        "/v1/changes",
        Some(remember.clone()),
        Some("idem-remember-1"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let claim_id = first["value"]["id"].as_str().expect("claim id").to_string();
    let remember_change_set = first["changeSetId"]
        .as_str()
        .expect("change set")
        .to_string();
    assert_eq!(first["value"]["origin"], "model");
    assert_eq!(first["value"]["authority"], "system_inferred");
    assert_eq!(first["value"]["kind"], "claim");
    assert_eq!(first["value"]["status"], "active");
    let support_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM edges WHERE to_node_id=? AND relation_type='supports' AND status='active'",
    )
    .bind(&claim_id)
    .fetch_one(database.pool())
    .await
    .expect("evidence support edge");
    assert_eq!(support_count, 1);

    let (status, duplicate) = request_json(
        &app,
        "POST",
        "/v1/changes",
        Some(remember),
        Some("idem-remember-1"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(duplicate["changeSetId"], remember_change_set);

    let (status, user_fact) = request_json(
        &app,
        "POST",
        "/v1/changes",
        Some(json!({
            "operation": "remember",
            "clientRequestId": "user-fact-1",
            "label": "用户直接陈述",
            "statement": "这是用户直接提交的事实",
            "kind": "claim",
            "payload": {},
            "scope": {},
            "sensitivity": "low",
            "audit": { "actor": "user", "sessionId": "session-1", "turnId": "turn-user", "authorizationMode": "automatic" }
        })),
        Some("idem-user-fact-1"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{user_fact}");
    assert_eq!(user_fact["value"]["origin"], "user");
    assert_eq!(user_fact["value"]["authority"], "user_stated");
    let user_fact_id = user_fact["value"]["id"].as_str().unwrap().to_string();
    let (status, user_update) = request_json(
        &app,
        "POST",
        "/v1/changes",
        Some(json!({
            "operation": "update",
            "clientRequestId": "user-update-1",
            "id": user_fact_id,
            "statement": "这是用户直接修订后的事实",
            "audit": { "actor": "user", "sessionId": "session-1", "turnId": "turn-user-update", "authorizationMode": "automatic" }
        })),
        Some("idem-user-update-1"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{user_update}");

    let (status, correction_message) = request_json(
        &app,
        "POST",
        "/v1/evidence/message",
        Some(json!({
            "clientRequestId": "message-correction-1",
            "content": "改成：这是用户直接修订后的事实。",
            "sensitivity": "low",
            "audit": { "actor": "user", "sessionId": "session-1", "turnId": "turn-user-update", "authorizationMode": "automatic" }
        })),
        Some("idem-message-correction-1"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{correction_message}");
    let (status, corrected) = request_json(
        &app,
        "POST",
        "/v1/star-map/apply-feedback",
        Some(json!({
            "clientRequestId": "feedback-correction-1",
            "feedbackType": "correct",
            "targetNodeId": user_fact_id,
            "evidenceRefs": [correction_message["value"]["evidenceRefId"]],
            "correctedStatement": "这是用户直接修订后的事实",
            "audit": { "actor": "model", "sessionId": "session-1", "turnId": "turn-user-update", "authorizationMode": "automatic" }
        })),
        Some("idem-feedback-correction-1"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{corrected}");
    assert_eq!(corrected["value"]["appliedNode"]["origin"], "user");
    assert_eq!(
        corrected["value"]["appliedNode"]["authority"],
        "user_corrected"
    );
    let fake_confirmed_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM nodes WHERE origin='model' AND authority='user_confirmed'",
    )
    .fetch_one(database.pool())
    .await
    .expect("authority invariant");
    assert_eq!(fake_confirmed_count, 0);

    let (status, action) = request_json(
        &app,
        "POST",
        "/v1/actions",
        Some(json!({
            "clientRequestId": "action-1",
            "label": "连续三天安排上午深度工作",
            "expectedOutcome": "三天内至少完成两个核心交付",
            "trigger": "工作日上午进入第一段无会议时间",
            "observationWindow": { "duration": "P3D", "sampleAt": "day_end" },
            "reviewAt": "2030-01-07T17:00:00.000Z",
            "payload": { "experiment": true },
            "scope": { "domain": "work" },
            "sensitivity": "low",
            "claimId": claim_id,
            "audit": { "actor": "model", "sessionId": "session-1", "turnId": "turn-2", "authorizationMode": "automatic" }
        })),
        Some("idem-action-1"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{action}");
    let action_id = action["value"]["action"]["id"]
        .as_str()
        .expect("action id")
        .to_string();
    assert_eq!(
        action["value"]["action"]["expectedOutcome"],
        "三天内至少完成两个核心交付"
    );
    assert_eq!(
        action["value"]["action"]["trigger"],
        "工作日上午进入第一段无会议时间"
    );

    let (status, outcome_message) = request_json(
        &app,
        "POST",
        "/v1/evidence/message",
        Some(json!({
            "clientRequestId": "message-outcome-1",
            "content": "完成了一个核心交付，注意力质量高但估算偏乐观。",
            "occurredAt": "2030-01-07T17:00:00.000Z",
            "sensitivity": "low",
            "audit": { "actor": "user", "sessionId": "session-1", "turnId": "turn-3", "authorizationMode": "automatic" }
        })),
        Some("idem-message-outcome-1"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{outcome_message}");

    let (status, outcome) = request_json(
        &app,
        "POST",
        "/v1/outcomes",
        Some(json!({
            "clientRequestId": "outcome-1",
            "actionId": action_id,
            "label": "实验结果",
            "outcome": "完成了一个核心交付，注意力质量高但估算偏乐观",
            "observedAt": "2030-01-07T17:00:00.000Z",
            "effect": "revises",
            "claimId": claim_id,
            "revisedStatement": "上午更适合深度工作，但单周产出估算需要保守",
            "evidenceRefs": [outcome_message["value"]["evidenceRefId"]],
            "payload": { "source": "weekly-checkin" },
            "audit": { "actor": "model", "sessionId": "session-1", "turnId": "turn-3", "toolCallId": "tool-outcome", "authorizationMode": "automatic" }
        })),
        Some("idem-outcome-1"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{outcome}");
    assert_eq!(outcome["value"]["outcome"]["authority"], "system_inferred");
    assert_eq!(outcome["value"]["outcome"]["origin"], "model");
    assert_eq!(outcome["value"]["revisionHook"]["status"], "applied");
    assert_eq!(
        outcome["value"]["revisionHook"]["appliedClaim"]["statement"],
        "上午更适合深度工作，但单周产出估算需要保守"
    );
    let (status, closed_due) = request_json(
        &app,
        "GET",
        "/v1/actions/due?at=2030-01-08T00%3A00%3A00.000Z",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{closed_due}");
    assert!(closed_due["items"].as_array().unwrap().is_empty());

    let outcome_change_set = outcome["changeSetId"]
        .as_str()
        .expect("outcome change set")
        .to_string();
    let (status, rollback) = request_json(
        &app,
        "POST",
        "/v1/changes",
        Some(json!({
            "operation": "rollback",
            "clientRequestId": "rollback-1",
            "changeSetId": outcome_change_set,
            "reason": "验收回滚",
            "audit": { "actor": "model", "sessionId": "session-1", "turnId": "turn-4", "authorizationMode": "preauthorized" }
        })),
        Some("idem-rollback-1"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{rollback}");
    let revision_queue_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM claim_revision_queue")
        .fetch_one(database.pool())
        .await
        .expect("revision queue after rollback");
    assert_eq!(
        revision_queue_count, 0,
        "rollback must not leave a ghost revision"
    );
    let (status, reopened_due) = request_json(
        &app,
        "GET",
        "/v1/actions/due?at=2030-01-08T00%3A00%3A00.000Z",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reopened_due}");
    assert_eq!(reopened_due["items"].as_array().unwrap().len(), 1);

    let (status, context) = request_json(
        &app,
        "POST",
        "/v1/context",
        Some(json!({ "query": "深度工作", "kinds": ["claim"], "limit": 20 })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{context}");
    assert_eq!(context["nodes"].as_array().expect("nodes").len(), 1);
    assert_eq!(
        context["nodes"][0]["statement"],
        "上午是高质量产出的主要时段"
    );
    let (status, changes) = request_json(&app, "GET", "/v1/changes?limit=100", None, None).await;
    assert_eq!(status, StatusCode::OK, "{changes}");
    let change_items = changes["items"].as_array().expect("change set items");
    assert!(!change_items.is_empty());
    assert!(change_items[0]["operations"].is_array());
    assert!(change_items.iter().any(|item| {
        item["id"] == first["changeSetId"] && item["operations"][0]["inverse"].is_object()
    }));

    let audit_row = sqlx::query(
        "SELECT actor_id, session_id, turn_id, tool_call_id, authorization_mode \
         FROM change_sets WHERE id=?",
    )
    .bind(remember_change_set)
    .fetch_one(database.pool())
    .await
    .expect("audit row");
    use sqlx::Row;
    assert_eq!(audit_row.get::<String, _>("actor_id"), "model");
    assert_eq!(audit_row.get::<String, _>("session_id"), "session-1");
    assert_eq!(audit_row.get::<String, _>("tool_call_id"), "tool-remember");
    let operation_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM change_operations WHERE change_set_id=? \
         AND after_json IS NOT NULL AND inverse_json IS NOT NULL",
    )
    .bind(first["changeSetId"].as_str().unwrap())
    .fetch_one(database.pool())
    .await
    .expect("change operation");
    assert!(
        operation_count >= 3,
        "evidence links and StarState are audited"
    );
}

#[tokio::test]
async fn semantic_star_map_is_evidence_backed_versioned_private_and_reversible() {
    let (_directory, database) = open_test_database().await;
    let app = build_router(AppState::new(database.clone()));

    let (status, unsupported) = request_json(
        &app,
        "POST",
        "/v1/changes",
        Some(json!({
            "operation": "remember",
            "clientRequestId": "unsupported-claim",
            "label": "unsupported inference",
            "statement": "A model-only inference cannot be canonical",
            "kind": "claim",
            "payload": {},
            "scope": {},
            "sensitivity": "low",
            "evidenceRefs": [],
            "audit": { "actor": "model", "authorizationMode": "automatic" }
        })),
        Some("idem-unsupported-claim"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{unsupported}");
    assert_eq!(unsupported["value"]["kind"], "observation");
    assert_eq!(unsupported["value"]["status"], "proposed");
    assert_eq!(
        unsupported["value"]["payload"]["evidenceStatus"],
        "unsupported"
    );
    let unsupported_id = unsupported["value"]["id"].as_str().unwrap();
    let (status, blocked_promotion) = request_json(
        &app,
        "POST",
        "/v1/changes",
        Some(json!({
            "operation": "update",
            "id": unsupported_id,
            "status": "active",
            "audit": { "actor": "model", "authorizationMode": "automatic" }
        })),
        Some("idem-unsupported-promotion"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{blocked_promotion}");

    let (center, _) = create_evidenced_claim(
        &app,
        "star-center",
        "Project Alpha is the current organizing focus",
        "low",
        json!({ "project": "alpha" }),
    )
    .await;
    let center_id = center["value"]["id"].as_str().unwrap().to_string();
    assert!(center["value"]["starState"].is_object());
    let event = capture_user_message(
        &app,
        "orbit-event",
        "Completed the Alpha discovery interview",
        "low",
    )
    .await;
    let event_id = event["value"]["nodeId"].as_str().unwrap().to_string();
    let event_ref = event["value"]["evidenceRefId"]
        .as_str()
        .unwrap()
        .to_string();

    let (status, located) = request_json(
        &app,
        "POST",
        "/v1/star-map/locate-event",
        Some(json!({
            "clientRequestId": "locate-alpha",
            "eventNodeId": event_id,
            "evidenceRefs": [event_ref],
            "projectContext": { "project": "alpha" },
            "queryPolicy": { "maxCandidates": 8, "allowSemanticOnly": true },
            "sensitivityCeiling": "low",
            "audit": { "actor": "model", "authorizationMode": "automatic" }
        })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{located}");
    assert_eq!(located["mutationPerformed"], false);
    assert!(located["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .any(|candidate| {
            candidate["starCenterNodeId"] == center_id
                && candidate["basis"] == "deterministic_context"
        }));
    let pre_orbit_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM edges WHERE from_node_id=? AND to_node_id=? AND relation_type='orbits'",
    )
    .bind(&event_id)
    .bind(&center_id)
    .fetch_one(database.pool())
    .await
    .unwrap();
    assert_eq!(
        pre_orbit_count, 0,
        "locate_event must remain a read projection"
    );

    let (status, applied) = request_json(
        &app,
        "POST",
        "/v1/star-map/apply-location",
        Some(json!({
            "clientRequestId": "apply-alpha-location",
            "eventNodeId": event_id,
            "starCenterNodeId": center_id,
            "relationType": "part_of",
            "evidenceRefs": [event_ref],
            "basis": "deterministic_context",
            "proximity": "near",
            "strength": "strong",
            "rationale": "The explicit project context matches the star scope",
            "audit": { "actor": "model", "authorizationMode": "automatic" }
        })),
        Some("idem-apply-alpha-location"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    assert_eq!(applied["value"]["orbitEdge"]["status"], "active");
    assert_eq!(applied["value"]["orbitEdge"]["relationType"], "orbits");
    let active_location_change = applied["changeSetId"].as_str().unwrap().to_string();

    let compile_body = json!({
        "clientRequestId": "compile-alpha",
        "seedNodeIds": [event_id],
        "needs": ["orbit"],
        "timeScope": {},
        "epistemicPolicy": { "canonicalOnly": true, "includeObservations": false },
        "sensitivityPolicy": { "ceiling": "low" },
        "budget": { "maxNodes": 20, "maxEdges": 40, "maxDepth": 3 },
        "audit": { "actor": "model", "authorizationMode": "automatic" }
    });
    let (status, compiled) = request_json(
        &app,
        "POST",
        "/v1/star-map/compile-context",
        Some(compile_body.clone()),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{compiled}");
    assert!(compiled["edges"]
        .as_array()
        .unwrap()
        .iter()
        .any(|edge| { edge["relationType"] == "orbits" && edge["status"] == "active" }));
    assert!(compiled["paths"].as_array().unwrap().iter().any(|path| {
        path["nodeId"] == center_id
            && path["pathEdgeIds"]
                .as_array()
                .is_some_and(|ids| !ids.is_empty())
    }));

    let (status, rolled_back) = request_json(
        &app,
        "POST",
        &format!("/v1/changes/{active_location_change}/rollback"),
        Some(json!({
            "clientRequestId": "rollback-alpha-location",
            "reason": "star location rollback acceptance",
            "audit": { "actor": "model", "authorizationMode": "preauthorized" }
        })),
        Some("idem-rollback-alpha-location"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{rolled_back}");
    let (status, after_rollback) = request_json(
        &app,
        "POST",
        "/v1/star-map/compile-context",
        Some(compile_body),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{after_rollback}");
    assert!(!after_rollback["edges"]
        .as_array()
        .unwrap()
        .iter()
        .any(|edge| edge["relationType"] == "orbits"));

    let (status, proposed_location) = request_json(
        &app,
        "POST",
        "/v1/star-map/apply-location",
        Some(json!({
            "clientRequestId": "apply-semantic-location",
            "eventNodeId": event_id,
            "starCenterNodeId": center_id,
            "relationType": "about",
            "evidenceRefs": [event_ref],
            "basis": "semantic_only",
            "rationale": "Text similarity is only a candidate",
            "audit": { "actor": "model", "authorizationMode": "automatic" }
        })),
        Some("idem-apply-semantic-location"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{proposed_location}");
    assert_eq!(
        proposed_location["value"]["orbitEdge"]["status"],
        "proposed"
    );

    let web_body = json!({
        "clientRequestId": "curator-web",
        "query": "Project Alpha evidence",
        "whyNow": "Ranked first for the low-sensitivity Project Alpha curation basis.",
        "url": "https://example.test/alpha",
        "title": "Alpha external evidence",
        "snippet": "Untrusted external evidence remains a resource.",
        "retrievedAt": "2030-01-01T00:00:00.000Z",
        "contentHash": "sha256:curator-web",
        "provider": "deepseek-official",
        "sensitivity": "low",
        "audit": { "actor": "model", "authorizationMode": "automatic" }
    });
    let (status, web) = request_json(
        &app,
        "POST",
        "/v1/evidence/web",
        Some(web_body),
        Some("idem-curator-web"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{web}");
    let resource_id = web["value"]["node"]["id"].as_str().unwrap().to_string();
    let web_evidence_ref = web["value"]["evidenceRefId"].as_str().unwrap().to_string();
    let (evidence_revision_claim, _) = create_evidenced_claim(
        &app,
        "web-revision",
        "Original claim before external evidence revision",
        "low",
        json!({}),
    )
    .await;
    let evidence_revision_claim_id = evidence_revision_claim["value"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (status, model_web_revision) = request_json(
        &app,
        "POST",
        "/v1/star-map/apply-feedback",
        Some(json!({
            "clientRequestId": "model-web-revision",
            "feedbackType": "correct",
            "targetNodeId": evidence_revision_claim_id,
            "evidenceRefs": [web_evidence_ref],
            "correctedStatement": "Versioned claim derived from external evidence",
            "audit": { "actor": "model", "authorizationMode": "automatic" }
        })),
        Some("idem-model-web-revision"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{model_web_revision}");
    assert_eq!(
        model_web_revision["value"]["appliedNode"]["authority"],
        "system_inferred"
    );
    assert_eq!(
        model_web_revision["value"]["appliedNode"]["origin"],
        "model"
    );
    assert_ne!(
        model_web_revision["value"]["appliedNode"]["id"],
        evidence_revision_claim_id
    );
    let superseded_status: String = sqlx::query_scalar("SELECT status FROM nodes WHERE id=?")
        .bind(&evidence_revision_claim_id)
        .fetch_one(database.pool())
        .await
        .unwrap();
    assert_eq!(superseded_status, "superseded");
    let (status, no_evidence_revision) = request_json(
        &app,
        "POST",
        "/v1/star-map/apply-feedback",
        Some(json!({
            "clientRequestId": "model-no-evidence-revision",
            "feedbackType": "confirm",
            "targetNodeId": model_web_revision["value"]["appliedNode"]["id"],
            "evidenceRefs": [],
            "audit": { "actor": "model", "authorizationMode": "automatic" }
        })),
        Some("idem-model-no-evidence-revision"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{no_evidence_revision}");
    let (status, invented_preference) = request_json(
        &app,
        "POST",
        "/v1/star-map/apply-feedback",
        Some(json!({
            "clientRequestId": "invented-curator-preference",
            "feedbackType": "confirm",
            "targetNodeId": resource_id,
            "evidenceRefs": [web["value"]["evidenceRefId"]],
            "audit": { "actor": "model", "authorizationMode": "automatic" }
        })),
        Some("idem-invented-curator-preference"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{invented_preference}");
    let feedback_message = capture_user_message(
        &app,
        "curator-feedback",
        "This item gives me a genuinely new angle.",
        "low",
    )
    .await;
    let (status, feedback) = request_json(
        &app,
        "POST",
        "/v1/star-map/apply-feedback",
        Some(json!({
            "clientRequestId": "curator-feedback",
            "feedbackType": "confirm",
            "targetNodeId": resource_id,
            "evidenceRefs": [feedback_message["value"]["evidenceRefId"]],
            "correctedScope": {
                "curatorFeedback": {
                    "feedback": "new-angle",
                    "item": "Alpha external evidence",
                    "url": "https://example.test/alpha",
                    "provider": "deepseek-official",
                    "contentHash": "sha256:curator-web",
                    "query": "Project Alpha evidence",
                    "reason": "novel framing"
                }
            },
            "audit": { "actor": "model", "authorizationMode": "automatic" }
        })),
        Some("idem-curator-feedback"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{feedback}");
    assert_eq!(feedback["value"]["curatorPreference"]["kind"], "interest");
    assert_eq!(
        feedback["value"]["curatorPreference"]["payload"]["preferenceType"],
        "curator_preference"
    );
    assert_eq!(
        feedback["value"]["curatorPreference"]["payload"]["signal"],
        "positive"
    );
    let stored_resource = sqlx::query("SELECT authority, origin, status FROM nodes WHERE id=?")
        .bind(&resource_id)
        .fetch_one(database.pool())
        .await
        .unwrap();
    use sqlx::Row;
    assert_eq!(
        stored_resource.get::<String, _>("authority"),
        "imported_unverified"
    );
    assert_ne!(stored_resource.get::<String, _>("origin"), "user");

    let (status, curator_context) = request_json(
        &app,
        "POST",
        "/v1/star-map/compile-context",
        Some(json!({
            "seedNodeIds": [resource_id],
            "needs": ["curator_preference"],
            "timeScope": {},
            "epistemicPolicy": { "canonicalOnly": true, "includeObservations": false },
            "sensitivityPolicy": { "ceiling": "low" },
            "budget": { "maxNodes": 20, "maxEdges": 40, "maxDepth": 2 }
        })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{curator_context}");
    assert!(curator_context["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|node| {
            node["kind"] == "interest" && node["payload"]["preferenceType"] == "curator_preference"
        }));

    let (status, secret_url) = request_json(
        &app,
        "POST",
        "/v1/evidence/web",
        Some(json!({
            "query": "must reject credentials",
            "whyNow": "This invalid URL fixture still carries a bounded ranking reason.",
            "url": "https://user:password@example.test/private",
            "title": "bad url",
            "snippet": "must not persist",
            "retrievedAt": "2030-01-01T00:00:00.000Z",
            "contentHash": "sha256:bad-url",
            "sensitivity": "low",
            "audit": { "actor": "model", "authorizationMode": "automatic" }
        })),
        Some("idem-secret-url"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{secret_url}");

    let (_high_claim, _) = create_evidenced_claim(
        &app,
        "high-secret",
        "This high sensitivity claim must not cross a low context boundary",
        "high",
        json!({}),
    )
    .await;
    let (status, low_context) = request_json(
        &app,
        "POST",
        "/v1/context",
        Some(json!({ "limit": 200, "sensitivityCeiling": "low" })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{low_context}");
    assert!(low_context["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .all(|node| node["sensitivity"] == "low"));
}

#[tokio::test]
async fn outcome_effect_matrix_revision_resolution_and_evidence_rollback_are_complete() {
    let (_directory, database) = open_test_database().await;
    let app = build_router(AppState::new(database.clone()));

    for (effect, expected_old_status, expected_new_status) in [
        ("confirms", "active", "active"),
        ("contracts", "superseded", "scoped"),
        ("revises", "superseded", "active"),
        ("refutes", "unsupported", "unsupported"),
    ] {
        let key = format!("matrix-{effect}");
        let (claim, _) = create_evidenced_claim(
            &app,
            &key,
            &format!("baseline claim for {effect}"),
            "low",
            json!({ "matrix": effect }),
        )
        .await;
        let claim_id = claim["value"]["id"].as_str().unwrap().to_string();
        let action =
            create_action_for_claim(&app, &key, &claim_id, "low", "2030-01-01T00:00:00.000Z").await;
        let action_id = action["value"]["action"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let revised_statement = matches!(effect, "contracts" | "revises")
            .then(|| format!("versioned {effect} statement"));
        let outcome = record_evidenced_outcome(
            &app,
            &key,
            &action_id,
            &claim_id,
            effect,
            revised_statement.as_deref(),
        )
        .await;
        assert_eq!(outcome["value"]["outcome"]["authority"], "system_inferred");
        assert_eq!(outcome["value"]["outcome"]["origin"], "model");
        assert_eq!(outcome["value"]["revisionHook"]["status"], "applied");
        assert_eq!(
            outcome["value"]["revisionHook"]["appliedClaim"]["status"],
            expected_new_status
        );
        let old_status: String = sqlx::query_scalar("SELECT status FROM nodes WHERE id=?")
            .bind(&claim_id)
            .fetch_one(database.pool())
            .await
            .unwrap();
        assert_eq!(old_status, expected_old_status, "effect={effect}");
        let applied_claim_id = outcome["value"]["revisionHook"]["effectiveClaimId"]
            .as_str()
            .unwrap();
        if matches!(effect, "contracts" | "revises") {
            assert_ne!(applied_claim_id, claim_id, "effect={effect} must version");
            assert_eq!(
                outcome["value"]["revisionHook"]["appliedClaim"]["statement"],
                revised_statement.unwrap()
            );
            let lineage: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM edges WHERE from_node_id=? AND to_node_id=? \
                 AND relation_type='supersedes' AND status='active'",
            )
            .bind(applied_claim_id)
            .bind(&claim_id)
            .fetch_one(database.pool())
            .await
            .unwrap();
            assert_eq!(lineage, 1, "effect={effect} lineage");
        } else {
            assert_eq!(applied_claim_id, claim_id);
        }
        if effect == "refutes" {
            let contradiction: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM edges WHERE to_node_id=? AND relation_type='contradicts' \
                 AND status='active'",
            )
            .bind(&claim_id)
            .fetch_one(database.pool())
            .await
            .unwrap();
            assert_eq!(contradiction, 1);
        }
        let outcome_id = outcome["value"]["outcome"]["id"].as_str().unwrap();
        let evidence_links: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM node_evidence_links WHERE node_id=? AND role='provenance'",
        )
        .bind(outcome_id)
        .fetch_one(database.pool())
        .await
        .unwrap();
        assert!(evidence_links >= 1, "effect={effect} outcome evidence");
        let evidenced_effect_edges: i64 = sqlx::query_scalar(
            "SELECT COUNT(DISTINCT e.id) FROM edges e JOIN edge_evidence_links l ON l.edge_id=e.id \
             WHERE e.from_node_id=? AND e.family='epistemic'",
        )
        .bind(outcome_id)
        .fetch_one(database.pool())
        .await
        .unwrap();
        assert!(
            evidenced_effect_edges >= 1,
            "effect={effect} effect provenance"
        );
    }

    let (missing_claim, _) = create_evidenced_claim(
        &app,
        "missing-statement",
        "claim requiring a contracted statement",
        "low",
        json!({}),
    )
    .await;
    let missing_claim_id = missing_claim["value"]["id"].as_str().unwrap();
    let missing_action = create_action_for_claim(
        &app,
        "missing-statement",
        missing_claim_id,
        "low",
        "2030-01-01T00:00:00.000Z",
    )
    .await;
    let missing_action_id = missing_action["value"]["action"]["id"].as_str().unwrap();
    let missing_evidence =
        capture_user_message(&app, "missing-outcome", "observed a contraction", "low").await;
    let (status, missing_statement) = request_json(
        &app,
        "POST",
        "/v1/outcomes",
        Some(json!({
            "actionId": missing_action_id,
            "outcome": "observed a contraction",
            "effect": "contracts",
            "claimId": missing_claim_id,
            "evidenceRefs": [missing_evidence["value"]["evidenceRefId"]],
            "audit": { "actor": "model", "authorizationMode": "automatic" }
        })),
        Some("idem-missing-revised-statement"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{missing_statement}");

    let (unknown_claim, _) = create_evidenced_claim(
        &app,
        "unknown",
        "claim awaiting an inconclusive outcome",
        "low",
        json!({}),
    )
    .await;
    let unknown_claim_id = unknown_claim["value"]["id"].as_str().unwrap().to_string();
    let unknown_action = create_action_for_claim(
        &app,
        "unknown",
        &unknown_claim_id,
        "low",
        "2030-01-01T00:00:00.000Z",
    )
    .await;
    let unknown_action_id = unknown_action["value"]["action"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let unknown = record_evidenced_outcome(
        &app,
        "unknown",
        &unknown_action_id,
        &unknown_claim_id,
        "unknown",
        None,
    )
    .await;
    assert_eq!(unknown["value"]["revisionHook"]["status"], "pending");
    assert!(unknown["value"]["revisionHook"]["appliedClaim"].is_null());
    let revision_id = unknown["value"]["revisionHook"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let unknown_change_set = unknown["changeSetId"].as_str().unwrap().to_string();

    let (status, pending) = request_json(
        &app,
        "GET",
        "/v1/revisions?status=pending&sensitivityCeiling=low&limit=100",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{pending}");
    assert!(pending["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|revision| revision["id"] == revision_id));

    let (status, dismissed) = request_json(
        &app,
        "POST",
        &format!("/v1/revisions/{revision_id}/resolve"),
        Some(json!({
            "clientRequestId": "dismiss-unknown",
            "resolution": "dismissed",
            "audit": { "actor": "user", "authorizationMode": "automatic" }
        })),
        Some("idem-dismiss-unknown"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{dismissed}");
    assert_eq!(dismissed["value"]["revision"]["status"], "dismissed");
    let dismiss_change_set = dismissed["changeSetId"].as_str().unwrap();
    let (status, dismiss_rollback) = request_json(
        &app,
        "POST",
        "/v1/changes",
        Some(json!({
            "operation": "rollback",
            "changeSetId": dismiss_change_set,
            "reason": "restore pending revision",
            "audit": { "actor": "model", "authorizationMode": "preauthorized" }
        })),
        Some("idem-dismiss-rollback"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{dismiss_rollback}");
    let queue_status: String =
        sqlx::query_scalar("SELECT status FROM claim_revision_queue WHERE id=?")
            .bind(&revision_id)
            .fetch_one(database.pool())
            .await
            .unwrap();
    assert_eq!(queue_status, "pending");

    let (status, resolved) = request_json(
        &app,
        "POST",
        &format!("/v1/revisions/{revision_id}/resolve"),
        Some(json!({
            "clientRequestId": "resolve-unknown",
            "resolution": "revises",
            "revisedStatement": "resolved version from an inconclusive outcome",
            "audit": { "actor": "user", "authorizationMode": "automatic" }
        })),
        Some("idem-resolve-unknown"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{resolved}");
    assert_eq!(resolved["value"]["revision"]["status"], "applied");
    assert_eq!(
        resolved["value"]["claimEffect"]["appliedClaim"]["statement"],
        "resolved version from an inconclusive outcome"
    );
    let resolved_claim_id = resolved["value"]["claimEffect"]["effectiveClaimId"]
        .as_str()
        .unwrap()
        .to_string();
    let resolve_change_set = resolved["changeSetId"].as_str().unwrap();
    let (status, resolve_rollback) = request_json(
        &app,
        "POST",
        "/v1/changes",
        Some(json!({
            "operation": "rollback",
            "changeSetId": resolve_change_set,
            "reason": "undo queue resolution",
            "audit": { "actor": "model", "authorizationMode": "preauthorized" }
        })),
        Some("idem-resolve-rollback"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{resolve_rollback}");
    let resolved_claim_status: String = sqlx::query_scalar("SELECT status FROM nodes WHERE id=?")
        .bind(&resolved_claim_id)
        .fetch_one(database.pool())
        .await
        .unwrap();
    assert_eq!(resolved_claim_status, "revoked");
    let original_claim_status: String = sqlx::query_scalar("SELECT status FROM nodes WHERE id=?")
        .bind(&unknown_claim_id)
        .fetch_one(database.pool())
        .await
        .unwrap();
    assert_eq!(original_claim_status, "active");

    let (status, outcome_rollback) = request_json(
        &app,
        "POST",
        "/v1/changes",
        Some(json!({
            "operation": "rollback",
            "changeSetId": unknown_change_set,
            "reason": "remove inconclusive outcome",
            "audit": { "actor": "model", "authorizationMode": "preauthorized" }
        })),
        Some("idem-unknown-outcome-rollback"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{outcome_rollback}");
    let ghost_queue: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM claim_revision_queue WHERE id=? OR outcome_node_id=?",
    )
    .bind(&revision_id)
    .bind(unknown["value"]["outcome"]["id"].as_str().unwrap())
    .fetch_one(database.pool())
    .await
    .unwrap();
    assert_eq!(
        ghost_queue, 0,
        "rollback must remove the unknown revision receipt"
    );

    let (inline_claim, _) = create_evidenced_claim(
        &app,
        "inline-user",
        "direct browser outcome claim",
        "low",
        json!({}),
    )
    .await;
    let inline_claim_id = inline_claim["value"]["id"].as_str().unwrap();
    let inline_action = create_action_for_claim(
        &app,
        "inline-user",
        inline_claim_id,
        "low",
        "2030-01-01T00:00:00.000Z",
    )
    .await;
    let (status, inline_outcome) = request_json(
        &app,
        "POST",
        "/v1/outcomes",
        Some(json!({
            "clientRequestId": "inline-user-outcome",
            "actionId": inline_action["value"]["action"]["id"],
            "outcome": "A browser user directly recorded this result",
            "effect": "confirms",
            "claimId": inline_claim_id,
            "evidenceRefs": [],
            "audit": { "actor": "user", "authorizationMode": "automatic" }
        })),
        Some("idem-inline-user-outcome"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{inline_outcome}");
    assert_eq!(
        inline_outcome["value"]["outcome"]["authority"],
        "user_stated"
    );
    let inline_source_type: String = sqlx::query_scalar(
        "SELECT s.source_type FROM node_evidence_links l \
         JOIN evidence_refs e ON e.id=l.evidence_ref_id \
         JOIN source_records s ON s.id=e.source_record_id \
         WHERE l.node_id=? AND l.role='provenance' LIMIT 1",
    )
    .bind(inline_outcome["value"]["outcome"]["id"].as_str().unwrap())
    .fetch_one(database.pool())
    .await
    .unwrap();
    assert_eq!(inline_source_type, "checkin");

    let (model_claim, _) = create_evidenced_claim(
        &app,
        "model-no-evidence",
        "model outcome must cite evidence",
        "low",
        json!({}),
    )
    .await;
    let model_claim_id = model_claim["value"]["id"].as_str().unwrap();
    let model_action = create_action_for_claim(
        &app,
        "model-no-evidence",
        model_claim_id,
        "low",
        "2030-01-01T00:00:00.000Z",
    )
    .await;
    let (status, model_without_evidence) = request_json(
        &app,
        "POST",
        "/v1/outcomes",
        Some(json!({
            "actionId": model_action["value"]["action"]["id"],
            "outcome": "model cannot claim this was observed",
            "effect": "unknown",
            "claimId": model_claim_id,
            "evidenceRefs": [],
            "audit": { "actor": "model", "authorizationMode": "automatic" }
        })),
        Some("idem-model-outcome-no-evidence"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{model_without_evidence}");
}

#[tokio::test]
async fn unattended_privacy_time_boundaries_and_structured_weekly_review_are_hard_filtered() {
    let (_directory, database) = open_test_database().await;
    let app = build_router(AppState::new(database.clone()));
    let fixture_start = Utc::now() - ChronoDuration::minutes(2);

    let (status, default_message) = request_json(
        &app,
        "POST",
        "/v1/evidence/message",
        Some(json!({
            "content": "Default local user content must remain private from unattended curation",
            "audit": { "actor": "user", "authorizationMode": "automatic" }
        })),
        Some("idem-default-medium-message"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{default_message}");
    assert_eq!(default_message["value"]["node"]["sensitivity"], "medium");

    let (status, direct_user_claim) = request_json(
        &app,
        "POST",
        "/v1/changes",
        Some(json!({
            "operation": "remember",
            "label": "direct user claim",
            "statement": "A user-authored claim does not confirm its computed importance",
            "kind": "claim",
            "payload": {},
            "scope": {},
            "audit": { "actor": "user", "authorizationMode": "automatic" }
        })),
        Some("idem-direct-user-claim"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{direct_user_claim}");
    assert_eq!(direct_user_claim["value"]["sensitivity"], "medium");
    assert_eq!(
        direct_user_claim["value"]["starState"]["importanceAuthority"],
        "system_inferred"
    );

    let due_instant = Utc::now() - ChronoDuration::minutes(1);
    let plus_fourteen = FixedOffset::east_opt(14 * 60 * 60).unwrap();
    let offset_review_at = due_instant
        .with_timezone(&plus_fourteen)
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    let (low_due_claim, _) = create_evidenced_claim(
        &app,
        "weekly-low-due",
        "low due action claim",
        "low",
        json!({}),
    )
    .await;
    let low_due_claim_id = low_due_claim["value"]["id"].as_str().unwrap();
    let low_due_action = create_action_for_claim(
        &app,
        "weekly-low-due",
        low_due_claim_id,
        "low",
        &offset_review_at,
    )
    .await;
    let low_due_action_id = low_due_action["value"]["action"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    for sensitivity in ["medium", "high"] {
        let key = format!("weekly-{sensitivity}-due");
        let (claim, _) = create_evidenced_claim(
            &app,
            &key,
            &format!("{sensitivity} due action claim"),
            sensitivity,
            json!({}),
        )
        .await;
        create_action_for_claim(
            &app,
            &key,
            claim["value"]["id"].as_str().unwrap(),
            sensitivity,
            &offset_review_at,
        )
        .await;
    }
    // Query time is part of the bitemporal contract: an action cannot be due
    // before it exists, even when its calendar reviewAt is already in the past.
    let due_query_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let due_query_uri = format!(
        "/v1/actions/due?at={}&limit=100&sensitivityCeiling=low",
        due_query_at.replace(':', "%3A").replace('+', "%2B")
    );
    let (status, low_due) = request_json(&app, "GET", &due_query_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{low_due}");
    assert!(low_due["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|action| action["id"] == low_due_action_id));
    assert!(low_due["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|action| action["sensitivity"] == "low"));

    let before_due =
        (due_instant - ChronoDuration::seconds(1)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let before_due_uri = format!(
        "/v1/actions/due?at={}&limit=100&sensitivityCeiling=low",
        before_due.replace(':', "%3A").replace('+', "%2B")
    );
    let (status, not_yet_due) = request_json(&app, "GET", &before_due_uri, None, None).await;
    assert_eq!(status, StatusCode::OK, "{not_yet_due}");
    assert!(!not_yet_due["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|action| action["id"] == low_due_action_id));

    let (changed_claim, _) = create_evidenced_claim(
        &app,
        "weekly-changed",
        "claim confirmed during the weekly period",
        "low",
        json!({}),
    )
    .await;
    let changed_claim_id = changed_claim["value"]["id"].as_str().unwrap();
    let changed_action = create_action_for_claim(
        &app,
        "weekly-changed",
        changed_claim_id,
        "low",
        &offset_review_at,
    )
    .await;
    let changed_outcome = record_evidenced_outcome(
        &app,
        "weekly-changed",
        changed_action["value"]["action"]["id"].as_str().unwrap(),
        changed_claim_id,
        "confirms",
        None,
    )
    .await;

    let (refuted_claim, _) = create_evidenced_claim(
        &app,
        "weekly-refuted",
        "claim refuted during the weekly period",
        "low",
        json!({}),
    )
    .await;
    let refuted_claim_id = refuted_claim["value"]["id"].as_str().unwrap();
    let refuted_action = create_action_for_claim(
        &app,
        "weekly-refuted",
        refuted_claim_id,
        "low",
        &offset_review_at,
    )
    .await;
    record_evidenced_outcome(
        &app,
        "weekly-refuted",
        refuted_action["value"]["action"]["id"].as_str().unwrap(),
        refuted_claim_id,
        "refutes",
        None,
    )
    .await;

    let (pending_low_claim, _) = create_evidenced_claim(
        &app,
        "weekly-pending-low",
        "low pending revision",
        "low",
        json!({}),
    )
    .await;
    let pending_low_claim_id = pending_low_claim["value"]["id"].as_str().unwrap();
    let pending_low_action = create_action_for_claim(
        &app,
        "weekly-pending-low",
        pending_low_claim_id,
        "low",
        &offset_review_at,
    )
    .await;
    let pending_low = record_evidenced_outcome(
        &app,
        "weekly-pending-low",
        pending_low_action["value"]["action"]["id"]
            .as_str()
            .unwrap(),
        pending_low_claim_id,
        "unknown",
        None,
    )
    .await;
    let pending_low_id = pending_low["value"]["revisionHook"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let (pending_high_claim, _) = create_evidenced_claim(
        &app,
        "weekly-pending-high",
        "high pending revision",
        "high",
        json!({}),
    )
    .await;
    let pending_high_claim_id = pending_high_claim["value"]["id"].as_str().unwrap();
    let pending_high_action = create_action_for_claim(
        &app,
        "weekly-pending-high",
        pending_high_claim_id,
        "high",
        &offset_review_at,
    )
    .await;
    record_evidenced_outcome(
        &app,
        "weekly-pending-high",
        pending_high_action["value"]["action"]["id"]
            .as_str()
            .unwrap(),
        pending_high_claim_id,
        "unknown",
        None,
    )
    .await;

    let (status, low_revisions) = request_json(
        &app,
        "GET",
        "/v1/revisions?status=pending&limit=100&sensitivityCeiling=low",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{low_revisions}");
    assert_eq!(low_revisions["items"].as_array().unwrap().len(), 1);
    assert_eq!(low_revisions["items"][0]["id"], pending_low_id);

    let fixture_end = Utc::now() + ChronoDuration::minutes(2);
    let (status, review) = request_json(
        &app,
        "POST",
        "/v1/reviews",
        Some(json!({
            "clientRequestId": "weekly-structured-low",
            "periodStart": fixture_start.to_rfc3339_opts(SecondsFormat::Millis, true),
            "periodEnd": fixture_end.to_rfc3339_opts(SecondsFormat::Millis, true),
            "sensitivityCeiling": "low",
            "audit": { "actor": "system", "authorizationMode": "automatic" }
        })),
        Some("idem-weekly-structured-low"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{review}");
    assert!(review["value"]["sections"]["singleLoop"]["dueActions"].is_array());
    assert!(review["value"]["sections"]["singleLoop"]["outcomes"].is_array());
    assert!(review["value"]["sections"]["singleLoop"]["actionsWithoutEvidence"].is_array());
    assert!(review["value"]["sections"]["doubleLoop"]["changedClaims"].is_array());
    assert!(review["value"]["sections"]["doubleLoop"]["contradictions"].is_array());
    assert!(review["value"]["sections"]["doubleLoop"]["pendingRevisions"].is_array());
    assert!(review["value"]["changedClaims"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["claim"]["id"] == changed_claim_id));
    assert!(!review["value"]["contradictions"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(review["value"]["actionsWithoutEvidence"]
        .as_array()
        .unwrap()
        .iter()
        .any(|action| action["id"] == low_due_action_id));
    assert_eq!(
        review["value"]["pendingRevisions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(review["value"]["pendingRevisions"][0]["id"], pending_low_id);
    assert!(!review["value"]["traceEdges"].as_array().unwrap().is_empty());
    assert!(review["value"]["traceEdges"]
        .as_array()
        .unwrap()
        .iter()
        .all(|edge| edge["relationType"] == "derived_from" && edge["status"] == "active"));
    assert!(review["value"]["outcomes"]
        .as_array()
        .unwrap()
        .iter()
        .all(|outcome| outcome["sensitivity"] == "low"));

    let review_node_id = review["value"]["node"]["id"].as_str().unwrap();
    let inherited_refs: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM node_evidence_links WHERE node_id=? AND role='support'",
    )
    .bind(review_node_id)
    .fetch_one(database.pool())
    .await
    .unwrap();
    assert!(inherited_refs >= 1);
    let (status, compiled_review) = request_json(
        &app,
        "POST",
        "/v1/star-map/compile-context",
        Some(json!({
            "seedNodeIds": [review_node_id],
            "needs": ["weekly_trace"],
            "timeScope": {},
            "epistemicPolicy": { "canonicalOnly": true, "includeObservations": false },
            "sensitivityPolicy": { "ceiling": "low" },
            "budget": { "maxNodes": 100, "maxEdges": 200, "maxDepth": 2 }
        })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{compiled_review}");
    assert!(compiled_review["edges"]
        .as_array()
        .unwrap()
        .iter()
        .any(|edge| edge["relationType"] == "derived_from"));
    assert!(compiled_review["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|node| {
            node["id"] == changed_outcome["value"]["outcome"]["id"]
                || node["id"] == low_due_action_id
        }));

    let review_change_set = review["changeSetId"].as_str().unwrap();
    let (status, review_rollback) = request_json(
        &app,
        "POST",
        "/v1/changes",
        Some(json!({
            "operation": "rollback",
            "changeSetId": review_change_set,
            "reason": "weekly trace rollback acceptance",
            "audit": { "actor": "model", "authorizationMode": "preauthorized" }
        })),
        Some("idem-weekly-trace-rollback"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{review_rollback}");
    let active_trace_edges: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM edges WHERE from_node_id=? AND relation_type='derived_from' \
         AND status IN ('active','disputed')",
    )
    .bind(review_node_id)
    .fetch_one(database.pool())
    .await
    .unwrap();
    assert_eq!(active_trace_edges, 0);
    let weekly_row: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM weekly_reviews WHERE node_id=?")
        .bind(review_node_id)
        .fetch_one(database.pool())
        .await
        .unwrap();
    assert_eq!(weekly_row, 0);
}

#[tokio::test]
async fn web_provenance_weekly_review_export_restore_and_two_stage_delete_are_verifiable() {
    let (_directory, database) = open_test_database().await;
    let app = build_router(AppState::new(database.clone()));

    let web_request = json!({
        "clientRequestId": "web-1",
        "query": "认知修订 间隔回顾",
        "whyNow": "当时因低敏回顾策展依据匹配而排在第一位。",
        "url": "https://example.test/review",
        "title": "Evidence-based review",
        "snippet": "External content is evidence, not instructions.",
        "publishedAt": "2029-12-01T00:00:00.000Z",
        "retrievedAt": "2030-01-01T00:00:00.000Z",
        "contentHash": "sha256:test-content",
        "sensitivity": "low",
        "audit": { "actor": "model", "sessionId": "web-session", "turnId": "web-turn", "authorizationMode": "automatic" }
    });
    let (status, web) = request_json(
        &app,
        "POST",
        "/v1/evidence/web",
        Some(web_request.clone()),
        Some("idem-web-1"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{web}");
    assert_eq!(web["value"]["trust"]["promptAuthority"], "none");
    assert_eq!(web["value"]["node"]["authority"], "imported_unverified");
    assert_eq!(
        web["value"]["node"]["payload"]["whyNow"],
        "当时因低敏回顾策展依据匹配而排在第一位。"
    );
    let original_web_node_id = web["value"]["node"]["id"]
        .as_str()
        .expect("web resource id")
        .to_string();
    let (source_type, source_metadata_json): (String, String) =
        sqlx::query_as("SELECT source_type, metadata_json FROM source_records WHERE id=?")
            .bind(web["value"]["sourceRecordId"].as_str().unwrap())
            .fetch_one(database.pool())
            .await
            .expect("web source");
    assert_eq!(source_type, "web_search");
    let source_metadata: Value =
        serde_json::from_str(&source_metadata_json).expect("web source metadata json");
    assert_eq!(
        source_metadata["whyNow"],
        "当时因低敏回顾策展依据匹配而排在第一位。"
    );
    assert_eq!(source_metadata["promptAuthority"], "none");

    let mut later_ranking = web_request.clone();
    later_ranking["clientRequestId"] = Value::String("web-1-later-ranking".into());
    later_ranking["whyNow"] = Value::String("后来偏好变化后的另一条排序理由。".into());
    let (status, later_web) = request_json(
        &app,
        "POST",
        "/v1/evidence/web",
        Some(later_ranking),
        Some("idem-web-1-later-ranking"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{later_web}");
    assert_ne!(later_web["value"]["node"]["id"], original_web_node_id);
    let original_payload_json: String =
        sqlx::query_scalar("SELECT payload_json FROM nodes WHERE id=?")
            .bind(&original_web_node_id)
            .fetch_one(database.pool())
            .await
            .expect("original web payload after later ranking");
    let original_payload: Value =
        serde_json::from_str(&original_payload_json).expect("original web payload json");
    assert_eq!(
        original_payload["whyNow"],
        "当时因低敏回顾策展依据匹配而排在第一位。"
    );

    for (key, why_now) in [
        ("idem-web-empty-why", "   ".to_string()),
        ("idem-web-long-why", "理".repeat(501)),
    ] {
        let mut invalid = web_request.clone();
        invalid["clientRequestId"] = Value::String(key.into());
        invalid["whyNow"] = Value::String(why_now);
        let (status, rejected) =
            request_json(&app, "POST", "/v1/evidence/web", Some(invalid), Some(key)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{rejected}");
    }

    let (review_claim, _) = create_evidenced_claim(
        &app,
        "export-review-eligible",
        "an open action makes the completed week review-eligible",
        "low",
        json!({}),
    )
    .await;
    create_action_for_claim(
        &app,
        "export-review-eligible",
        review_claim["value"]["id"].as_str().unwrap(),
        "low",
        "2030-01-01T12:00:00.000Z",
    )
    .await;

    let (status, due_review) = request_json(
        &app,
        "GET",
        "/v1/reviews?status=due&dueBefore=2030-01-08T00%3A00%3A00.000Z",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{due_review}");
    assert_eq!(due_review["items"].as_array().unwrap().len(), 1);
    let receipt_key = due_review["items"][0]["receiptKey"]
        .as_str()
        .unwrap()
        .to_string();
    let review_period_start = due_review["items"][0]["periodStart"]
        .as_str()
        .unwrap()
        .to_string();
    let review_period_end = due_review["items"][0]["periodEnd"]
        .as_str()
        .unwrap()
        .to_string();

    let (status, review) = request_json(
        &app,
        "POST",
        "/v1/reviews",
        Some(json!({
            "clientRequestId": "review-1",
            "periodStart": review_period_start,
            "periodEnd": review_period_end,
            "audit": { "actor": "model", "sessionId": "review-session", "turnId": "review-turn", "authorizationMode": "automatic" }
        })),
        Some("idem-review-1"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{review}");
    assert_eq!(review["value"]["node"]["label"], "真实周回顾");
    assert_eq!(review["value"]["review"]["receiptKey"], receipt_key);
    let (status, no_longer_due) = request_json(
        &app,
        "GET",
        "/v1/reviews?status=due&dueBefore=2030-01-08T00%3A00%3A00.000Z",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{no_longer_due}");
    assert!(no_longer_due["items"].as_array().unwrap().is_empty());

    let (status, integrity) = request_json(&app, "GET", "/v1/admin/integrity", None, None).await;
    assert_eq!(status, StatusCode::OK, "{integrity}");
    assert_eq!(integrity["ok"], true);
    let (status, snapshot) = request_json(&app, "GET", "/v1/admin/export", None, None).await;
    assert_eq!(status, StatusCode::OK, "{snapshot}");
    assert!(snapshot["checksum"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));
    assert!(snapshot["data"]["idempotencyLedger"]
        .as_array()
        .is_some_and(|rows| rows.len() >= 2));
    let original_checksum = snapshot["checksum"].as_str().unwrap().to_string();

    let (status, prepared_delete) = request_json(
        &app,
        "POST",
        "/v1/admin/dangerous/prepare",
        Some(json!({ "operation": "delete_all" })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{prepared_delete}");
    let delete_token = prepared_delete["token"].as_str().unwrap();
    let (status, deleted) = request_json(
        &app,
        "POST",
        "/v1/admin/dangerous/commit",
        Some(json!({
            "token": delete_token,
            "confirmation": "DELETE ALL LOCAL DATA"
        })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{deleted}");
    let active_nodes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM nodes")
        .fetch_one(database.pool())
        .await
        .expect("node count");
    assert_eq!(active_nodes, 0);
    let (status, reset_snapshot) = request_json(&app, "GET", "/v1/admin/export", None, None).await;
    assert_eq!(status, StatusCode::OK, "{reset_snapshot}");
    assert_eq!(
        reset_snapshot["data"]["dataResetLog"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let (status, prepared_restore) = request_json(
        &app,
        "POST",
        "/v1/admin/dangerous/prepare",
        Some(json!({ "operation": "restore", "snapshot": snapshot.clone() })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{prepared_restore}");
    let restore_token = prepared_restore["token"].as_str().unwrap();
    let (status, restored) = request_json(
        &app,
        "POST",
        "/v1/admin/dangerous/commit",
        Some(json!({
            "token": restore_token,
            "confirmation": "RESTORE LOCAL DATA"
        })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    let restored_nodes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM nodes")
        .fetch_one(database.pool())
        .await
        .expect("restored node count");
    assert!(restored_nodes >= 2);
    let restored_integrity = database.integrity().await.expect("restored integrity");
    assert_eq!(restored_integrity["ok"], true, "{restored_integrity}");
    let reexported = database
        .export_document()
        .await
        .expect("re-export after restore");
    assert_eq!(reexported.checksum, original_checksum);
    let (status, replayed) = request_json(
        &app,
        "POST",
        "/v1/evidence/web",
        Some(web_request.clone()),
        Some("idem-web-1"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{replayed}");
    assert_eq!(replayed["changeSetId"], web["changeSetId"]);
    let mut conflicting_web_request = web_request;
    conflicting_web_request["query"] = Value::String("different request body".into());
    let (status, conflict) = request_json(
        &app,
        "POST",
        "/v1/evidence/web",
        Some(conflicting_web_request),
        Some("idem-web-1"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{conflict}");
}

#[tokio::test]
async fn permanent_purge_removes_domain_audit_sidecars_and_owned_backups_without_recovery_copy() {
    let (directory, database) = open_test_database().await;
    let backup_dir = directory.path().join("backups");
    let db_path = database.path().to_path_buf();
    let app = build_router(AppState::new(database.clone()));

    let (status, remembered) = request_json(
        &app,
        "POST",
        "/v1/changes",
        Some(json!({
            "operation": "remember",
            "label": "需要永久清除的内容",
            "statement": "purge integration fixture",
            "kind": "claim",
            "payload": {},
            "scope": {},
            "sensitivity": "high",
            "audit": { "actor": "model", "sessionId": "purge-session", "turnId": "purge-turn", "authorizationMode": "automatic" }
        })),
        Some("purge-fixture-write"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{remembered}");
    let old_export = database.export_document().await.expect("pre-purge export");
    assert!(!old_export.data["nodes"].as_array().unwrap().is_empty());
    let old_backup = database
        .create_backup("purge-integration")
        .await
        .expect("owned pre-purge backup");
    assert!(old_backup.exists());

    let (status, prepared) = request_json(
        &app,
        "POST",
        "/v1/admin/dangerous/prepare",
        Some(json!({ "operation": "purge_all" })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{prepared}");
    assert_eq!(
        prepared["requiredConfirmation"],
        "PERMANENTLY DELETE ALL LATITUDE DATA"
    );
    let token = prepared["token"].as_str().unwrap();
    let (wrong_status, wrong_confirmation) = request_json(
        &app,
        "POST",
        "/v1/admin/dangerous/commit",
        Some(json!({
            "token": token,
            "confirmation": "DELETE ALL LOCAL DATA"
        })),
        None,
    )
    .await;
    assert_eq!(wrong_status, StatusCode::PRECONDITION_REQUIRED);
    assert_eq!(wrong_confirmation["error"]["code"], "confirmation_required");
    let (status, purged) = request_json(
        &app,
        "POST",
        "/v1/admin/dangerous/commit",
        Some(json!({
            "token": token,
            "confirmation": "PERMANENTLY DELETE ALL LATITUDE DATA"
        })),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{purged}");
    assert_eq!(purged["status"], "complete", "{purged}");
    assert_eq!(purged["recoverable"], false);
    assert_eq!(purged["persistentAudit"], false);
    assert_eq!(purged["remainingCounts"]["nodes"], 0);
    assert_eq!(purged["remainingCounts"]["changeSets"], 0);
    assert_eq!(purged["remainingCounts"]["idempotencyRows"], 0);
    assert!(
        !old_backup.exists(),
        "old recoverable backup must be removed"
    );
    let backup_entries = std::fs::read_dir(&backup_dir)
        .expect("backup directory")
        .collect::<Result<Vec<_>, _>>()
        .expect("backup entries");
    assert!(
        backup_entries.is_empty(),
        "backup directory must be empty after purge"
    );
    assert!(!PathBuf::from(format!("{}-wal", db_path.display())).exists());
    assert!(!PathBuf::from(format!("{}-shm", db_path.display())).exists());

    database.close().await;
    let (reopened, _) = Database::open(&db_path, &backup_dir)
        .await
        .expect("reopen purged database");
    let context = reopened
        .context(serde_json::from_value(json!({ "limit": 100 })).unwrap())
        .await
        .expect("empty reopened context");
    assert!(context["nodes"].as_array().unwrap().is_empty());
    assert!(reopened.list_changes(100).await.unwrap()["items"]
        .as_array()
        .unwrap()
        .is_empty());
    let reexported = reopened.export_document().await.expect("empty re-export");
    assert!(reexported.data["nodes"].as_array().unwrap().is_empty());
    assert_ne!(reexported.checksum, old_export.checksum);
    reopened.close().await;
}

#[tokio::test]
async fn permanent_purge_refuses_unknown_and_symlink_backup_entries_and_reports_partial() {
    let (directory, database) = open_test_database().await;
    let backup_dir = directory.path().join("backups");
    let known_backup = database
        .create_backup("purge-safety")
        .await
        .expect("known backup");
    let unknown = backup_dir.join("personal-notes.txt");
    std::fs::write(&unknown, b"must survive purge").expect("unknown fixture");
    let outside = directory.path().join("outside-sentinel.txt");
    std::fs::write(&outside, b"outside must survive").expect("outside fixture");

    #[cfg(unix)]
    let matching_symlink = {
        use std::os::unix::fs::symlink;
        let name = format!(
            "{}.20990101T000000.000Z.malicious.bak",
            database.path().file_name().unwrap().to_string_lossy()
        );
        let link = backup_dir.join(name);
        symlink(&outside, &link).expect("matching symlink fixture");
        Some(link)
    };
    #[cfg(not(unix))]
    let matching_symlink: Option<PathBuf> = None;

    let result = database.purge_all().await.expect("partial safe purge");
    assert_eq!(result["status"], "partial", "{result}");
    assert_eq!(result["ok"], true, "domain data itself is purged");
    assert!(!known_backup.exists(), "known owned backup is deleted");
    assert!(unknown.exists(), "unknown file is preserved");
    assert!(outside.exists(), "symlink target is preserved");
    if let Some(link) = matching_symlink {
        assert!(link.symlink_metadata().is_ok(), "symlink itself is refused");
    }
    assert!(result["backupCleanup"]["refused"]
        .as_array()
        .is_some_and(|items| !items.is_empty()));
    database.close().await;
}

#[tokio::test]
async fn restore_prepare_accepts_large_profile_while_ordinary_writes_keep_two_mib_limit() {
    let (_directory, database) = open_test_database().await;
    let app = build_router(AppState::new(database.clone()));
    let padding = "x".repeat(3 * 1024 * 1024);
    let snapshot_data = json!({ "largeProfileFixture": padding });
    let checksum = format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&snapshot_data).expect("snapshot bytes"))
    );
    let prepare_body = json!({
        "operation": "restore",
        "snapshot": {
            "format": "latitude.constellation.export@0.1",
            "schemaVersion": "2",
            "exportedAt": "2030-01-01T00:00:00.000Z",
            "checksum": checksum,
            "data": snapshot_data
        }
    });
    let encoded_prepare_size = serde_json::to_vec(&prepare_body).unwrap().len();
    assert!(encoded_prepare_size > 2 * 1024 * 1024);
    assert!(encoded_prepare_size < 64 * 1024 * 1024);
    let (prepare_status, prepared) = request_json(
        &app,
        "POST",
        "/v1/admin/dangerous/prepare",
        Some(prepare_body),
        None,
    )
    .await;
    assert_eq!(prepare_status, StatusCode::ACCEPTED, "{prepared}");
    assert_eq!(prepared["operation"], "restore");

    let oversized_write = json!({
        "operation": "remember",
        "label": "oversized ordinary write",
        "statement": "must be rejected by the ordinary route limit",
        "kind": "claim",
        "payload": { "blob": "y".repeat(3 * 1024 * 1024) },
        "scope": {},
        "sensitivity": "low",
        "audit": { "actor": "model", "authorizationMode": "automatic" }
    });
    assert!(serde_json::to_vec(&oversized_write).unwrap().len() > 2 * 1024 * 1024);
    let (write_status, _) = request_json(
        &app,
        "POST",
        "/v1/changes",
        Some(oversized_write),
        Some("oversized-ordinary-write"),
    )
    .await;
    assert_eq!(write_status, StatusCode::PAYLOAD_TOO_LARGE);

    let export = database.export_document().await.expect("export checksum");
    let digest = export
        .checksum
        .strip_prefix("sha256:")
        .expect("sha256 prefix");
    assert_eq!(digest.len(), 64);
    assert!(digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
    database.close().await;
}
