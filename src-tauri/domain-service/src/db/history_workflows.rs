//! User-reviewed reusable work stays attached to its source suggestion. Deleting
//! that source removes the workflow as part of the same database transaction.
use super::*;

impl Database {
    pub async fn history_workflow(&self, request: Value) -> AppResult<Value> {
        let action = request["action"].as_str().unwrap_or("list");
        if action != "list" {
            let group = request["groupId"]
                .as_str()
                .ok_or_else(|| AppError::Invalid("请选择建议的来源活动。".into()))?;
            let mut tx = self.pool.begin().await?;
            sqlx::query("UPDATE history_settings SET revision=revision WHERE id=1")
                .execute(&mut *tx)
                .await?;
            let raw: Option<String> =
                sqlx::query_scalar("SELECT content_json FROM history_summaries WHERE id=?")
                    .bind(group)
                    .fetch_optional(&mut *tx)
                    .await?;
            let mut content: Value = serde_json::from_str(
                &raw.ok_or_else(|| AppError::NotFound("这项活动或建议已清理。".into()))?,
            )?;
            if !content["suggestion"].is_object() {
                return Err(AppError::Invalid("这项活动没有工作流建议。".into()));
            }
            let mut workflow = content["suggestion"]["workflow"].clone();
            if action != "prepare"
                && (!workflow.is_object() || workflow["version"] != request["version"])
            {
                return Err(AppError::Conflict("工作方式已变化，请刷新后再试。".into()));
            }
            match action {
                "prepare" => {
                    if !workflow.is_object() {
                        workflow = json!({"groupId":group,"version":Uuid::new_v4().to_string(),"title":content["suggestion"]["title"],
                        "prompt":content["suggestion"]["prompt"],"cadence":"manual","at":"09:00","weekday":1,"state":"draft"});
                    }
                }
                "save" => {
                    for key in ["title", "prompt"] {
                        let value = request[key].as_str().unwrap_or("").trim();
                        if value.is_empty() || value.len() > 12000 {
                            return Err(AppError::Invalid(
                                "请填写工作方式名称和要完成的内容。".into(),
                            ));
                        }
                        workflow[key] = json!(value);
                    }
                    if !matches!(
                        request["cadence"].as_str(),
                        Some("manual" | "daily" | "weekly")
                    ) {
                        return Err(AppError::Invalid("运行方式无效。".into()));
                    }
                    let at = request["at"].as_str().unwrap_or("");
                    chrono::NaiveTime::parse_from_str(at, "%H:%M")
                        .map_err(|_| AppError::Invalid("请选择有效的运行时间。".into()))?;
                    if !(0..=6).contains(&request["weekday"].as_i64().unwrap_or(-1)) {
                        return Err(AppError::Invalid("请选择星期。".into()));
                    }
                    for key in ["cadence", "at", "weekday"] {
                        workflow[key] = request[key].clone();
                    }
                    workflow["version"] = json!(Uuid::new_v4().to_string());
                    workflow["state"] = json!("draft");
                    for key in ["trialRunId", "lastRunId", "lastScheduleKey"] {
                        workflow.as_object_mut().unwrap().remove(key);
                    }
                }
                "markRun" => {
                    let id = request["runId"]
                        .as_str()
                        .filter(|id| !id.is_empty() && id.len() < 150)
                        .ok_or_else(|| AppError::Invalid("试用任务无效。".into()))?;
                    workflow["lastRunId"] = json!(id);
                    if request["trial"] == true {
                        workflow["trialRunId"] = json!(id);
                    }
                    if let Some(key) = request["scheduleKey"].as_str() {
                        workflow["lastScheduleKey"] = json!(key);
                    }
                }
                "enable" => {
                    if request["trialRunId"].as_str().is_none()
                        || workflow["trialRunId"] != request["trialRunId"]
                    {
                        return Err(AppError::Invalid("请先试用当前草稿并检查结果。".into()));
                    }
                    workflow["state"] = json!("enabled");
                }
                "disable" => workflow["state"] = json!("disabled"),
                "remove" => workflow = Value::Null,
                _ => return Err(AppError::Invalid("工作方式操作无效。".into())),
            }
            content["suggestion"]["workflow"] = workflow;
            sqlx::query("UPDATE history_summaries SET content_json=? WHERE id=?")
                .bind(content.to_string())
                .bind(group)
                .execute(&mut *tx)
                .await?;
            if action != "markRun" {
                sqlx::query("UPDATE history_settings SET revision=revision+1 WHERE id=1")
                    .execute(&mut *tx)
                    .await?;
            }
            tx.commit().await?;
        }
        let rows:Vec<String>=sqlx::query_scalar("SELECT json_extract(content_json,'$.suggestion.workflow') FROM history_summaries WHERE json_type(content_json,'$.suggestion.workflow')='object' ORDER BY updated_at DESC").fetch_all(&self.pool).await?;
        let items: Vec<Value> = rows
            .iter()
            .map(|value| serde_json::from_str(value))
            .collect::<Result<_, _>>()?;
        Ok(json!({"items":items}))
    }
}
