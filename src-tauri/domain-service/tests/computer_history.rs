use chrono::{SecondsFormat, Utc};
use latitude_domain_service::Database;
use serde_json::{json, Value};
async fn setup() -> (tempfile::TempDir, Database, Value) {
    let dir = tempfile::tempdir().unwrap();
    let (db, _) = Database::open(dir.path().join("domain.db"), dir.path().join("backups"))
        .await
        .unwrap();
    let mut settings = db.history_settings().await.unwrap();
    settings["config"]["enabled"] = json!(true);
    settings["config"]["modelProcessing"] = json!(true);
    let settings = db.history_configure(settings).await.unwrap();
    (dir, db, settings)
}
fn event(id: &str) -> Value {
    json!({"id":id,"timestamp":Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true),"applicationName":"Preview","bundleIdentifier":"com.apple.Preview","windowTitle":"发布方案","visibleText":"计划周五完成测试，再提交评审。","kind":"accessibilityTextChanged","metadata":{}})
}

#[tokio::test]
async fn editable_memory_files_reconcile_corrections_preserve_invalid_edits_and_clear_copies() {
    let (_dir, db, settings) = setup().await;
    db.history_ingest(json!({"provider":"latitude","revision":settings["revision"],"events":[event("memory-file")]})).await.unwrap();
    let page = db.history_query(json!({})).await.unwrap();
    let group = page["items"][0]["id"].clone();
    let ids: Vec<Value> = page["items"][0]["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].clone())
        .collect();
    db.history_summary(json!({"revision":settings["revision"],"groupId":group,"eventIds":ids,"summary":{"title":"评审准备","text":"检查测试结果。"}})).await.unwrap();
    db.history_memory(json!({"action":"save","revision":settings["revision"],"groupIds":[group],"memories":[{"statement":"反复打开方案。","groupIds":[group]}]})).await.unwrap();
    let file = db.history_memory_path();
    let mut document: Value =
        serde_json::from_slice(&tokio::fs::read(&file).await.unwrap()).unwrap();
    document["memories"][0]["statement"] = json!("我在测试刷新结果，并不是犹豫。");
    tokio::fs::write(&file, serde_json::to_vec_pretty(&document).unwrap())
        .await
        .unwrap();
    let synced = db.history_memory(json!({"action":"list"})).await.unwrap();
    assert_eq!(
        synced["items"][0]["statement"],
        document["memories"][0]["statement"]
    );
    assert_eq!(synced["items"][0]["status"], "user_corrected");
    assert!(
        db.history_settings().await.unwrap()["revision"]
            .as_i64()
            .unwrap()
            > settings["revision"].as_i64().unwrap()
    );
    tokio::fs::write(&file, b"{broken personal edit")
        .await
        .unwrap();
    let broken = db.history_memory(json!({"action":"list"})).await.unwrap();
    assert!(broken["memoryFile"]["error"].is_string());
    assert_eq!(
        tokio::fs::read_to_string(&file).await.unwrap(),
        "{broken personal edit"
    );
    db.history_memory(json!({"action":"restoreFile"}))
        .await
        .unwrap();
    let recovered: Value = serde_json::from_slice(&tokio::fs::read(&file).await.unwrap()).unwrap();
    assert_eq!(
        recovered["memories"][0]["statement"],
        synced["items"][0]["statement"]
    );
    // A stale file cannot undo a later correction in the app.
    db.history_memory(
        json!({"action":"review","id":synced["items"][0]["id"],"statement":"应用中的最新修正。"}),
    )
    .await
    .unwrap();
    tokio::fs::write(&file, serde_json::to_vec(&document).unwrap())
        .await
        .unwrap();
    let conflict = db.history_memory(json!({"action":"list"})).await.unwrap();
    assert!(conflict["memoryFile"]["error"].is_string());
    assert_eq!(conflict["items"][0]["statement"], "应用中的最新修正。");
    db.history_clear(json!({"groupId":group,"confirm":"删除记录"}))
        .await
        .unwrap();
    for name in ["memories.json", "last-valid.json"] {
        let cleared: Value = serde_json::from_slice(
            &tokio::fs::read(file.parent().unwrap().join(name))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(cleared["memories"], json!([]));
    }
}

#[tokio::test]
async fn pause_keeps_previous_material_available_for_summarizing() {
    let (_dir, db, mut settings) = setup().await;
    db.history_ingest(json!({"provider":"latitude","revision":settings["revision"],"events":[event("before-pause")]})).await.unwrap();
    settings["config"]["paused"] = json!(true);
    let paused = db.history_configure(settings).await.unwrap();
    let page = db.history_query(json!({})).await.unwrap();
    let group = page["items"][0]["id"].clone();
    db.history_summary(json!({"revision":paused["revision"],"groupId":group,"eventIds":[page["items"][0]["events"][0]["id"]],"summary":{"title":"暂停前的准备","text":"测试后提交评审。"}})).await.unwrap();
    assert_eq!(db.history_ingest(json!({"provider":"latitude","revision":paused["revision"],"events":[event("during-pause")]})).await.unwrap()["accepted"],0);
}

#[tokio::test]
async fn workflow_edits_require_retrial_and_source_deletion_removes_enabled_work() {
    let (_dir, db, settings) = setup().await;
    db.history_ingest(
        json!({"provider":"latitude","revision":settings["revision"],"events":[event("workflow")]}),
    )
    .await
    .unwrap();
    let page = db.history_query(json!({})).await.unwrap();
    let group = page["items"][0]["id"].clone();
    db.history_summary(json!({"revision":settings["revision"],"groupId":group,"eventIds":[page["items"][0]["events"][0]["id"]],"summary":{"title":"评审准备","text":"核对测试结果。","suggestion":{"kind":"skill","title":"整理评审材料","prompt":"从评审活动中提取已确认事项及缺口。"}}})).await.unwrap();
    let draft = db
        .history_workflow(json!({"action":"prepare","groupId":group}))
        .await
        .unwrap()["items"][0]
        .clone();
    assert_eq!(draft["state"], "draft");
    assert!(db
        .history_workflow(json!({"action":"enable","groupId":group,"version":draft["version"]}))
        .await
        .is_err());
    db.history_workflow(json!({"action":"markRun","groupId":group,"version":draft["version"],"runId":"trial-1","trial":true})).await.unwrap();
    let enabled=db.history_workflow(json!({"action":"enable","groupId":group,"version":draft["version"],"trialRunId":"trial-1"})).await.unwrap();
    assert_eq!(enabled["items"][0]["state"], "enabled");
    let edited=db.history_workflow(json!({"action":"save","groupId":group,"version":draft["version"],"title":"新周报","prompt":"只整理本周有依据的进展。","cadence":"weekly","weekday":5,"at":"17:00"})).await.unwrap()["items"][0].clone();
    assert_ne!(edited["version"], draft["version"]);
    assert_eq!(edited["state"], "draft");
    assert!(edited["trialRunId"].is_null());
    assert!(db
        .history_workflow(json!({"action":"disable","groupId":group,"version":draft["version"]}))
        .await
        .is_err());
    db.history_clear(json!({"confirm":"删除记录","groupId":group}))
        .await
        .unwrap();
    assert_eq!(
        db.history_workflow(json!({"action":"list"})).await.unwrap()["items"],
        json!([])
    );
}
#[tokio::test]
async fn consent_revisions_and_private_scopes_are_enforced_before_persistence() {
    let (_dir, db, mut settings) = setup().await;
    let revision = settings["revision"].clone();
    let mut private = event("private");
    private["metadata"] = json!({"browser":"true","privacyState":"unknown"});
    let mut input = event("input");
    input["targetRole"] = json!("AXTextField");
    let result = db
        .history_ingest(
            json!({"provider":"latitude","revision":revision,"events":[private,input,event("ok")]}),
        )
        .await
        .unwrap();
    assert_eq!(result["accepted"], 1);
    settings["config"]["paused"] = json!(true);
    db.history_configure(settings).await.unwrap();
    assert!(db
        .history_ingest(json!({"provider":"latitude","revision":revision,"events":[event("late")]}))
        .await
        .is_err());
    let page = db
        .history_query(json!({"includeContent":true}))
        .await
        .unwrap();
    assert_eq!(page["items"][0]["events"].as_array().unwrap().len(), 1);
}
#[tokio::test]
async fn replay_is_idempotent_and_clear_prevents_reimport() {
    let (_dir, db, settings) = setup().await;
    let original = event("same");
    let body = json!({"provider":"latitude","revision":settings["revision"],"events":[original]});
    assert_eq!(
        db.history_ingest(body.clone()).await.unwrap()["accepted"],
        1
    );
    assert_eq!(
        db.history_ingest(body.clone()).await.unwrap()["accepted"],
        0
    );
    let page = db.history_query(json!({})).await.unwrap();
    let group = page["items"][0]["id"].clone();
    db.history_summary(json!({"revision":settings["revision"],"groupId":group,"eventIds":page["items"][0]["events"].as_array().unwrap().iter().map(|e|e["id"].clone()).collect::<Vec<_>>(),"summary":{"title":"准备评审","text":"计划完成测试后提交评审。"}})).await.unwrap();
    db.history_clear(json!({"confirm":"删除记录","groupId":group}))
        .await
        .unwrap();
    assert!(db.history_query(json!({})).await.unwrap()["items"]
        .as_array()
        .unwrap()
        .is_empty());
    let mut replay = body;
    replay["revision"] = db.history_settings().await.unwrap()["revision"].clone();
    assert_eq!(db.history_ingest(replay).await.unwrap()["accepted"], 0);
    assert!(db.history_summary(json!({"revision":settings["revision"],"groupId":group,"eventIds":page["items"][0]["events"].as_array().unwrap().iter().map(|e|e["id"].clone()).collect::<Vec<_>>(),"summary":{"title":"旧任务","text":"不应复活"}})).await.is_err());
    let raw: Option<String> = sqlx::query_scalar("SELECT excerpt FROM evidence_refs LIMIT 1")
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert!(raw.is_none());
}
#[tokio::test]
async fn website_rules_are_domain_scoped_and_apply_to_external_records() {
    let (_dir, db, mut settings) = setup().await;
    settings["config"]["externalEnabled"] = json!(true);
    settings["config"]["sites"] = json!(["example.com"]);
    let settings = db.history_configure(settings).await.unwrap();
    let mut blocked = event("blocked");
    blocked["url"] = json!("https://sub.example.com/doc");
    blocked["metadata"] = json!({"browser":"true","privacyState":"normal"});
    let mut valid = blocked.clone();
    valid["id"] = json!("valid");
    valid["url"] = json!("https://notexample.com/doc?token=private");
    assert_eq!(
        db.history_ingest(
            json!({"revision":settings["revision"],"provider":"openai","events":[blocked,valid]})
        )
        .await
        .unwrap()["accepted"],
        1
    );
    assert_eq!(
        db.history_query(json!({})).await.unwrap()["items"][0]["url"],
        "https://notexample.com/doc"
    );
}
#[tokio::test]
async fn expiration_removes_raw_text_but_keeps_summary() {
    let (_dir, db, settings) = setup().await;
    db.history_ingest(
        json!({"provider":"latitude","revision":settings["revision"],"events":[event("expires")]}),
    )
    .await
    .unwrap();
    let page = db.history_query(json!({})).await.unwrap();
    let group = page["items"][0]["id"].clone();
    db.history_summary(json!({"revision":settings["revision"],"groupId":group,"eventIds":page["items"][0]["events"].as_array().unwrap().iter().map(|e|e["id"].clone()).collect::<Vec<_>>(),"summary":{"title":"准备评审","text":"整理发布计划"}})).await.unwrap();
    sqlx::query("UPDATE history_items SET observed_at='2000-01-01T00:00:00.000Z'")
        .execute(db.pool())
        .await
        .unwrap();
    // Retention also runs on status checks, without opening the timeline.
    db.history_settings().await.unwrap();
    let page = db
        .history_query(json!({"includeContent":true}))
        .await
        .unwrap();
    assert_eq!(page["items"][0]["summary"]["title"], "准备评审");
    assert_eq!(page["items"][0]["events"][0]["expired"], true);
    assert!(page["items"][0]["events"][0]["content"].is_null());
}

#[tokio::test]
async fn summary_requires_the_actual_read_set_and_memories_respect_user_corrections() {
    let (_dir, db, settings) = setup().await;
    db.history_ingest(
        json!({"provider":"latitude","revision":settings["revision"],"events":[event("first")]}),
    )
    .await
    .unwrap();
    let page = db.history_query(json!({})).await.unwrap();
    let group = page["items"][0]["id"].clone();
    let ids: Vec<Value> = page["items"][0]["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].clone())
        .collect();
    assert!(db.history_summary(json!({"revision":settings["revision"],"groupId":group,"eventIds":["invented"],"summary":{"title":"虚构","text":"没有依据"}})).await.is_err());
    db.history_summary(json!({"revision":settings["revision"],"groupId":group,"eventIds":ids,"summary":{"title":"准备评审","text":"整理评审问题"}})).await.unwrap();
    let memory = json!({"action":"save","revision":settings["revision"],"groupIds":[group],"memories":[{"statement":"这次评审先核对需求。","groupIds":[group]}]});
    let saved = db.history_memory(memory.clone()).await.unwrap();
    let id = saved["items"][0]["id"].clone();
    db.history_memory(
        json!({"action":"review","id":id,"statement":"这是这个项目的要求，并非我的通用偏好。"}),
    )
    .await
    .unwrap();
    let mut replay = memory.clone();
    replay["revision"] = db.history_settings().await.unwrap()["revision"].clone();
    assert_eq!(
        db.history_memory(replay.clone()).await.unwrap()["items"][0]["statement"],
        "这是这个项目的要求，并非我的通用偏好。"
    );
    db.history_memory(json!({"action":"remove","id":id}))
        .await
        .unwrap();
    replay["revision"] = db.history_settings().await.unwrap()["revision"].clone();
    assert!(db.history_memory(replay).await.unwrap()["items"]
        .as_array()
        .unwrap()
        .is_empty());
    db.history_clear(json!({"confirm":"删除记录","groupId":group}))
        .await
        .unwrap();
    assert!(db.history_memory(memory).await.is_err());
}

#[tokio::test]
async fn automatic_backups_do_not_retain_activity_content() {
    let (_dir, db, settings) = setup().await;
    db.history_ingest(
        json!({"provider":"latitude","revision":settings["revision"],"events":[event("backup")]}),
    )
    .await
    .unwrap();
    let backup = db.create_backup("history-test").await.unwrap();
    let copy = sqlx::SqlitePool::connect(&format!("sqlite://{}", backup.display()))
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM history_items")
        .fetch_one(&copy)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let text: Option<String> = sqlx::query_scalar("SELECT excerpt FROM evidence_refs LIMIT 1")
        .fetch_one(&copy)
        .await
        .unwrap();
    assert!(text.is_none());
    copy.close().await;
    assert_eq!(
        db.history_query(json!({})).await.unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn large_timeline_pages_preserve_complete_activity_groups() {
    let (_dir, db, settings) = setup().await;
    let events: Vec<Value> = (0..65)
        .map(|i| {
            let mut e = event(&format!("e-{i}"));
            e["bundleIdentifier"] = json!(format!("example.app{i}"));
            e
        })
        .collect();
    db.history_ingest(
        json!({"provider":"latitude","revision":settings["revision"],"events":events}),
    )
    .await
    .unwrap();
    let first = db.history_query(json!({})).await.unwrap();
    assert_eq!(first["items"].as_array().unwrap().len(), 50);
    assert_eq!(first["hasMore"], true);
    let second = db
        .history_query(json!({"offset":first["nextOffset"]}))
        .await
        .unwrap();
    assert_eq!(second["items"].as_array().unwrap().len(), 15);
    assert_eq!(second["hasMore"], false);
}
