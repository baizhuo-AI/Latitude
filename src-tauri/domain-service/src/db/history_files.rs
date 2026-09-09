//! An editable local projection of source-backed memories. The database remains
//! authoritative; a file can correct existing entries, never invent provenance.
use super::*;

fn digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

impl Database {
    pub fn history_memory_path(&self) -> PathBuf {
        self.path
            .parent()
            .unwrap_or(Path::new("."))
            .join("computer-history-memory")
            .join("memories.json")
    }

    async fn memory_document(&self) -> AppResult<Value> {
        let result = self.history_memory_rows(json!({"action":"list"})).await?;
        let entries: Vec<Value> = result["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| {
                let mut entry = item.clone();
                entry["forget"] = json!(false);
                entry
            })
            .collect();
        let entries = json!(entries);
        Ok(json!({"format":"latitude-computer-history-memory/v1",
            "instructions":"只修改 statement，或把 forget 改为 true 来忘记。保留其余字段和所有条目。有效修改会同步到维度；格式损坏时在设置中恢复有效版本。",
            "baseToken":digest(&entries), "originalHash":digest(&entries), "memories":entries}))
    }

    async fn safe_memory_directory(&self) -> AppResult<()> {
        let file = self.history_memory_path();
        let directory = file.parent().unwrap();
        if let Ok(metadata) = tokio::fs::symlink_metadata(directory).await {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(AppError::Invalid("记忆目录不能是链接或普通文件。".into()));
            }
        }
        tokio::fs::create_dir_all(directory).await?;
        secure_private_directory(directory).await?;
        Ok(())
    }

    async fn write_memory_document(&self, document: &Value, recovery_only: bool) -> AppResult<()> {
        self.safe_memory_directory().await?;
        let file = self.history_memory_path();
        for name in if recovery_only {
            vec!["last-valid.json"]
        } else {
            vec!["last-valid.json", "memories.json"]
        } {
            let target = file.parent().unwrap().join(name);
            if let Ok(metadata) = tokio::fs::symlink_metadata(&target).await {
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err(AppError::Invalid("记忆文件不能是目录或链接。".into()));
                }
            }
            let temporary = file
                .parent()
                .unwrap()
                .join(format!(".{}.tmp", Uuid::new_v4()));
            let mut options = tokio::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            let mut output = options.open(&temporary).await?;
            use tokio::io::AsyncWriteExt;
            output
                .write_all(serde_json::to_string_pretty(document)?.as_bytes())
                .await?;
            output.sync_all().await?;
            drop(output);
            tokio::fs::rename(&temporary, &target).await?;
        }
        Ok(())
    }

    pub(super) async fn write_history_memory_file(&self) -> AppResult<()> {
        self.write_memory_document(&self.memory_document().await?, false)
            .await
    }

    async fn sync_history_memory_file(&self) -> AppResult<Option<String>> {
        self.safe_memory_directory().await?;
        let file = self.history_memory_path();
        let current = self.memory_document().await?;
        let metadata = match tokio::fs::symlink_metadata(&file).await {
            Ok(value) => value,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                self.write_memory_document(&current, false).await?;
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > 4 * 1024 * 1024
        {
            return Ok(Some(
                "记忆文件必须是可读取的普通 JSON 文件。应用保留了有效认识。".into(),
            ));
        }
        let parsed = tokio::fs::read(&file).await?;
        let edited: Value = match serde_json::from_slice(&parsed) {
            Ok(value) => value,
            Err(_) => {
                self.write_memory_document(&current, true).await?;
                return Ok(Some(
                    "记忆文件的 JSON 格式损坏，修改尚未同步。请修复文件，或恢复应用中的有效版本。"
                        .into(),
                ));
            }
        };
        if edited == current {
            return Ok(None);
        }
        // An unchanged older projection may simply lag a database change.
        if edited["originalHash"].as_str() == Some(digest(&edited["memories"]).as_str()) {
            self.write_memory_document(&current, false).await?;
            return Ok(None);
        }
        let validate = || -> Result<Vec<(String, String, bool)>, String> {
            if edited["format"] != current["format"] || edited["baseToken"] != current["baseToken"]
            {
                return Err("文件修改基于旧版本，尚未覆盖应用中的认识。请对照有效版本后重新修改，或恢复有效版本。".into());
            }
            let entries = edited["memories"]
                .as_array()
                .ok_or("memories 必须保留为列表。")?;
            let originals = current["memories"].as_array().unwrap();
            if entries.len() != originals.len() {
                return Err("请保留全部条目；忘记某条认识请将其 forget 改为 true。".into());
            }
            let mut seen = std::collections::HashSet::new();
            let mut changes = Vec::new();
            for item in entries {
                let id = item["id"].as_str().ok_or("条目 id 无效。")?;
                if !seen.insert(id) {
                    return Err("条目 id 重复。".into());
                }
                let original = originals
                    .iter()
                    .find(|old| old["id"] == item["id"])
                    .ok_or("条目来源已不存在。")?;
                let statement = item["statement"]
                    .as_str()
                    .ok_or("statement 必须是文字。")?
                    .trim();
                let forget = item["forget"]
                    .as_bool()
                    .ok_or("forget 必须为 true 或 false。")?;
                if !forget && (statement.is_empty() || statement.len() > 6000) {
                    return Err("认识内容为空或过长。".into());
                }
                let mut normalized = item.clone();
                normalized["statement"] = original["statement"].clone();
                normalized["forget"] = original["forget"].clone();
                if normalized != *original {
                    return Err("只能修改 statement 或 forget，来源和状态由维度管理。".into());
                }
                if forget || item["statement"] != original["statement"] {
                    changes.push((id.to_string(), statement.to_string(), forget));
                }
            }
            Ok(changes)
        };
        let changes = match validate() {
            Ok(value) => value,
            Err(error) => {
                self.write_memory_document(&current, true).await?;
                return Ok(Some(error));
            }
        };
        let mut tx = self.pool.begin().await?;
        // Serialize file corrections with in-flight summary/memory commits.
        sqlx::query("UPDATE history_settings SET revision=revision+1 WHERE id=1")
            .execute(&mut *tx)
            .await?;
        for (id, statement, forget) in changes {
            sqlx::query("UPDATE history_memories SET statement=?,status=?,updated_at=? WHERE id=?")
                .bind(if forget { "" } else { statement.as_str() })
                .bind(if forget { "rejected" } else { "user_corrected" })
                .bind(now_iso())
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        self.write_history_memory_file().await?;
        Ok(None)
    }

    pub async fn history_memory(&self, request: Value) -> AppResult<Value> {
        let _guard = self.history_file_lock.lock().await;
        let restoring = request["action"] == "restoreFile";
        let error = if restoring {
            None
        } else {
            self.sync_history_memory_file().await?
        };
        let mut result = self
            .history_memory_rows(if restoring {
                json!({"action":"list"})
            } else {
                request.clone()
            })
            .await?;
        // Preserve invalid edits for repair; the user can explicitly restore.
        if restoring || (error.is_none() && request["action"] != "list") {
            self.write_history_memory_file().await?;
        } else if error.is_some() {
            self.write_memory_document(&self.memory_document().await?, true)
                .await?;
        }
        result["memoryFile"] = json!({"path":self.history_memory_path(),"error":error,
            "recoveryPath":self.history_memory_path().parent().unwrap().join("last-valid.json")});
        Ok(result)
    }
}
