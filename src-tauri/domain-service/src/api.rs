use crate::{
    db::{Database, IdempotencyContext},
    error::{AppError, AppResult},
    models::{
        ActionRequest, ApplyFeedbackRequest, ApplyLocationRequest, AuditContext,
        CandidateCommandRequest, CandidateCreateRequest, ChangeRequest, CommitDangerousRequest,
        CompileContextRequest, ComputerHistoryEvidenceRequest, ContextRequest,
        EvidenceQueryRequest, EvidenceReadRequest, ExportDocument, LocateEventRequest,
        MessageEvidenceRequest, OutcomeRequest, PrepareDangerousRequest, RelationshipRequest,
        ResolveRevisionRequest, RollbackRequest, WebEvidenceRequest, WeeklyReviewRequest,
    },
};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    routing::{get, post},
    Json, Router,
};
use chrono::{Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::Mutex;
use tower_http::{cors::CorsLayer, limit::RequestBodyLimitLayer, trace::TraceLayer};
use uuid::Uuid;

#[derive(Clone)]
pub struct AppState {
    pub database: Database,
    dangerous_operations: Arc<Mutex<HashMap<String, PendingDangerousOperation>>>,
}

#[derive(Clone)]
struct PendingDangerousOperation {
    operation: String,
    snapshot: Option<ExportDocument>,
    confirmation: String,
    expires_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LimitQuery {
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DueActionsQuery {
    at: Option<String>,
    limit: Option<u32>,
    sensitivity_ceiling: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DueCandidatesQuery {
    at: Option<String>,
    limit: Option<u32>,
    sensitivity_ceiling: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewsQuery {
    due_before: Option<String>,
    status: Option<String>,
    limit: Option<u32>,
    sensitivity_ceiling: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevisionsQuery {
    status: Option<String>,
    limit: Option<u32>,
    sensitivity_ceiling: Option<String>,
}

impl AppState {
    pub fn new(database: Database) -> Self {
        Self {
            database,
            dangerous_operations: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

pub fn build_router(state: AppState) -> Router {
    build_router_for_web_port(state, 1420)
}

/// Build the loopback API for the Browser port selected by the local launcher.
/// The caller validates the port; only the two loopback host spellings are
/// admitted, so changing the development port never broadens CORS to a LAN or
/// arbitrary origin.
pub fn build_router_for_web_port(state: AppState, web_port: u16) -> Router {
    build_router_for_origins(state, web_port, None)
}

pub fn build_router_for_origins(
    state: AppState,
    web_port: u16,
    public_web_origin: Option<HeaderValue>,
) -> Router {
    assert!(web_port > 0, "web port must be non-zero");
    let mut allowed_origins = vec![
        format!("http://127.0.0.1:{web_port}")
            .parse::<HeaderValue>()
            .expect("valid origin"),
        format!("http://localhost:{web_port}")
            .parse::<HeaderValue>()
            .expect("valid origin"),
    ];
    if let Some(origin) = public_web_origin {
        allowed_origins.push(origin);
    }
    let cors = CorsLayer::new()
        .allow_origin(allowed_origins)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            header::CONTENT_TYPE,
            HeaderName::from_static("idempotency-key"),
        ]);

    let regular_routes = Router::new()
        .route("/health", get(health))
        .route(
            "/v1/history/settings",
            get(history_settings).post(history_configure),
        )
        .route("/v1/history/heartbeat", post(history_heartbeat))
        .route("/v1/history/ingest", post(history_ingest))
        .route("/v1/history/query", post(history_query))
        .route("/v1/history/summary", post(history_summary))
        .route("/v1/history/memory", post(history_memory))
        .route("/v1/history/suggestion", post(history_suggestion))
        .route("/v1/history/workflow", post(history_workflow))
        .route("/v1/history/diagnostics", get(history_diagnostics))
        .route("/v1/history/clear", post(history_clear))
        .route("/v1/history/expire", post(history_expire))
        .route("/v1/context", post(context))
        .route("/v1/changes", get(list_changes).post(changes))
        .route("/v1/changes/{change_set_id}/rollback", post(rollback_alias))
        .route("/v1/actions", post(actions))
        .route("/v1/actions/due", get(due_actions))
        .route("/v1/candidates", post(candidates))
        .route("/v1/candidates/due", get(due_candidates))
        .route(
            "/v1/candidates/{candidate_id}/commands",
            post(candidate_commands),
        )
        .route("/v1/outcomes", post(outcomes))
        .route("/v1/reviews", get(list_reviews).post(reviews))
        .route("/v1/evidence/query", post(evidence_query))
        .route("/v1/evidence/read", post(evidence_read))
        .route("/v1/evidence/web", post(web_evidence))
        .route("/v1/evidence/message", post(message_evidence))
        .route("/v1/star-map/locate-event", post(locate_event))
        .route("/v1/star-map/apply-location", post(apply_location))
        .route("/v1/relationships", post(relationships))
        .route("/v1/star-map/compile-context", post(compile_context))
        .route("/v1/star-map/apply-feedback", post(apply_feedback))
        .route("/v1/revisions", get(list_revisions))
        .route(
            "/v1/revisions/{revision_id}/resolve",
            post(resolve_revision),
        )
        .route("/v1/admin/export", get(export))
        .route("/v1/admin/integrity", get(integrity))
        .route("/v1/admin/dangerous/commit", post(commit_dangerous))
        .layer(DefaultBodyLimit::disable())
        .layer(RequestBodyLimitLayer::new(2 * 1024 * 1024));

    // A full profile restore can be much larger than a normal domain command. Keep the
    // exception route-specific so no ordinary write silently inherits the expanded limit.
    let restore_prepare_route = Router::new()
        .route("/v1/admin/dangerous/prepare", post(prepare_dangerous))
        .layer(DefaultBodyLimit::disable())
        .layer(RequestBodyLimitLayer::new(64 * 1024 * 1024));

    // Ten-minute Computer History segments can legitimately exceed the normal
    // 2 MiB command limit because one accessibility-tree event may contain a
    // large visible document. Keep the larger allowance on this local import
    // route only.
    let computer_history_route = Router::new()
        .route(
            "/v1/evidence/computer-history",
            post(computer_history_evidence),
        )
        .layer(DefaultBodyLimit::disable())
        .layer(RequestBodyLimitLayer::new(16 * 1024 * 1024));

    regular_routes
        .merge(restore_prepare_route)
        .merge(computer_history_route)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(state.database.health().await?))
}

async fn context(
    State(state): State<AppState>,
    Json(request): Json<ContextRequest>,
) -> AppResult<Json<Value>> {
    Ok(Json(state.database.context(request).await?))
}

async fn list_changes(
    State(state): State<AppState>,
    Query(query): Query<LimitQuery>,
) -> AppResult<Json<Value>> {
    Ok(Json(
        state
            .database
            .list_changes(query.limit.unwrap_or(100))
            .await?,
    ))
}

async fn due_actions(
    State(state): State<AppState>,
    Query(query): Query<DueActionsQuery>,
) -> AppResult<Json<Value>> {
    Ok(Json(
        state
            .database
            .due_actions(
                query.at.as_deref(),
                query.limit.unwrap_or(100),
                query.sensitivity_ceiling.as_deref().unwrap_or("highest"),
            )
            .await?,
    ))
}

async fn due_candidates(
    State(state): State<AppState>,
    Query(query): Query<DueCandidatesQuery>,
) -> AppResult<Json<Value>> {
    Ok(Json(
        state
            .database
            .due_candidates(
                query.at.as_deref(),
                query.limit.unwrap_or(100),
                query.sensitivity_ceiling.as_deref().unwrap_or("highest"),
            )
            .await?,
    ))
}

async fn list_reviews(
    State(state): State<AppState>,
    Query(query): Query<ReviewsQuery>,
) -> AppResult<Json<Value>> {
    if let Some(status) = query.status.as_deref() {
        if !matches!(status, "due" | "generated" | "all") {
            return Err(AppError::Invalid(
                "status must be due, generated, or all".into(),
            ));
        }
    }
    Ok(Json(
        state
            .database
            .review_status(
                query.due_before.as_deref(),
                query.status.as_deref(),
                query.limit.unwrap_or(20),
                query.sensitivity_ceiling.as_deref().unwrap_or("highest"),
            )
            .await?,
    ))
}

async fn changes(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(raw): Json<Value>,
) -> AppResult<Json<Value>> {
    let request = parse_change_request(raw)?;
    let (client_request_id, canonical_request) = match &request {
        ChangeRequest::Remember(value) => (
            value.client_request_id.as_deref(),
            serde_json::to_value(&request)?,
        ),
        ChangeRequest::Update(value) => (
            value.client_request_id.as_deref(),
            serde_json::to_value(&request)?,
        ),
        ChangeRequest::Retract(value) => (
            value.client_request_id.as_deref(),
            serde_json::to_value(&request)?,
        ),
        ChangeRequest::Rollback(value) => (
            value.client_request_id.as_deref(),
            serde_json::to_value(&request)?,
        ),
    };
    let idempotency = idempotency_context(
        &headers,
        client_request_id,
        "/v1/changes",
        &canonical_request,
    )?;
    let response = match request {
        ChangeRequest::Remember(value) => {
            state.database.remember(value, idempotency.as_ref()).await?
        }
        ChangeRequest::Update(value) => state.database.update(value, idempotency.as_ref()).await?,
        ChangeRequest::Retract(value) => {
            state.database.retract(value, idempotency.as_ref()).await?
        }
        ChangeRequest::Rollback(value) => {
            state.database.rollback(value, idempotency.as_ref()).await?
        }
    };
    Ok(Json(serde_json::to_value(response)?))
}

async fn rollback_alias(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(change_set_id): Path<String>,
    Json(mut request): Json<RollbackRequest>,
) -> AppResult<Json<Value>> {
    request.change_set_id = change_set_id;
    let idempotency = idempotency_context(
        &headers,
        request.client_request_id.as_deref(),
        "/v1/changes/:id/rollback",
        &request,
    )?;
    Ok(Json(serde_json::to_value(
        state
            .database
            .rollback(request, idempotency.as_ref())
            .await?,
    )?))
}

async fn actions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ActionRequest>,
) -> AppResult<Json<Value>> {
    let idempotency = idempotency_context(
        &headers,
        request.client_request_id.as_deref(),
        "/v1/actions",
        &request,
    )?;
    Ok(Json(serde_json::to_value(
        state
            .database
            .create_action(request, idempotency.as_ref())
            .await?,
    )?))
}

async fn candidates(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CandidateCreateRequest>,
) -> AppResult<Json<Value>> {
    let idempotency = idempotency_context(
        &headers,
        request.client_request_id.as_deref(),
        "/v1/candidates",
        &request,
    )?;
    Ok(Json(serde_json::to_value(
        state
            .database
            .create_candidate(request, idempotency.as_ref())
            .await?,
    )?))
}

async fn candidate_commands(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(candidate_id): Path<String>,
    Json(request): Json<CandidateCommandRequest>,
) -> AppResult<Json<Value>> {
    let canonical_request = json!({
        "candidateId": candidate_id,
        "request": request,
    });
    let idempotency = idempotency_context(
        &headers,
        request.client_request_id.as_deref(),
        "/v1/candidates/:id/commands",
        &canonical_request,
    )?;
    Ok(Json(serde_json::to_value(
        state
            .database
            .command_candidate(&candidate_id, request, idempotency.as_ref())
            .await?,
    )?))
}

async fn outcomes(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<OutcomeRequest>,
) -> AppResult<Json<Value>> {
    let idempotency = idempotency_context(
        &headers,
        request.client_request_id.as_deref(),
        "/v1/outcomes",
        &request,
    )?;
    Ok(Json(serde_json::to_value(
        state
            .database
            .record_outcome(request, idempotency.as_ref())
            .await?,
    )?))
}

async fn reviews(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<WeeklyReviewRequest>,
) -> AppResult<Json<Value>> {
    let idempotency = idempotency_context(
        &headers,
        request.client_request_id.as_deref(),
        "/v1/reviews",
        &request,
    )?;
    Ok(Json(serde_json::to_value(
        state
            .database
            .create_weekly_review(request, idempotency.as_ref())
            .await?,
    )?))
}

async fn web_evidence(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<WebEvidenceRequest>,
) -> AppResult<Json<Value>> {
    let idempotency = idempotency_context(
        &headers,
        request.client_request_id.as_deref(),
        "/v1/evidence/web",
        &request,
    )?;
    Ok(Json(serde_json::to_value(
        state
            .database
            .record_web_evidence(request, idempotency.as_ref())
            .await?,
    )?))
}

async fn evidence_query(
    State(state): State<AppState>,
    Json(request): Json<EvidenceQueryRequest>,
) -> AppResult<Json<Value>> {
    Ok(Json(state.database.query_evidence(request).await?))
}

async fn evidence_read(
    State(state): State<AppState>,
    Json(request): Json<EvidenceReadRequest>,
) -> AppResult<Json<Value>> {
    Ok(Json(state.database.read_evidence(request).await?))
}

async fn computer_history_evidence(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ComputerHistoryEvidenceRequest>,
) -> AppResult<Json<Value>> {
    let idempotency = idempotency_context(
        &headers,
        request.client_request_id.as_deref(),
        "/v1/evidence/computer-history",
        &request,
    )?;
    Ok(Json(serde_json::to_value(
        state
            .database
            .record_computer_history_evidence(request, idempotency.as_ref())
            .await?,
    )?))
}

async fn message_evidence(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<MessageEvidenceRequest>,
) -> AppResult<Json<Value>> {
    let idempotency = idempotency_context(
        &headers,
        request.client_request_id.as_deref(),
        "/v1/evidence/message",
        &request,
    )?;
    Ok(Json(serde_json::to_value(
        state
            .database
            .record_message_evidence(request, idempotency.as_ref())
            .await?,
    )?))
}

async fn locate_event(
    State(state): State<AppState>,
    Json(request): Json<LocateEventRequest>,
) -> AppResult<Json<Value>> {
    Ok(Json(state.database.locate_event(request).await?))
}

async fn apply_location(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ApplyLocationRequest>,
) -> AppResult<Json<Value>> {
    let idempotency = idempotency_context(
        &headers,
        request.client_request_id.as_deref(),
        "/v1/star-map/apply-location",
        &request,
    )?;
    Ok(Json(serde_json::to_value(
        state
            .database
            .apply_location(request, idempotency.as_ref())
            .await?,
    )?))
}

async fn relationships(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<RelationshipRequest>,
) -> AppResult<Json<Value>> {
    let idempotency = idempotency_context(
        &headers,
        request.client_request_id.as_deref(),
        "/v1/relationships",
        &request,
    )?;
    Ok(Json(serde_json::to_value(
        state
            .database
            .create_relationship(request, idempotency.as_ref())
            .await?,
    )?))
}

async fn compile_context(
    State(state): State<AppState>,
    Json(request): Json<CompileContextRequest>,
) -> AppResult<Json<Value>> {
    Ok(Json(state.database.compile_context(request).await?))
}

async fn apply_feedback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ApplyFeedbackRequest>,
) -> AppResult<Json<Value>> {
    let idempotency = idempotency_context(
        &headers,
        request.client_request_id.as_deref(),
        "/v1/star-map/apply-feedback",
        &request,
    )?;
    Ok(Json(serde_json::to_value(
        state
            .database
            .apply_feedback(request, idempotency.as_ref())
            .await?,
    )?))
}

async fn list_revisions(
    State(state): State<AppState>,
    Query(query): Query<RevisionsQuery>,
) -> AppResult<Json<Value>> {
    Ok(Json(
        state
            .database
            .list_revisions(
                query.status.as_deref(),
                query.limit.unwrap_or(100),
                query.sensitivity_ceiling.as_deref().unwrap_or("highest"),
            )
            .await?,
    ))
}

async fn resolve_revision(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(revision_id): Path<String>,
    Json(request): Json<ResolveRevisionRequest>,
) -> AppResult<Json<Value>> {
    let idempotency = idempotency_context(
        &headers,
        request.client_request_id.as_deref(),
        "/v1/revisions/:id/resolve",
        &request,
    )?;
    Ok(Json(serde_json::to_value(
        state
            .database
            .resolve_revision(&revision_id, request, idempotency.as_ref())
            .await?,
    )?))
}

async fn export(State(state): State<AppState>) -> AppResult<Json<ExportDocument>> {
    Ok(Json(state.database.export_document().await?))
}

async fn integrity(State(state): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(state.database.integrity().await?))
}

async fn prepare_dangerous(
    State(state): State<AppState>,
    Json(request): Json<PrepareDangerousRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let (confirmation, snapshot_checksum, ttl_minutes) = match request.operation.as_str() {
        "delete_all" => {
            if request.snapshot.is_some() {
                return Err(AppError::Invalid(
                    "delete_all does not accept a snapshot".into(),
                ));
            }
            ("DELETE ALL LOCAL DATA".to_string(), None, 10)
        }
        "restore" => {
            let snapshot = request
                .snapshot
                .as_ref()
                .ok_or_else(|| AppError::Invalid("restore requires snapshot".into()))?;
            if snapshot.format != "latitude.constellation.export@0.1" {
                return Err(AppError::Invalid("unsupported snapshot format".into()));
            }
            (
                "RESTORE LOCAL DATA".to_string(),
                Some(snapshot.checksum.clone()),
                10,
            )
        }
        "purge_all" => {
            if request.snapshot.is_some() {
                return Err(AppError::Invalid(
                    "purge_all does not accept a snapshot".into(),
                ));
            }
            ("PERMANENTLY DELETE ALL LATITUDE DATA".to_string(), None, 2)
        }
        _ => {
            return Err(AppError::Invalid(
                "operation must be restore, delete_all, or purge_all".into(),
            ))
        }
    };
    let token = Uuid::new_v4().to_string();
    let expires_at = Utc::now() + Duration::minutes(ttl_minutes);
    state.dangerous_operations.lock().await.insert(
        token.clone(),
        PendingDangerousOperation {
            operation: request.operation.clone(),
            snapshot: request.snapshot,
            confirmation: confirmation.clone(),
            expires_at,
        },
    );
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "ok": true,
            "operation": request.operation,
            "token": token,
            "expiresAt": expires_at.to_rfc3339_opts(SecondsFormat::Millis, true),
            "requiredConfirmation": confirmation,
            "snapshotChecksum": snapshot_checksum,
        })),
    ))
}

async fn commit_dangerous(
    State(state): State<AppState>,
    Json(request): Json<CommitDangerousRequest>,
) -> AppResult<Json<Value>> {
    let pending = {
        let mut operations = state.dangerous_operations.lock().await;
        operations.retain(|_, value| value.expires_at > Utc::now());
        let pending = operations.get(&request.token).cloned().ok_or_else(|| {
            AppError::ConfirmationRequired("invalid or expired operation token".into())
        })?;
        if pending.confirmation != request.confirmation {
            return Err(AppError::ConfirmationRequired(
                "confirmation phrase does not match".into(),
            ));
        }
        operations.remove(&request.token);
        pending
    };
    let audit = AuditContext {
        actor: "system".into(),
        session_id: None,
        turn_id: None,
        tool_call_id: None,
        authorization_mode: "preauthorized".into(),
    };
    let response = match pending.operation.as_str() {
        "delete_all" => serde_json::to_value(state.database.delete_all(&audit).await?)?,
        "restore" => {
            let snapshot = pending
                .snapshot
                .as_ref()
                .ok_or_else(|| AppError::Internal("restore token lost its snapshot".into()))?;
            serde_json::to_value(state.database.restore_document(snapshot, &audit).await?)?
        }
        "purge_all" => state.database.purge_all().await?,
        _ => return Err(AppError::Internal("unknown dangerous operation".into())),
    };
    Ok(Json(response))
}

fn idempotency_context<T: Serialize>(
    headers: &HeaderMap,
    client_request_id: Option<&str>,
    route: &str,
    request: &T,
) -> AppResult<Option<IdempotencyContext>> {
    let header_key = headers
        .get("idempotency-key")
        .map(|value| {
            value
                .to_str()
                .map_err(|_| AppError::Invalid("Idempotency-Key must be ASCII".into()))
        })
        .transpose()?;
    let key = header_key.or(client_request_id);
    key.map(|value| IdempotencyContext::for_request(value, route, request))
        .transpose()
}

fn parse_change_request(raw: Value) -> AppResult<ChangeRequest> {
    if let Ok(request) = serde_json::from_value::<ChangeRequest>(raw.clone()) {
        return Ok(request);
    }
    // Transitional adapter for the old Agent Host envelope. The documented contract
    // remains flat camelCase; this branch only prevents a mixed-version local startup.
    let object = raw
        .as_object()
        .ok_or_else(|| AppError::Invalid("change request must be an object".into()))?;
    let operation = object
        .get("operation")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Invalid("change request requires operation".into()))?;
    let mut input = object
        .get("input")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| AppError::Invalid("nested compatibility request requires input".into()))?;
    input.insert("operation".into(), Value::String(operation.into()));
    if !input.contains_key("audit") {
        if let Some(meta) = object.get("meta") {
            input.insert("audit".into(), meta.clone());
        }
    }
    serde_json::from_value(Value::Object(input))
        .map_err(|error| AppError::Invalid(format!("invalid change payload: {error}")))
}

async fn history_settings(State(s): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(s.database.history_settings().await?))
}
async fn history_expire(State(s): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(s.database.history_expire().await?))
}
async fn history_configure(
    State(s): State<AppState>,
    Json(v): Json<Value>,
) -> AppResult<Json<Value>> {
    Ok(Json(s.database.history_configure(v).await?))
}
async fn history_heartbeat(
    State(s): State<AppState>,
    Json(v): Json<Value>,
) -> AppResult<Json<Value>> {
    Ok(Json(s.database.history_heartbeat(v).await?))
}
async fn history_ingest(State(s): State<AppState>, Json(v): Json<Value>) -> AppResult<Json<Value>> {
    Ok(Json(s.database.history_ingest(v).await?))
}
async fn history_query(State(s): State<AppState>, Json(v): Json<Value>) -> AppResult<Json<Value>> {
    Ok(Json(s.database.history_query(v).await?))
}
async fn history_summary(
    State(s): State<AppState>,
    Json(v): Json<Value>,
) -> AppResult<Json<Value>> {
    Ok(Json(s.database.history_summary(v).await?))
}
async fn history_memory(State(s): State<AppState>, Json(v): Json<Value>) -> AppResult<Json<Value>> {
    Ok(Json(s.database.history_memory(v).await?))
}
async fn history_suggestion(
    State(s): State<AppState>,
    Json(v): Json<Value>,
) -> AppResult<Json<Value>> {
    Ok(Json(s.database.history_suggestion(v).await?))
}
async fn history_workflow(
    State(s): State<AppState>,
    Json(v): Json<Value>,
) -> AppResult<Json<Value>> {
    Ok(Json(s.database.history_workflow(v).await?))
}
async fn history_diagnostics(State(s): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(s.database.history_diagnostics().await?))
}
async fn history_clear(State(s): State<AppState>, Json(v): Json<Value>) -> AppResult<Json<Value>> {
    Ok(Json(s.database.history_clear(v).await?))
}
