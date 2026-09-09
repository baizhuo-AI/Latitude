//! Native history lives in the existing evidence database. Raw text has one
//! owner (evidence_refs); summaries are replaceable, versioned projections.
use super::*;

fn defaults() -> Value {
    json!({"enabled":false,"paused":false,"nativeEnabled":true,"externalEnabled":false,
        "appMode":"exclude","apps":[],"siteMode":"exclude","sites":[],"modelProcessing":false,"externalMode":"continuous"})
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn allowed(config: &Value, mode: &str, list: &str, candidates: &[&str], domains: bool) -> bool {
    let matched = config[list]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|rule| {
            let rule = rule.to_lowercase();
            candidates.iter().any(|value| {
                let value = value.to_lowercase();
                value == rule || (domains && value.ends_with(&format!(".{rule}")))
            })
        });
    if text(config, mode) == "include" {
        matched
    } else {
        !matched
    }
}

impl Database {
    pub async fn history_diagnostics(&self) -> AppResult<Value> {
        let rows=sqlx::query("SELECT provider,app,coverage,MIN(observed_at) AS first_seen,MAX(observed_at) AS last_seen FROM history_items GROUP BY provider,app,coverage ORDER BY last_seen DESC LIMIT 200").fetch_all(&self.pool).await?;
        let sources:Vec<Value>=rows.iter().map(|row|json!({"provider":row.get::<&str,_>("provider"),"app":row.get::<&str,_>("app"),"coverage":row.get::<&str,_>("coverage"),"from":row.get::<&str,_>("first_seen"),"to":row.get::<&str,_>("last_seen")})).collect();
        Ok(json!({"sources":sources}))
    }
    pub async fn history_settings(&self) -> AppResult<Value> {
        sqlx::query("INSERT OR IGNORE INTO history_settings(id) VALUES(1)")
            .execute(&self.pool)
            .await?;
        // Enforce retention on the collector/model status path too.
        self.history_expire().await?;
        let row =
            sqlx::query("SELECT revision,config_json,status_json FROM history_settings WHERE id=1")
                .fetch_one(&self.pool)
                .await?;
        let mut config = defaults();
        let saved: Value = serde_json::from_str(row.get::<&str, _>("config_json"))?;
        if let Some(values) = saved.as_object() {
            for (k, v) in values {
                config[k] = v.clone();
            }
        }
        Ok(
            json!({"revision":row.get::<i64,_>("revision"),"config":config,
            "collector":serde_json::from_str::<Value>(row.get::<&str,_>("status_json"))?}),
        )
    }

    pub async fn history_configure(&self, request: Value) -> AppResult<Value> {
        let revision = request["revision"]
            .as_i64()
            .ok_or_else(|| AppError::Invalid("设置版本缺失，请刷新后重试。".into()))?;
        let config = request["config"].clone();
        let obj = config
            .as_object()
            .ok_or_else(|| AppError::Invalid("记录设置无效。".into()))?;
        let template = defaults();
        for (k, v) in obj {
            if template.get(k).is_none() {
                return Err(AppError::Invalid(format!("未知设置：{k}")));
            }
            if template[k].is_boolean() && !v.is_boolean() {
                return Err(AppError::Invalid(format!("{k} 必须是开关。")));
            }
        }
        for k in [
            "enabled",
            "paused",
            "nativeEnabled",
            "externalEnabled",
            "modelProcessing",
        ] {
            if !config[k].is_boolean() {
                return Err(AppError::Invalid(format!("缺少设置 {k}")));
            }
        }
        for k in ["appMode", "siteMode"] {
            if !matches!(text(&config, k), "include" | "exclude") {
                return Err(AppError::Invalid("范围模式无效。".into()));
            }
        }
        if config.get("externalMode").is_some()
            && !matches!(text(&config, "externalMode"), "once" | "continuous")
        {
            return Err(AppError::Invalid("已有历史的读取方式无效。".into()));
        }
        for k in ["apps", "sites"] {
            let rules = config[k]
                .as_array()
                .ok_or_else(|| AppError::Invalid("范围必须是列表。".into()))?;
            if rules.len() > 200
                || rules.iter().any(|v| {
                    v.as_str()
                        .is_none_or(|s| s.trim().is_empty() || s.len() > 250)
                })
            {
                return Err(AppError::Invalid("应用或网站规则无效。".into()));
            }
        }
        for site in config["sites"].as_array().unwrap() {
            let host = site.as_str().unwrap();
            if host.contains(['/', ':', ' ']) || host.starts_with('.') {
                return Err(AppError::Invalid(
                    "网站请填写域名，例如 example.com。".into(),
                ));
            }
        }
        let mut tx = self.pool.begin().await?;
        let result=sqlx::query("UPDATE history_settings SET revision=revision+1,config_json=? WHERE id=1 AND revision=?")
            .bind(config.to_string()).bind(revision).execute(&mut *tx).await?;
        if result.rows_affected() == 0 {
            return Err(AppError::Conflict(
                "设置已在另一处改变，请刷新后重试。".into(),
            ));
        }
        sqlx::query("UPDATE source_records SET model_access=? WHERE collector_version LIKE 'latitude-history/%'")
            .bind(if config["modelProcessing"]==true {"external_allowed"}else{"forbidden"}).execute(&mut *tx).await?;
        tx.commit().await?;
        self.history_settings().await
    }

    pub async fn history_heartbeat(&self, request: Value) -> AppResult<Value> {
        // Store operational state only, never arbitrary captured text in status.
        let status = json!({"state":text(&request,"state"),"permission":request["permission"].as_bool().unwrap_or(false),
            "lastSeenAt":now_iso(),"error":text(&request,"error"),"coverage":text(&request,"coverage")});
        sqlx::query("UPDATE history_settings SET status_json=? WHERE id=1")
            .bind(status.to_string())
            .execute(&self.pool)
            .await?;
        Ok(status)
    }

    pub async fn history_ingest(&self, request: Value) -> AppResult<Value> {
        let mut tx = self.pool.begin().await?;
        // Reserve the write lock before checking the settings generation, so
        // pause/delete cannot race a stale importer into committing afterwards.
        sqlx::query("UPDATE history_settings SET revision=revision WHERE id=1")
            .execute(&mut *tx)
            .await?;
        let row = sqlx::query("SELECT revision,config_json FROM history_settings WHERE id=1")
            .fetch_one(&mut *tx)
            .await?;
        let config: Value = serde_json::from_str(row.get::<&str, _>("config_json"))?;
        let revision = row.get::<i64, _>("revision");
        if request["revision"].as_i64() != Some(revision) {
            return Err(AppError::Conflict(
                "记录范围已变化，旧采集批次已拒绝。".into(),
            ));
        }
        if config["enabled"] != true || config["paused"] == true {
            return Ok(json!({"accepted":0,"state":"stopped"}));
        }
        let provider = text(&request, "provider");
        if !matches!(provider, "latitude" | "openai") {
            return Err(AppError::Invalid("记录来源无效。".into()));
        }
        if config[if provider == "latitude" {
            "nativeEnabled"
        } else {
            "externalEnabled"
        }] != true
        {
            return Ok(json!({"accepted":0}));
        }
        let events = request["events"]
            .as_array()
            .filter(|v| v.len() <= 200)
            .ok_or_else(|| AppError::Invalid("活动批次无效或过大。".into()))?;
        let now = Utc::now();
        let now_s = now_iso();
        let mut accepted = 0;
        for event in events {
            let observed = chrono::DateTime::parse_from_rfc3339(text(event, "timestamp"))
                .map_err(|_| AppError::Invalid("活动时间无效。".into()))?;
            if observed < now - ChronoDuration::hours(48)
                || observed > now + ChronoDuration::minutes(1)
            {
                continue;
            }
            let observed = observed.to_rfc3339_opts(SecondsFormat::Millis, true);
            let app = text(event, "applicationName");
            let bundle = text(event, "bundleIdentifier");
            if app.is_empty() || !allowed(&config, "appMode", "apps", &[app, bundle], false) {
                continue;
            }
            if event["metadata"]["privateBrowsing"] == "true"
                || event["metadata"]["privateBrowsing"] == true
            {
                continue;
            }
            let url = Url::parse(text(event, "url"))
                .ok()
                .filter(|u| matches!(u.scheme(), "http" | "https" | "file"));
            let domain = url.as_ref().and_then(Url::host_str).unwrap_or("");
            let browser =
                event["metadata"]["browser"] == "true" || event["metadata"]["browser"] == true;
            // Unknown browser privacy or URL never becomes a content record.
            if browser && (domain.is_empty() || event["metadata"]["privacyState"] != "normal") {
                continue;
            }
            if !domain.is_empty() && !allowed(&config, "siteMode", "sites", &[domain], true) {
                continue;
            }
            let role = text(event, "targetRole").to_lowercase();
            if role.contains("secure")
                || role.contains("textfield")
                || role.contains("textarea")
                || event["metadata"]["editable"] == "true"
            {
                continue;
            }
            let native_id = text(event, "id");
            if native_id.is_empty() {
                continue;
            }
            let id = format!("history_{}", hash(&format!("{provider}:{native_id}")));
            let parsed_time = chrono::DateTime::parse_from_rfc3339(&observed).unwrap();
            let group_id = format!(
                "activity_{}",
                hash(&format!(
                    "{}:{bundle}:{}",
                    parsed_time.timestamp() / 600,
                    text(event, "url")
                ))
            );
            let deleted:i64=sqlx::query_scalar("SELECT COUNT(*) FROM history_deletions WHERE from_time<=? AND to_time>=? AND (app IS NULL OR app=?) AND (group_id IS NULL OR group_id=?)")
                .bind(&observed).bind(&observed).bind(app).bind(&group_id).fetch_one(&mut *tx).await?;
            if deleted > 0 {
                continue;
            }
            let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM history_items WHERE id=?")
                .bind(&id)
                .fetch_one(&mut *tx)
                .await?;
            if exists > 0 {
                continue;
            }
            let title: String = text(event, "windowTitle").chars().take(400).collect();
            let content: String = text(event, "visibleText").chars().take(24000).collect();
            let coverage = if content.trim().is_empty() {
                "navigation_only"
            } else {
                "partial"
            };
            let clean_url = url.map(|mut u| {
                u.set_fragment(None);
                u.set_query(None);
                let _ = u.set_username("");
                let _ = u.set_password(None);
                u.to_string()
            });
            let raw = json!({"id":native_id,"timestamp":observed,"applicationName":app,"bundleIdentifier":bundle,
                "windowTitle":title,"url":clean_url,"visibleText":content,"kind":text(event,"kind"),
                "inputActivityCount":event["inputCharacterCount"].as_u64(),"shortcut":text(event,"shortcut"),
                "coverage":coverage,"actorRole":"unknown"});
            let source_id = format!("source_{id}");
            let evidence_id = format!("evidence_{id}");
            sqlx::query("INSERT INTO source_records(id,source_type,captured_at,storage_uri,content_hash,privacy_level,storage_policy,model_access,coverage_status,collector_version,created_at) VALUES(?,'computer_history',?,?,?,'highest','local_only',?,'partial',?,?)")
                .bind(&source_id).bind(&observed).bind(format!("latitude-history:{id}")).bind(hash(&raw.to_string()))
                .bind(if config["modelProcessing"]==true {"external_allowed"}else{"forbidden"}).bind(format!("latitude-history/{provider}/1")).bind(&now_s).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO evidence_refs(id,source_record_id,actor_role,attribution_status,segment_id,raw_event_ids_json,start_time,excerpt,content_hash,redaction_status,processor_name,processor_version,created_at) VALUES(?,?,'unknown','unknown',?,?,?,?,?,'redacted','latitude-history','1',?)")
                .bind(&evidence_id).bind(&source_id).bind(&group_id).bind(json!([native_id]).to_string()).bind(&observed).bind(raw.to_string()).bind(hash(&raw.to_string())).bind(&now_s).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO history_items(id,evidence_id,source_id,provider,observed_at,app,bundle_id,title,url,coverage,group_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
                .bind(&id).bind(&evidence_id).bind(&source_id).bind(provider).bind(&observed).bind(app).bind(bundle).bind(title).bind(clean_url).bind(coverage).bind(group_id).execute(&mut *tx).await?;
            accepted += 1;
        }
        tx.commit().await?;
        Ok(json!({"accepted":accepted}))
    }

    pub async fn history_query(&self, input: Value) -> AppResult<Value> {
        self.history_expire().await?;
        let query = text(&input, "query");
        let group = text(&input, "groupId");
        let mut tx = self.pool.begin().await?;
        let revision: i64 = sqlx::query_scalar("SELECT revision FROM history_settings WHERE id=1")
            .fetch_one(&mut *tx)
            .await?;
        let offset = input["offset"].as_i64().unwrap_or(0).max(0);
        let group_ids:Vec<String>=sqlx::query_scalar("SELECT h.group_id FROM history_items h JOIN evidence_refs e ON e.id=h.evidence_id LEFT JOIN history_summaries s ON s.id=h.group_id WHERE (?='' OR h.group_id=?) AND (?='' OR h.observed_at>=?) AND (?='' OR h.observed_at<=?) AND (?='' OR h.app=?) AND (?='' OR h.title LIKE ? OR e.excerpt LIKE ? OR s.content_json LIKE ?) GROUP BY h.group_id ORDER BY MAX(h.observed_at) DESC,h.group_id LIMIT 51 OFFSET ?")
            .bind(group).bind(group).bind(text(&input,"from")).bind(text(&input,"from")).bind(text(&input,"to")).bind(text(&input,"to")).bind(text(&input,"app")).bind(text(&input,"app"))
            .bind(query).bind(format!("%{query}%")).bind(format!("%{query}%")).bind(format!("%{query}%")).bind(offset).fetch_all(&mut *tx).await?;
        let has_more = group_ids.len() > 50;
        let ids: Vec<&String> = group_ids.iter().take(50).collect();
        let rows=sqlx::query("SELECT h.*,CASE WHEN ? THEN e.excerpt ELSE NULL END AS excerpt FROM history_items h JOIN evidence_refs e ON e.id=h.evidence_id WHERE h.group_id IN (SELECT value FROM json_each(?)) ORDER BY h.observed_at DESC")
            .bind(input["includeContent"]==true).bind(json!(ids).to_string()).fetch_all(&mut *tx).await?;
        let summaries=sqlx::query("SELECT id,revision,content_json FROM history_summaries WHERE id IN (SELECT value FROM json_each(?))").bind(json!(ids).to_string()).fetch_all(&mut *tx).await?;
        let summaries: HashMap<String, Value> = summaries
            .into_iter()
            .map(|r| {
                let mut summary: Value =
                    serde_json::from_str(r.get::<&str, _>("content_json")).unwrap_or(json!({}));
                summary["sourceEventCount"] = json!(r.get::<i64, _>("revision"));
                (r.get("id"), summary)
            })
            .collect();
        let mut groups: BTreeMap<String, Value> = BTreeMap::new();
        for row in rows {
            let id: String = row.get("group_id");
            let summary = summaries.get(&id).cloned().unwrap_or(Value::Null);
            let raw: Value = row
                .get::<Option<String>, _>("excerpt")
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(Value::Null);
            let observed: String = row.get("observed_at");
            let entry=groups.entry(id.clone()).or_insert_with(||json!({"id":id,"from":observed,"to":observed,"app":row.get::<String,_>("app"),"title":row.get::<String,_>("title"),"url":row.get::<Option<String>,_>("url"),"coverage":row.get::<String,_>("coverage"),"summary":summary,"events":[],"providers":[]}));
            entry["from"] = json!(observed);
            let provider = json!(row.get::<String, _>("provider"));
            if !entry["providers"].as_array().unwrap().contains(&provider) {
                entry["providers"].as_array_mut().unwrap().push(provider);
            }
            entry["events"].as_array_mut().unwrap().push(json!({"id":row.get::<String,_>("id"),"evidenceRefId":row.get::<String,_>("evidence_id"),"observedAt":observed,"expired":row.get::<i64,_>("expired")!=0,"content":if input["includeContent"]==true {raw}else{Value::Null}}));
        }
        let mut items: Vec<Value> = groups.into_values().collect();
        items.sort_by(|a, b| text(b, "to").cmp(text(a, "to")));
        let reviewed: Vec<String> = sqlx::query_scalar("SELECT group_id FROM history_curation")
            .fetch_all(&mut *tx)
            .await?;
        for item in &mut items {
            item["summaryStale"] = json!(
                item["summary"].is_object()
                    && item["summary"]["sourceEventCount"].as_u64()
                        != Some(item["events"].as_array().unwrap().len() as u64)
            );
            item["memoryReviewed"] = json!(reviewed.iter().any(|id| id == text(item, "id")));
        }
        tx.commit().await?;
        Ok(
            json!({"items":items,"hasMore":has_more,"nextOffset":if has_more{Some(offset+50)}else{None},"revision":revision}),
        )
    }

    pub async fn history_summary(&self, request: Value) -> AppResult<Value> {
        let group = text(&request, "groupId");
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE history_settings SET revision=revision WHERE id=1")
            .execute(&mut *tx)
            .await?;
        let row = sqlx::query("SELECT revision,config_json FROM history_settings WHERE id=1")
            .fetch_one(&mut *tx)
            .await?;
        let config: Value = serde_json::from_str(row.get("config_json"))?;
        if request["revision"].as_i64() != Some(row.get("revision"))
            || config["enabled"] != true
            || config["modelProcessing"] != true
        {
            return Err(AppError::Conflict(
                "记录或模型处理设置已变化，本次整理不再写入。".into(),
            ));
        }
        let ids:Vec<String>=sqlx::query_scalar("SELECT id FROM history_items WHERE group_id=? AND expired=0 AND observed_at>=? ORDER BY id").bind(group).bind((Utc::now()-ChronoDuration::hours(48)).to_rfc3339_opts(SecondsFormat::Millis,true)).fetch_all(&mut *tx).await?;
        let mut expected: Vec<String> = request["eventIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        expected.sort();
        expected.dedup();
        if ids.is_empty() || ids != expected {
            return Err(AppError::Conflict(
                "活动依据已变化，请重新读取后整理。".into(),
            ));
        }
        let count = ids.len() as i64;
        let candidate = &request["summary"];
        if text(candidate, "title").is_empty()
            || text(candidate, "text").is_empty()
            || candidate.to_string().len() > 20000
        {
            return Err(AppError::Invalid(
                "摘要需包含标题、正文，且不能复制整份原文。".into(),
            ));
        }
        let mut content = json!({"title":text(candidate,"title"),"text":text(candidate,"text"),"uncertainty":text(candidate,"uncertainty")});
        if let Some(suggestion) = candidate.get("suggestion") {
            if !matches!(text(suggestion, "kind"), "skill" | "automation")
                || text(suggestion, "title").is_empty()
                || text(suggestion, "prompt").is_empty()
            {
                return Err(AppError::Invalid(
                    "工作方式建议需要类型、标题与可审阅的任务。".into(),
                ));
            }
            content["suggestion"] = json!({"kind":text(suggestion,"kind"),"title":text(suggestion,"title"),"prompt":text(suggestion,"prompt"),"dismissed":false});
        }
        let previous: Option<String> =
            sqlx::query_scalar("SELECT content_json FROM history_summaries WHERE id=?")
                .bind(group)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(previous) = previous {
            let previous: Value = serde_json::from_str(&previous)?;
            if previous["suggestion"]["dismissed"] == true
                || previous["suggestion"]["workflow"].is_object()
            {
                // A model refresh cannot erase a user-reviewed workflow or undo dismissal.
                content["suggestion"] = previous["suggestion"].clone();
            }
        }
        sqlx::query("DELETE FROM history_curation WHERE group_id=?")
            .bind(group)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO history_summaries(id,revision,content_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,content_json=excluded.content_json,updated_at=excluded.updated_at")
            .bind(group).bind(count).bind(content.to_string()).bind(now_iso()).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(json!({"saved":true,"groupId":group}))
    }

    pub async fn history_expire(&self) -> AppResult<Value> {
        let cutoff =
            (Utc::now() - ChronoDuration::hours(48)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE evidence_refs SET excerpt=NULL,raw_event_ids_json='[]',redaction_status='pointer_only' WHERE id IN (SELECT evidence_id FROM history_items WHERE observed_at<?)").bind(&cutoff).execute(&mut *tx).await?;
        let changed=sqlx::query("UPDATE history_items SET title='',url=NULL,expired=1 WHERE observed_at<? AND expired=0").bind(&cutoff).execute(&mut *tx).await?.rows_affected();
        tx.commit().await?;
        if changed > 0 {
            sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
                .execute(&self.pool)
                .await?;
        }
        Ok(json!({"expired":changed}))
    }

    pub async fn history_clear(&self, request: Value) -> AppResult<Value> {
        let _file_guard = self.history_file_lock.lock().await;
        if request["confirm"] != "删除记录" {
            return Err(AppError::Invalid("清理需要确认删除范围。".into()));
        }
        let from = if text(&request, "from").is_empty() {
            "1970-01-01T00:00:00.000Z"
        } else {
            text(&request, "from")
        };
        let to = if text(&request, "to").is_empty() {
            now_iso()
        } else {
            text(&request, "to").into()
        };
        chrono::DateTime::parse_from_rfc3339(from)
            .map_err(|_| AppError::Invalid("开始时间无效。".into()))?;
        chrono::DateTime::parse_from_rfc3339(&to)
            .map_err(|_| AppError::Invalid("结束时间无效。".into()))?;
        if from > to.as_str() {
            return Err(AppError::Invalid("开始时间不能晚于结束时间。".into()));
        }
        let app = request.get("app").and_then(Value::as_str);
        let group = request.get("groupId").and_then(Value::as_str);
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE history_settings SET revision=revision+1 WHERE id=1")
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO history_deletions(id,from_time,to_time,app,group_id,created_at) VALUES(?,?,?,?,?,?)").bind(new_id("deletion")).bind(from).bind(&to).bind(app).bind(group).bind(now_iso()).execute(&mut *tx).await?;
        let rows=sqlx::query("SELECT id,evidence_id,source_id,group_id FROM history_items WHERE observed_at>=? AND observed_at<=? AND (? IS NULL OR app=?) AND (? IS NULL OR group_id=?)")
            .bind(from).bind(to).bind(app).bind(app).bind(group).bind(group).fetch_all(&mut *tx).await?;
        let refs: Vec<String> = rows.iter().map(|r| r.get("evidence_id")).collect();
        let refs_json = json!(refs).to_string();
        let affected:Vec<String>=sqlx::query_scalar("SELECT DISTINCT node_id FROM node_evidence_links WHERE evidence_ref_id IN (SELECT value FROM json_each(?))").bind(&refs_json).fetch_all(&mut *tx).await?;
        for node in &affected {
            let remaining:i64=sqlx::query_scalar("SELECT COUNT(*) FROM node_evidence_links l JOIN evidence_refs e ON e.id=l.evidence_ref_id WHERE l.node_id=? AND e.retracted_at IS NULL AND l.evidence_ref_id NOT IN (SELECT value FROM json_each(?))").bind(node).bind(&refs_json).fetch_one(&mut *tx).await?;
            sqlx::query("UPDATE nodes SET status=?,deleted_at=?,statement=NULL,label=?,payload_json='{\"historyReviewRequired\":true}' WHERE id=?")
                .bind(if remaining>0{"unsupported"}else{"revoked"}).bind(if remaining>0{None}else{Some(now_iso())})
                .bind(if remaining>0{"依据已变化，等待复核"}else{"已清理的记录"}).bind(node).execute(&mut *tx).await?;
            // Reversible journal snapshots must not resurrect deleted text.
            sqlx::query("UPDATE change_sets SET reversible=0 WHERE id IN (SELECT change_set_id FROM change_operations WHERE target_ref=?)").bind(node).execute(&mut *tx).await?;
            sqlx::query("UPDATE change_operations SET before_json=NULL,after_json=NULL,inverse_json=NULL WHERE target_ref=?").bind(node).execute(&mut *tx).await?;
        }
        for row in &rows {
            let evidence: &str = row.get("evidence_id");
            let source: &str = row.get("source_id");
            // Remove content while retaining referential identities, so other
            // independently supported knowledge is not deleted by accident.
            sqlx::query("UPDATE nodes SET status='revoked',deleted_at=?,statement=NULL,label='已清理的记录',payload_json='{}' WHERE id IN (SELECT node_id FROM node_evidence_links WHERE evidence_ref_id=?) AND NOT EXISTS (SELECT 1 FROM node_evidence_links l JOIN evidence_refs e ON e.id=l.evidence_ref_id WHERE l.node_id=nodes.id AND l.evidence_ref_id<>? AND e.retracted_at IS NULL)")
                .bind(now_iso()).bind(evidence).bind(evidence).execute(&mut *tx).await?;
            sqlx::query("UPDATE evidence_refs SET excerpt=NULL,retracted_at=?,raw_event_ids_json='[]',redaction_status='pointer_only' WHERE id=?").bind(now_iso()).bind(evidence).execute(&mut *tx).await?;
            sqlx::query("UPDATE source_records SET deleted_at=?,metadata_json='{}',storage_uri=NULL WHERE id=?").bind(now_iso()).bind(source).execute(&mut *tx).await?;
            sqlx::query("DELETE FROM history_summaries WHERE id=?")
                .bind(row.get::<&str, _>("group_id"))
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE history_memories SET status='review', statement='',updated_at=? WHERE EXISTS (SELECT 1 FROM json_each(groups_json) WHERE value=?)").bind(now_iso()).bind(row.get::<&str,_>("group_id")).execute(&mut *tx).await?;
            sqlx::query("DELETE FROM history_curation WHERE group_id=?")
                .bind(row.get::<&str, _>("group_id"))
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM history_items WHERE id=?")
                .bind(row.get::<&str, _>("id"))
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&self.pool)
            .await?;
        self.write_history_memory_file().await?;
        Ok(json!({"deleted":rows.len(),"upstreamUnchanged":true,"existingChatsUnchanged":true}))
    }

    pub(super) async fn history_memory_rows(&self, request: Value) -> AppResult<Value> {
        match text(&request, "action") {
            "review" | "remove" => {
                let mut tx = self.pool.begin().await?;
                sqlx::query("UPDATE history_settings SET revision=revision+1 WHERE id=1")
                    .execute(&mut *tx)
                    .await?;
                let statement = text(&request, "statement").trim();
                if text(&request, "action") == "review"
                    && (statement.is_empty() || statement.len() > 6000)
                {
                    return Err(AppError::Invalid("请输入要保留的认识。".into()));
                }
                let changed = sqlx::query(
                    "UPDATE history_memories SET statement=?,status=?,updated_at=? WHERE id=?",
                )
                .bind(if text(&request, "action") == "remove" {
                    ""
                } else {
                    statement
                })
                .bind(if text(&request, "action") == "remove" {
                    "rejected"
                } else {
                    "user_corrected"
                })
                .bind(now_iso())
                .bind(text(&request, "id"))
                .execute(&mut *tx)
                .await?
                .rows_affected();
                if changed == 0 {
                    return Err(AppError::Invalid("这条认识已不存在，请刷新。".into()));
                }
                tx.commit().await?;
            }
            "save" => {
                let mut tx = self.pool.begin().await?;
                sqlx::query("UPDATE history_settings SET revision=revision WHERE id=1")
                    .execute(&mut *tx)
                    .await?;
                let row =
                    sqlx::query("SELECT revision,config_json FROM history_settings WHERE id=1")
                        .fetch_one(&mut *tx)
                        .await?;
                let config: Value = serde_json::from_str(row.get("config_json"))?;
                if request["revision"].as_i64() != Some(row.get("revision"))
                    || config["modelProcessing"] != true
                    || config["enabled"] != true
                {
                    return Err(AppError::Conflict("记录设置或依据已变化。".into()));
                }
                let groups = request["groupIds"]
                    .as_array()
                    .filter(|v| !v.is_empty() && v.len() <= 30)
                    .ok_or_else(|| AppError::Invalid("请选择认识对应的活动依据。".into()))?;
                for group in groups {
                    let exists: i64 =
                        sqlx::query_scalar("SELECT COUNT(*) FROM history_summaries WHERE id=?")
                            .bind(group.as_str().unwrap_or(""))
                            .fetch_one(&mut *tx)
                            .await?;
                    if exists == 0 {
                        return Err(AppError::Conflict("活动摘要已删除或变化。".into()));
                    }
                }
                let memories = request["memories"]
                    .as_array()
                    .filter(|v| v.len() <= 10)
                    .ok_or_else(|| AppError::Invalid("认识内容无效。".into()))?;
                for memory in memories {
                    let statement = text(memory, "statement").trim();
                    let refs = memory["groupIds"]
                        .as_array()
                        .ok_or_else(|| AppError::Invalid("每条认识必须关联活动。".into()))?;
                    if statement.is_empty()
                        || statement.len() > 6000
                        || refs.is_empty()
                        || refs.iter().any(|v| !groups.contains(v))
                    {
                        return Err(AppError::Invalid("认识或关联活动无效。".into()));
                    }
                    let mut keys: Vec<&str> = refs.iter().filter_map(Value::as_str).collect();
                    keys.sort();
                    // User correction/rejection owns this source set. An automatic
                    // retry cannot resurrect its previous interpretation.
                    let id = format!("memory_{}", hash(&keys.join(",")));
                    sqlx::query("INSERT INTO history_memories(id,statement,groups_json,status,updated_at) VALUES(?,?,?,'observation',?) ON CONFLICT(id) DO UPDATE SET statement=excluded.statement,updated_at=excluded.updated_at WHERE history_memories.status='observation'")
                .bind(id).bind(statement).bind(json!(keys).to_string()).bind(now_iso()).execute(&mut *tx).await?;
                }
                for group in groups {
                    sqlx::query(
                        "INSERT OR REPLACE INTO history_curation(group_id,updated_at) VALUES(?,?)",
                    )
                    .bind(group.as_str().unwrap_or(""))
                    .bind(now_iso())
                    .execute(&mut *tx)
                    .await?;
                }
                tx.commit().await?;
            }
            "list" => {}
            _ => return Err(AppError::Invalid("认识操作无效。".into())),
        }
        let rows=sqlx::query("SELECT * FROM history_memories WHERE status NOT IN ('rejected','review') ORDER BY updated_at DESC,id").fetch_all(&self.pool).await?;
        let items:Vec<Value>=rows.iter().map(|row|json!({"id":row.get::<&str,_>("id"),"statement":row.get::<&str,_>("statement"),"status":row.get::<&str,_>("status"),"groupIds":serde_json::from_str::<Value>(row.get("groups_json")).unwrap_or(json!([])),"updatedAt":row.get::<&str,_>("updated_at")})).collect();
        Ok(json!({"items":items}))
    }

    pub async fn history_suggestion(&self, request: Value) -> AppResult<Value> {
        if !matches!(text(&request, "action"), "dismiss" | "restore") {
            return Err(AppError::Invalid("建议操作无效。".into()));
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE history_settings SET revision=revision+1 WHERE id=1")
            .execute(&mut *tx)
            .await?;
        let changed=sqlx::query("UPDATE history_summaries SET content_json=json_set(content_json,'$.suggestion.dismissed',json(?)) WHERE id=? AND json_type(content_json,'$.suggestion')='object'")
            .bind(if text(&request,"action")=="dismiss"{"true"}else{"false"}).bind(text(&request,"groupId")).execute(&mut *tx).await?.rows_affected();
        if changed == 0 {
            return Err(AppError::NotFound("这条建议已不存在。".into()));
        }
        tx.commit().await?;
        Ok(json!({"saved":true}))
    }
}
use std::collections::BTreeMap;
