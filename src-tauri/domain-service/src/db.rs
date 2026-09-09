mod history;
mod history_files;
mod history_workflows;
use crate::{
    error::{AppError, AppResult},
    models::{
        ActionRequest, ApplyFeedbackRequest, ApplyLocationRequest, AuditContext,
        CandidateCommandRequest, CandidateCreateRequest, CompileContextRequest,
        ComputerHistoryEvidenceRequest, ContextRequest, EvidenceQueryRequest, EvidenceReadRequest,
        ExportDocument, LocateEventRequest, MessageEvidenceRequest, MutationResponse,
        OutcomeRequest, RelationshipRequest, RememberRequest, ResolveRevisionRequest,
        RetractRequest, RollbackRequest, UpdateRequest, WebEvidenceRequest, WeeklyReviewRequest,
    },
};
use chrono::{Datelike, Duration as ChronoDuration, Local, SecondsFormat, TimeZone, Utc};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    QueryBuilder, Row, Sqlite, SqlitePool, Transaction,
};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::ErrorKind,
    path::{Path, PathBuf},
    str::FromStr,
    time::Duration,
};
use url::Url;
use uuid::Uuid;

const CURRENT_SCHEMA_VERSION: &str = "5";
const STARTUP_BACKUP_RETENTION: usize = 10;
const MIGRATIONS: &[(i64, &str, &str)] = &[
    (
        1,
        "constellation-v0.1",
        include_str!("../migrations/0001_constellation_v0_1.sql"),
    ),
    (
        2,
        "runtime-extensions",
        include_str!("../migrations/0002_runtime_extensions.sql"),
    ),
    (
        3,
        "semantic-closure",
        include_str!("../migrations/0003_semantic_closure.sql"),
    ),
    (
        4,
        "raw-evidence-boundary",
        include_str!("../migrations/0004_raw_evidence_boundary.sql"),
    ),
    (
        5,
        "computer-history",
        include_str!("../migrations/0005_computer_history.sql"),
    ),
];

const NODE_KINDS: &[&str] = &[
    "evidence_event",
    "observation",
    "claim",
    "tension",
    "decision",
    "experiment",
    "action",
    "outcome",
    "topic",
    "goal",
    "project",
    "method",
    "interest",
    "value",
    "boundary",
    "resource",
    "question",
    "insight",
];
const NODE_STATUSES: &[&str] = &[
    "proposed",
    "active",
    "shaping",
    "parked",
    "concluded",
    "disputed",
    "scoped",
    "unsupported",
    "superseded",
    "expired",
    "rejected",
    "revoked",
    "deleted",
];
const SENSITIVITIES: &[&str] = &["low", "medium", "high", "highest"];
const EVIDENCE_EVENT_TYPES: &[&str] = &["message", "activity"];
const EVIDENCE_SAMPLING_MODES: &[&str] = &["recent", "source_balanced"];
const SOURCE_TYPES: &[&str] = &[
    "computer_history",
    "chat",
    "quick_note",
    "checkin",
    "schedule",
    "feed_feedback",
    "audio",
    "transcript",
    "import",
    "web_search",
];

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct NodeRecord {
    id: String,
    schema_version: String,
    kind: String,
    layer: String,
    label: String,
    statement: Option<String>,
    #[serde(rename = "payload")]
    payload_json: String,
    status: String,
    authority: String,
    origin: String,
    #[serde(rename = "scope")]
    scope_json: String,
    scope_key: String,
    sensitivity: String,
    valid_from: Option<String>,
    valid_to: Option<String>,
    recorded_at: String,
    superseded_at: Option<String>,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
    expected_outcome: Option<String>,
    review_at: Option<String>,
    outcome: Option<String>,
}

impl NodeRecord {
    fn to_value(&self) -> Value {
        let mut value = serde_json::to_value(self).unwrap_or_else(|_| json!({}));
        if let Some(object) = value.as_object_mut() {
            object.insert(
                "payload".into(),
                serde_json::from_str(&self.payload_json).unwrap_or_else(|_| json!({})),
            );
            object.insert(
                "scope".into(),
                serde_json::from_str(&self.scope_json).unwrap_or_else(|_| json!({})),
            );
            if self.kind == "action" {
                if let Ok(payload) = serde_json::from_str::<Value>(&self.payload_json) {
                    if let Some(trigger) = payload.get("trigger") {
                        object.insert("trigger".into(), trigger.clone());
                    }
                    if let Some(window) = payload.get("observationWindow") {
                        object.insert("observationWindow".into(), window.clone());
                    }
                }
            }
        }
        value
    }
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct EdgeRecord {
    id: String,
    schema_version: String,
    from_node_id: String,
    to_node_id: String,
    family: String,
    relation_type: String,
    direction: String,
    proximity: String,
    strength: String,
    basis: String,
    authority: String,
    status: String,
    rationale: Option<String>,
    #[serde(rename = "scope")]
    scope_json: String,
    scope_key: String,
    valid_from: Option<String>,
    valid_to: Option<String>,
    recorded_at: String,
    superseded_at: Option<String>,
    created_at: String,
    updated_at: String,
}

struct NewNode<'a> {
    id: &'a str,
    kind: &'a str,
    label: &'a str,
    statement: Option<&'a str>,
    payload: &'a Value,
    scope: &'a Value,
    sensitivity: &'a str,
    expected_outcome: Option<&'a str>,
    review_at: Option<&'a str>,
    outcome: Option<&'a str>,
    status: &'a str,
    now: &'a str,
}

impl EdgeRecord {
    fn to_value(&self) -> Value {
        let mut value = serde_json::to_value(self).unwrap_or_else(|_| json!({}));
        if let Some(object) = value.as_object_mut() {
            object.insert(
                "scope".into(),
                serde_json::from_str(&self.scope_json).unwrap_or_else(|_| json!({})),
            );
        }
        value
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenReport {
    pub schema_version: String,
    pub migrations_applied: Vec<i64>,
    pub startup_backup: Option<PathBuf>,
    pub startup_backups_pruned: Vec<PathBuf>,
}

#[derive(Clone)]
pub struct Database {
    pool: SqlitePool,
    path: PathBuf,
    backup_dir: PathBuf,
    history_file_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
}

#[derive(Debug, Clone)]
pub struct IdempotencyContext {
    pub key: String,
    pub route: String,
    pub request_hash: String,
}

impl IdempotencyContext {
    pub fn for_request<T: Serialize>(key: &str, route: &str, request: &T) -> AppResult<Self> {
        validate_non_empty("Idempotency-Key", key)?;
        let payload = serde_json::to_vec(request)?;
        let request_hash = format!("{:x}", Sha256::digest(payload));
        Ok(Self {
            key: key.to_string(),
            route: route.to_string(),
            request_hash,
        })
    }
}

impl Database {
    pub async fn open(
        path: impl AsRef<Path>,
        backup_dir: impl AsRef<Path>,
    ) -> AppResult<(Self, OpenReport)> {
        let path = path.as_ref().to_path_buf();
        let backup_dir = backup_dir.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
            secure_private_directory(parent).await?;
        }
        tokio::fs::create_dir_all(&backup_dir).await?;
        secure_private_directory(&backup_dir).await?;

        let existing_database = match tokio::fs::symlink_metadata(&path).await {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(AppError::Invalid(
                        "database path must be a regular non-symlink file".into(),
                    ));
                }
                secure_private_file(&path).await?;
                Some(metadata)
            }
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };

        let will_create_startup_backup =
            existing_database.is_some_and(|metadata| metadata.len() > 0);
        let startup_backups_pruned = Self::prune_startup_backups(
            &path,
            &backup_dir,
            STARTUP_BACKUP_RETENTION - usize::from(will_create_startup_backup),
        )
        .await?;
        let startup_backup = if will_create_startup_backup {
            Some(Self::backup_files(&path, &backup_dir, "startup").await?)
        } else {
            None
        };

        let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .pragma("secure_delete", "ON")
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            // A single local connection makes the destructive maintenance sequence
            // (checkpoint -> journal_mode=DELETE -> VACUUM) lock-free and deterministic.
            // HTTP concurrency still queues safely at the domain boundary.
            .max_connections(1)
            .connect_with(options)
            .await?;
        sqlx::query("PRAGMA synchronous=NORMAL")
            .execute(&pool)
            .await?;

        let applied = Self::migrate(&pool).await?;
        secure_private_file(&path).await?;
        for suffix in ["-wal", "-shm"] {
            let sidecar = PathBuf::from(format!("{}{suffix}", path.display()));
            match tokio::fs::symlink_metadata(&sidecar).await {
                Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                    secure_private_file(&sidecar).await?;
                }
                Ok(_) => {
                    return Err(AppError::Invalid(format!(
                        "database sidecar {} must be a regular non-symlink file",
                        sidecar.display()
                    )));
                }
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        let database = Self {
            pool,
            path,
            backup_dir,
            history_file_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        };
        Ok((
            database,
            OpenReport {
                schema_version: CURRENT_SCHEMA_VERSION.into(),
                migrations_applied: applied,
                startup_backup,
                startup_backups_pruned,
            },
        ))
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    async fn migrate(pool: &SqlitePool) -> AppResult<Vec<i64>> {
        let mut bootstrap = pool.begin().await?;
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS schema_migrations (\
             version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
        )
        .execute(&mut *bootstrap)
        .await?;
        bootstrap.commit().await?;

        let mut newly_applied = Vec::new();
        for (version, name, sql) in MIGRATIONS {
            let exists: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM schema_migrations WHERE version = ?")
                    .bind(version)
                    .fetch_one(pool)
                    .await?;
            if exists > 0 {
                continue;
            }

            let mut tx = pool.begin().await?;
            sqlx::raw_sql(sql).execute(&mut *tx).await?;
            let now = now_iso();
            sqlx::query(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
            )
            .bind(version)
            .bind(name)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO schema_meta(key, value, updated_at) VALUES \
                 ('constellation_schema_version', ?, ?) \
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            )
            .bind(version.to_string())
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            newly_applied.push(*version);
        }
        Ok(newly_applied)
    }

    async fn backup_files(path: &Path, backup_dir: &Path, reason: &str) -> AppResult<PathBuf> {
        tokio::fs::create_dir_all(backup_dir).await?;
        secure_private_directory(backup_dir).await?;
        let database_metadata = tokio::fs::symlink_metadata(path).await?;
        if database_metadata.file_type().is_symlink() || !database_metadata.is_file() {
            return Err(AppError::Invalid(
                "database backup source must be a regular non-symlink file".into(),
            ));
        }
        let stamp = Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
        let filename = path
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("latitude.db");
        let target = backup_dir.join(format!("{filename}.{stamp}.{reason}.bak"));
        tokio::fs::copy(path, &target).await?;
        secure_private_file(&target).await?;

        for suffix in ["-wal", "-shm"] {
            let sidecar = PathBuf::from(format!("{}{suffix}", path.display()));
            match tokio::fs::symlink_metadata(&sidecar).await {
                Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                    let target_sidecar = PathBuf::from(format!("{}{suffix}", target.display()));
                    tokio::fs::copy(&sidecar, &target_sidecar).await?;
                    secure_private_file(&target_sidecar).await?;
                }
                Ok(_) => {
                    return Err(AppError::Invalid(format!(
                        "database sidecar {} must be a regular non-symlink file",
                        sidecar.display()
                    )));
                }
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        // Automatic database backups must not become an unbounded second
        // history store. Keep identities/tombstones, omit activity contents.
        let copy = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(&target))
            .await?;
        let has_history: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='history_items'",
        )
        .fetch_one(&copy)
        .await?;
        if has_history > 0 {
            sqlx::query("PRAGMA secure_delete=ON")
                .execute(&copy)
                .await?;
            sqlx::query("UPDATE evidence_refs SET excerpt=NULL,raw_event_ids_json='[]',redaction_status='pointer_only' WHERE processor_name='latitude-history'").execute(&copy).await?;
            for table in [
                "history_items",
                "history_summaries",
                "history_memories",
                "history_curation",
            ] {
                sqlx::query(&format!("DELETE FROM {table}"))
                    .execute(&copy)
                    .await?;
            }
            sqlx::query("UPDATE history_settings SET config_json='{}',status_json='{}'")
                .execute(&copy)
                .await?;
            sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
                .execute(&copy)
                .await?;
            sqlx::query("VACUUM").execute(&copy).await?;
        }
        copy.close().await;
        Ok(target)
    }

    async fn prune_startup_backups(
        path: &Path,
        backup_dir: &Path,
        keep: usize,
    ) -> AppResult<Vec<PathBuf>> {
        let filename = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("latitude-domain.db");
        let prefix = format!("{filename}.");
        let suffix = ".startup.bak";
        let mut entries = tokio::fs::read_dir(backup_dir).await?;
        let mut primaries = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(stamp) = name
                .strip_prefix(&prefix)
                .and_then(|value| value.strip_suffix(suffix))
            else {
                continue;
            };
            if !is_backup_timestamp(stamp) {
                continue;
            }
            let metadata = tokio::fs::symlink_metadata(entry.path()).await?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(AppError::Invalid(format!(
                    "startup backup {} must be a regular non-symlink file",
                    entry.path().display()
                )));
            }
            primaries.push((name, entry.path()));
        }
        primaries.sort_by(|left, right| left.0.cmp(&right.0));
        let remove_count = primaries.len().saturating_sub(keep);
        let obsolete: Vec<PathBuf> = primaries
            .into_iter()
            .take(remove_count)
            .map(|(_, path)| path)
            .collect();

        // Validate the complete obsolete group before removing any member. A
        // forged directory or symlink must stop retention rather than expand
        // deletion beyond files created by this service.
        let mut artifacts = Vec::new();
        for primary in &obsolete {
            for artifact in [
                PathBuf::from(format!("{}-wal", primary.display())),
                PathBuf::from(format!("{}-shm", primary.display())),
                primary.clone(),
            ] {
                match tokio::fs::symlink_metadata(&artifact).await {
                    Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                        artifacts.push(artifact);
                    }
                    Ok(_) => {
                        return Err(AppError::Invalid(format!(
                            "startup backup artifact {} must be a regular non-symlink file",
                            artifact.display()
                        )));
                    }
                    Err(error) if error.kind() == ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
        for artifact in artifacts {
            tokio::fs::remove_file(artifact).await?;
        }
        Ok(obsolete)
    }

    pub async fn create_backup(&self, reason: &str) -> AppResult<PathBuf> {
        sqlx::query("PRAGMA wal_checkpoint(FULL)")
            .execute(&self.pool)
            .await?;
        Self::backup_files(&self.path, &self.backup_dir, reason).await
    }

    pub async fn health(&self) -> AppResult<Value> {
        let schema_version: Option<String> = sqlx::query_scalar(
            "SELECT value FROM schema_meta WHERE key='constellation_schema_version'",
        )
        .fetch_optional(&self.pool)
        .await?;
        let node_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM nodes WHERE deleted_at IS NULL")
                .fetch_one(&self.pool)
                .await?;
        let pending_revisions: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM claim_revision_queue WHERE status='pending'")
                .fetch_one(&self.pool)
                .await?;
        Ok(json!({
            "ok": true,
            "status": "ready",
            "schemaVersion": schema_version.unwrap_or_else(|| "unknown".into()),
            "nodeCount": node_count,
            "pendingRevisions": pending_revisions
        }))
    }

    pub async fn context(&self, request: ContextRequest) -> AppResult<Value> {
        validate_choice(
            "sensitivityCeiling",
            &request.sensitivity_ceiling,
            SENSITIVITIES,
        )?;
        validate_unique_non_empty("evidenceTypes", &request.evidence_types)?;
        for evidence_type in &request.evidence_types {
            validate_choice("evidenceType", evidence_type, EVIDENCE_EVENT_TYPES)?;
        }
        let requested_limit = request.limit.clamp(1, 500);
        let limit = requested_limit as i64 + 1;
        let normalized_query = request
            .query
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let query_terms: Vec<String> = normalized_query
            .as_deref()
            .map(|query| {
                query
                    .split_whitespace()
                    .filter(|term| !term.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let query_mode = if query_terms.is_empty() {
            "none"
        } else {
            "any_whitespace_term"
        };
        let mut builder = QueryBuilder::<Sqlite>::new(
            "SELECT id, schema_version, kind, layer, label, statement, payload_json, status, \
             authority, origin, scope_json, scope_key, sensitivity, valid_from, valid_to, \
             recorded_at, superseded_at, created_at, updated_at, deleted_at, expected_outcome, \
             review_at, outcome FROM nodes WHERE 1=1",
        );
        if !request.include_retracted {
            builder.push(" AND deleted_at IS NULL AND status NOT IN ('revoked','deleted')");
            builder
                .push(" AND COALESCE(json_extract(payload_json,'$.historyReviewRequired'),0)<>1");
        }
        if request.exclude_history {
            builder.push(" AND NOT EXISTS (SELECT 1 FROM node_evidence_links l JOIN evidence_refs e ON e.id=l.evidence_ref_id JOIN source_records s ON s.id=e.source_record_id WHERE l.node_id=nodes.id AND s.source_type='computer_history') AND COALESCE(json_extract(payload_json,'$.evidenceType'),'')<>'computer_history'");
        }
        builder
            .push(" AND CASE sensitivity WHEN 'low' THEN 0 WHEN 'medium' THEN 1 ")
            .push("WHEN 'high' THEN 2 WHEN 'highest' THEN 3 ELSE 99 END <= ")
            .push_bind(sensitivity_rank(&request.sensitivity_ceiling) as i64);
        if !query_terms.is_empty() {
            builder.push(" AND (");
            for (index, term) in query_terms.iter().enumerate() {
                if index > 0 {
                    builder.push(" OR ");
                }
                let pattern = format!("%{term}%");
                builder.push("(label LIKE ").push_bind(pattern.clone());
                builder
                    .push(" OR COALESCE(statement,'') LIKE ")
                    .push_bind(pattern)
                    .push(")");
            }
            builder.push(")");
        }
        if !request.kinds.is_empty() {
            for kind in &request.kinds {
                validate_choice("kind", kind, NODE_KINDS)?;
            }
            builder.push(" AND kind IN (");
            let mut separated = builder.separated(", ");
            for kind in &request.kinds {
                separated.push_bind(kind);
            }
            separated.push_unseparated(")");
        }
        if !request.evidence_types.is_empty() {
            builder.push(" AND (kind != 'evidence_event' OR json_extract(payload_json, '$.evidenceType') IN (");
            let mut separated = builder.separated(", ");
            for evidence_type in &request.evidence_types {
                separated.push_bind(evidence_type);
            }
            separated.push_unseparated("))");
        }
        builder
            .push(" ORDER BY updated_at DESC, id ASC LIMIT ")
            .push_bind(limit)
            .push(" OFFSET ")
            .push_bind(request.offset as i64);
        let mut nodes: Vec<NodeRecord> = builder.build_query_as().fetch_all(&self.pool).await?;
        let has_more = nodes.len() > requested_limit as usize;
        nodes.truncate(requested_limit as usize);
        let node_ids: Vec<&str> = nodes.iter().map(|node| node.id.as_str()).collect();
        let edges = if node_ids.is_empty() {
            Vec::new()
        } else {
            let ids_json = serde_json::to_string(&node_ids)?;
            sqlx::query_as::<_, EdgeRecord>(
                "SELECT id, schema_version, from_node_id, to_node_id, family, relation_type, \
                 direction, proximity, strength, basis, authority, status, rationale, scope_json, \
                 scope_key, valid_from, valid_to, recorded_at, superseded_at, created_at, updated_at \
                 FROM edges WHERE status NOT IN ('deleted','expired') AND \
                 from_node_id IN (SELECT value FROM json_each(?)) AND \
                 to_node_id IN (SELECT value FROM json_each(?)) \
                 ORDER BY updated_at DESC",
            )
            .bind(&ids_json)
            .bind(&ids_json)
            .fetch_all(&self.pool)
            .await?
        };
        let star_states = if node_ids.is_empty() {
            Vec::<Value>::new()
        } else {
            let ids_json = serde_json::to_string(&node_ids)?;
            sqlx::query(
                "SELECT center_node_id, version, role, importance, importance_authority, salience, \
                 organizing_power, freshness, mass, radius, aura_version, state_status, \
                 recompute_required, valid_from, valid_to, recorded_at, updated_at \
                 FROM star_states WHERE center_node_id IN (SELECT value FROM json_each(?)) \
                 AND state_status='active'",
            )
            .bind(ids_json)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(star_state_row_to_value)
            .collect()
        };
        Ok(json!({
            "ok": true,
            "nodes": nodes.iter().map(NodeRecord::to_value).collect::<Vec<_>>(),
            "edges": edges.iter().map(EdgeRecord::to_value).collect::<Vec<_>>(),
            "starStates": star_states,
            "coverage": {
                "kinds": request.kinds,
                "evidenceTypes": request.evidence_types,
                "query": normalized_query,
                "queryTerms": query_terms,
                "queryMode": query_mode,
                "includeRetracted": request.include_retracted,
                "sensitivityCeiling": request.sensitivity_ceiling,
                "limit": requested_limit,
                "returnedNodeCount": nodes.len(),
                "possiblyTruncated": has_more,
                "offset": request.offset,
                "nextOffset": if has_more { Some(request.offset as usize + nodes.len()) } else { None },
                "contentTruncated": false,
            },
        }))
    }

    /// Search the source/evidence layer without first forcing raw records into
    /// the semantic knowledge graph. This is the read path used both for broad
    /// source search and for drilling from a distilled node back to its inputs.
    pub async fn query_evidence(&self, request: EvidenceQueryRequest) -> AppResult<Value> {
        let requested_limit = request.limit.clamp(1, 500);
        validate_choice(
            "samplingMode",
            &request.sampling_mode,
            EVIDENCE_SAMPLING_MODES,
        )?;
        if request.events_per_source == 0 {
            return Err(AppError::Invalid("eventsPerSource must be positive".into()));
        }
        let source_balanced = request.sampling_mode == "source_balanced";
        if let Some(from) = &request.from {
            validate_timestamp("from", from)?;
        }
        if let Some(to) = &request.to {
            validate_timestamp("to", to)?;
        }
        validate_unique_non_empty("sourceTypes", &request.source_types)?;
        validate_unique_non_empty("nodeIds", &request.node_ids)?;
        validate_unique_non_empty("evidenceRefIds", &request.evidence_ref_ids)?;
        for source_type in &request.source_types {
            validate_choice("sourceType", source_type, SOURCE_TYPES)?;
        }

        let normalized_query = request
            .query
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let query_terms: Vec<String> = normalized_query
            .as_deref()
            .map(|query| {
                query
                    .split_whitespace()
                    .filter(|term| !term.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();

        let select =
            "SELECT e.id AS evidence_id, e.schema_version, e.source_record_id, e.actor_id, \
             e.actor_role, e.attribution_status, e.segment_id, e.raw_event_ids_json, \
             e.start_time, e.end_time, e.transcript_span, e.resource_id, e.excerpt, \
             e.content_hash AS evidence_content_hash, e.redaction_status, e.processor_name, \
             e.processor_version, e.created_at AS evidence_created_at, e.retracted_at, \
             s.id AS source_id, s.source_type, s.captured_at, s.ended_at, s.storage_uri, \
             s.content_hash AS source_content_hash, s.privacy_level, s.storage_policy, \
             s.model_access, s.coverage_status, s.suppressed_count, s.collector_version, \
             s.metadata_json, s.created_at AS source_created_at, \
             COALESCE(e.start_time,s.captured_at,e.created_at) AS evidence_sort_time";
        let mut builder = if source_balanced {
            QueryBuilder::<Sqlite>::new(format!(
                "WITH ranked_evidence AS ({select}, \
                 ROW_NUMBER() OVER (PARTITION BY e.source_record_id \
                 ORDER BY COALESCE(e.start_time,s.captured_at,e.created_at) DESC, e.id ASC) AS source_rank \
                 FROM evidence_refs e JOIN source_records s ON s.id=e.source_record_id \
                 WHERE s.deleted_at IS NULL"
            ))
        } else {
            QueryBuilder::<Sqlite>::new(format!(
                "{select} FROM evidence_refs e JOIN source_records s ON s.id=e.source_record_id \
                 WHERE s.deleted_at IS NULL"
            ))
        };
        if request.exclude_history {
            builder.push(" AND s.source_type<>'computer_history'");
        }
        // Once native history settings have been explicitly configured, older
        // manual imports are not an alternate model access path around them.
        builder.push(" AND (s.source_type<>'computer_history' OR e.processor_name='latitude-history' OR NOT EXISTS (SELECT 1 FROM history_settings WHERE json_type(config_json,'$.enabled') IS NOT NULL))");
        builder.push(" AND (COALESCE(e.processor_name,'') <> 'latitude-history' OR (s.model_access='external_allowed' AND e.start_time >= ")
            .push_bind((Utc::now()-ChronoDuration::hours(48)).to_rfc3339_opts(SecondsFormat::Millis,true)).push("))");
        if !request.include_retracted {
            builder.push(" AND e.retracted_at IS NULL");
        }
        if !request.source_types.is_empty() {
            builder.push(" AND s.source_type IN (");
            let mut separated = builder.separated(", ");
            for source_type in &request.source_types {
                separated.push_bind(source_type);
            }
            separated.push_unseparated(")");
        }
        if !request.node_ids.is_empty() {
            builder.push(
                " AND EXISTS (SELECT 1 FROM node_evidence_links nel \
                 WHERE nel.evidence_ref_id=e.id AND nel.node_id IN (",
            );
            let mut separated = builder.separated(", ");
            for node_id in &request.node_ids {
                separated.push_bind(node_id);
            }
            separated.push_unseparated("))");
        }
        if !query_terms.is_empty() {
            builder.push(" AND (");
            for (index, term) in query_terms.iter().enumerate() {
                if index > 0 {
                    builder.push(" OR ");
                }
                let pattern = format!("%{term}%");
                builder
                    .push("(COALESCE(e.excerpt,'') LIKE ")
                    .push_bind(pattern.clone());
                builder
                    .push(" OR COALESCE(e.resource_id,'') LIKE ")
                    .push_bind(pattern.clone());
                builder
                    .push(" OR COALESCE(e.transcript_span,'') LIKE ")
                    .push_bind(pattern.clone());
                builder
                    .push(" OR s.metadata_json LIKE ")
                    .push_bind(pattern)
                    .push(")");
            }
            builder.push(")");
        }
        if let Some(from) = &request.from {
            builder
                .push(" AND COALESCE(e.end_time,e.start_time,s.ended_at,s.captured_at,e.created_at) >= ")
                .push_bind(from);
        }
        if !request.evidence_ref_ids.is_empty() {
            builder.push(" AND e.id IN (");
            let mut ids = builder.separated(", ");
            for id in &request.evidence_ref_ids {
                ids.push_bind(id);
            }
            ids.push_unseparated(")");
        }
        if let Some(to) = &request.to {
            builder
                .push(" AND COALESCE(e.start_time,s.captured_at,e.created_at) <= ")
                .push_bind(to);
        }
        if source_balanced {
            builder
                .push(") SELECT * FROM ranked_evidence WHERE source_rank <= ")
                .push_bind(request.events_per_source as i64)
                .push(" ORDER BY evidence_sort_time DESC, evidence_id ASC LIMIT ")
                .push_bind(requested_limit as i64 + 1);
        } else {
            builder
                .push(" ORDER BY evidence_sort_time DESC, evidence_id ASC LIMIT ")
                .push_bind(requested_limit as i64 + 1);
        }

        builder.push(" OFFSET ").push_bind(request.offset as i64);
        let mut rows = builder.build().fetch_all(&self.pool).await?;
        let has_more = rows.len() > requested_limit as usize;
        rows.truncate(requested_limit as usize);
        let mut items = Vec::with_capacity(rows.len());
        for row in rows {
            let evidence_id: String = row.try_get("evidence_id")?;
            let linked_nodes = sqlx::query(
                "SELECT n.id, n.kind, n.label, n.statement, n.status, n.authority, n.origin, \
                 n.sensitivity, l.role FROM node_evidence_links l \
                 JOIN nodes n ON n.id=l.node_id WHERE l.evidence_ref_id=? \
                 AND n.deleted_at IS NULL AND n.status NOT IN ('deleted','revoked') \
                 ORDER BY n.updated_at DESC, n.id ASC",
            )
            .bind(&evidence_id)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(|node| {
                json!({
                    "id": node.get::<String, _>("id"),
                    "kind": node.get::<String, _>("kind"),
                    "label": node.get::<String, _>("label"),
                    "statement": node.get::<Option<String>, _>("statement"),
                    "status": node.get::<String, _>("status"),
                    "authority": node.get::<String, _>("authority"),
                    "origin": node.get::<String, _>("origin"),
                    "sensitivity": node.get::<String, _>("sensitivity"),
                    "evidenceRole": node.get::<String, _>("role"),
                })
            })
            .collect::<Vec<_>>();
            let raw_event_ids_json: String = row.try_get("raw_event_ids_json")?;
            let metadata_json: String = row.try_get("metadata_json")?;
            items.push(json!({
                "evidenceRef": {
                    "id": evidence_id,
                    "schemaVersion": row.get::<String, _>("schema_version"),
                    "sourceRecordId": row.get::<String, _>("source_record_id"),
                    "actorId": row.get::<Option<String>, _>("actor_id"),
                    "actorRole": row.get::<String, _>("actor_role"),
                    "attributionStatus": row.get::<String, _>("attribution_status"),
                    "segmentId": row.get::<Option<String>, _>("segment_id"),
                    "rawEventIds": serde_json::from_str::<Value>(&raw_event_ids_json)
                        .unwrap_or_else(|_| json!([])),
                    "startTime": row.get::<Option<String>, _>("start_time"),
                    "endTime": row.get::<Option<String>, _>("end_time"),
                    "transcriptSpan": row.get::<Option<String>, _>("transcript_span"),
                    "resourceId": row.get::<Option<String>, _>("resource_id"),
                    "excerpt": row.get::<Option<String>, _>("excerpt"),
                    "contentHash": row.get::<String, _>("evidence_content_hash"),
                    "redactionStatus": row.get::<String, _>("redaction_status"),
                    "processorName": row.get::<String, _>("processor_name"),
                    "processorVersion": row.get::<String, _>("processor_version"),
                    "createdAt": row.get::<String, _>("evidence_created_at"),
                    "retractedAt": row.get::<Option<String>, _>("retracted_at"),
                },
                "source": {
                    "id": row.get::<String, _>("source_id"),
                    "sourceType": row.get::<String, _>("source_type"),
                    "capturedAt": row.get::<Option<String>, _>("captured_at"),
                    "endedAt": row.get::<Option<String>, _>("ended_at"),
                    "storageUri": row.get::<Option<String>, _>("storage_uri"),
                    "contentHash": row.get::<String, _>("source_content_hash"),
                    "privacyLevel": row.get::<String, _>("privacy_level"),
                    "storagePolicy": row.get::<String, _>("storage_policy"),
                    "modelAccess": row.get::<String, _>("model_access"),
                    "coverageStatus": row.get::<String, _>("coverage_status"),
                    "suppressedCount": row.get::<Option<i64>, _>("suppressed_count"),
                    "collectorVersion": row.get::<Option<String>, _>("collector_version"),
                    "metadata": serde_json::from_str::<Value>(&metadata_json)
                        .unwrap_or_else(|_| json!({})),
                    "createdAt": row.get::<String, _>("source_created_at"),
                },
                "linkedNodes": linked_nodes,
            }));
        }
        Ok(json!({
            "ok": true,
            "items": items,
            "coverage": {
                "layer": "raw_evidence",
                "query": normalized_query,
                "queryTerms": query_terms,
                "queryMode": if query_terms.is_empty() { "none" } else { "any_whitespace_term" },
                "sourceTypes": request.source_types,
                "nodeIds": request.node_ids,
                "from": request.from,
                "to": request.to,
                "includeRetracted": request.include_retracted,
                "samplingMode": request.sampling_mode,
                "eventsPerSource": request.events_per_source,
                "limit": requested_limit,
                "returnedEvidenceCount": items.len(),
                "possiblyTruncated": has_more,
                "offset": request.offset,
                "nextOffset": if has_more { Some(request.offset as usize + items.len()) } else { None },
                "contentTruncated": false,
                "sensitivityFiltered": false,
            }
        }))
    }

    /// Exact source read with lossless Unicode pagination, independent of graph nodes.
    pub async fn read_evidence(&self, request: EvidenceReadRequest) -> AppResult<Value> {
        validate_non_empty("evidenceRefId", &request.evidence_ref_id)?;
        if request.length == Some(0) {
            return Err(AppError::Invalid("length must be positive".into()));
        }
        let result = self
            .query_evidence(serde_json::from_value(json!({
                "evidenceRefIds": [request.evidence_ref_id],
                "includeRetracted": true,
                "excludeHistory": request.exclude_history,
                "limit": 1
            }))?)
            .await?;
        let mut item = result["items"]
            .as_array()
            .and_then(|items| items.first())
            .cloned()
            .ok_or_else(|| AppError::NotFound(request.evidence_ref_id.clone()))?;
        let text = item["evidenceRef"]["excerpt"].as_str().unwrap_or("");
        let total = text.chars().count();
        if request.offset > total {
            return Err(AppError::Invalid(
                "offset is beyond the end of this evidence".into(),
            ));
        }
        let length = request
            .length
            .unwrap_or(total - request.offset)
            .min(total - request.offset);
        let content: String = text.chars().skip(request.offset).take(length).collect();
        let end = request.offset + length;
        item["evidenceRef"]["excerpt"] = json!(content);
        item["range"] = json!({
            "offset": request.offset, "length": length, "totalCharacters": total,
            "nextOffset": if end < total { Some(end) } else { None },
            "contentTruncated": request.offset > 0 || end < total
        });
        item["ok"] = json!(true);
        Ok(item)
    }

    /// Project an evidence event onto current stars without mutating the graph.
    pub async fn locate_event(&self, request: LocateEventRequest) -> AppResult<Value> {
        validate_non_empty("eventNodeId", &request.event_node_id)?;
        validate_choice(
            "sensitivityCeiling",
            &request.sensitivity_ceiling,
            SENSITIVITIES,
        )?;
        validate_json_object("projectContext", &request.project_context)?;
        if let Some(audit) = &request.audit {
            audit.validate().map_err(AppError::Invalid)?;
        }
        let event = fetch_node_pool(&self.pool, &request.event_node_id).await?;
        if event.kind != "evidence_event" {
            return Err(AppError::Invalid(
                "eventNodeId must reference an evidence_event node".into(),
            ));
        }
        let linked_refs: Vec<String> = sqlx::query_scalar(
            "SELECT evidence_ref_id FROM node_evidence_links WHERE node_id=? ORDER BY evidence_ref_id",
        )
        .bind(&request.event_node_id)
        .fetch_all(&self.pool)
        .await?;
        let evidence_refs = if request.evidence_refs.is_empty() {
            linked_refs.clone()
        } else {
            for evidence_ref in &request.evidence_refs {
                if !linked_refs.contains(evidence_ref) {
                    return Err(AppError::Invalid(format!(
                        "evidenceRef {evidence_ref} is not linked to eventNodeId"
                    )));
                }
            }
            request.evidence_refs.clone()
        };
        if evidence_refs.is_empty() {
            return Err(AppError::Invalid(
                "locate_event requires an EvidenceRef-linked event".into(),
            ));
        }

        let rows = sqlx::query(
            "SELECT ss.center_node_id, ss.version, ss.role, ss.importance, ss.importance_authority, \
             ss.salience, ss.organizing_power, ss.freshness, ss.mass, ss.radius, ss.aura_version, \
             ss.state_status, ss.recompute_required, ss.valid_from, ss.valid_to, ss.recorded_at, \
             ss.updated_at, n.label, n.statement, n.scope_json, n.payload_json, n.sensitivity \
             FROM star_states ss JOIN nodes n ON n.id=ss.center_node_id \
             WHERE ss.state_status='active' AND n.deleted_at IS NULL \
             AND n.status IN ('active','scoped','disputed','proposed') \
             ORDER BY CASE ss.role WHEN 'active_star' THEN 0 WHEN 'emerging_star' THEN 1 ELSE 2 END, \
             CASE ss.importance WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, \
             ss.updated_at DESC, ss.center_node_id ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        let event_text = format!(
            "{} {}",
            event.label,
            event.statement.clone().unwrap_or_default()
        );
        let event_scope: Value =
            serde_json::from_str(&event.scope_json).unwrap_or_else(|_| json!({}));
        let mut candidates = Vec::new();
        for row in rows {
            let sensitivity: String = row.try_get("sensitivity")?;
            if sensitivity_rank(&sensitivity) > sensitivity_rank(&request.sensitivity_ceiling) {
                continue;
            }
            let center_id: String = row.try_get("center_node_id")?;
            let existing = sqlx::query_as::<_, EdgeRecord>(
                "SELECT id, schema_version, from_node_id, to_node_id, family, relation_type, \
                 direction, proximity, strength, basis, authority, status, rationale, scope_json, \
                 scope_key, valid_from, valid_to, recorded_at, superseded_at, created_at, updated_at \
                 FROM edges WHERE status IN ('active','disputed') AND \
                 ((from_node_id=? AND to_node_id=?) OR (from_node_id=? AND to_node_id=?)) \
                 ORDER BY updated_at DESC LIMIT 1",
            )
            .bind(&request.event_node_id)
            .bind(&center_id)
            .bind(&center_id)
            .bind(&request.event_node_id)
            .fetch_optional(&self.pool)
            .await?;
            let center_scope: Value =
                serde_json::from_str(row.get::<String, _>("scope_json").as_str())
                    .unwrap_or_else(|_| json!({}));
            let center_payload: Value =
                serde_json::from_str(row.get::<String, _>("payload_json").as_str())
                    .unwrap_or_else(|_| json!({}));
            let center_label: String = row.try_get("label")?;
            let center_statement: Option<String> = row.try_get("statement")?;
            let candidate = if let Some(edge) = existing {
                json!({
                    "starCenterNodeId": center_id,
                    "starLabel": center_label,
                    "relationType": edge.relation_type,
                    "direction": edge.direction,
                    "proximity": edge.proximity,
                    "strength": edge.strength,
                    "basis": edge.basis,
                    "status": "observed_existing",
                    "rationale": edge.rationale,
                    "evidenceRefs": evidence_refs,
                })
            } else if json_objects_overlap(&request.project_context, &center_scope)
                || json_objects_overlap(&request.project_context, &center_payload)
                || json_objects_overlap(&event_scope, &center_scope)
            {
                json!({
                    "starCenterNodeId": center_id,
                    "starLabel": center_label,
                    "relationType": "part_of",
                    "direction": "directed",
                    "proximity": "near",
                    "strength": "strong",
                    "basis": "deterministic_context",
                    "status": "projected",
                    "rationale": "The event and star share an explicit structured project/scope value.",
                    "evidenceRefs": evidence_refs,
                })
            } else if semantic_overlap(
                &event_text,
                &format!("{} {}", center_label, center_statement.unwrap_or_default()),
            ) {
                if !request.query_policy.allow_semantic_only {
                    continue;
                }
                json!({
                    "starCenterNodeId": center_id,
                    "starLabel": center_label,
                    "relationType": "about",
                    "direction": "directed",
                    "proximity": "boundary",
                    "strength": "weak",
                    "basis": "semantic_only",
                    "status": "proposed",
                    "rationale": "Text overlap is a retrieval hint only; it is insufficient for an active graph edge.",
                    "evidenceRefs": evidence_refs,
                })
            } else {
                continue;
            };
            candidates.push(candidate);
            if candidates.len() >= request.query_policy.max_candidates.clamp(1, 8) as usize {
                break;
            }
        }
        let unlinked = candidates.is_empty();
        Ok(json!({
            "ok": true,
            "mutationPerformed": false,
            "eventNodeId": request.event_node_id,
            "evidenceRefs": evidence_refs,
            "candidates": candidates,
            "alternatives": [],
            "unresolved": if unlinked { vec!["No evidence-backed or deterministic star location was found."] } else { Vec::<&str>::new() },
            "unlinked": unlinked,
        }))
    }

    pub async fn apply_location(
        &self,
        request: ApplyLocationRequest,
        idempotency: Option<&IdempotencyContext>,
    ) -> AppResult<MutationResponse> {
        request.audit.validate().map_err(AppError::Invalid)?;
        validate_non_empty("eventNodeId", &request.event_node_id)?;
        validate_non_empty("starCenterNodeId", &request.star_center_node_id)?;
        validate_non_empty("rationale", &request.rationale)?;
        validate_choice(
            "relationType",
            &request.relation_type,
            &["part_of", "about", "serves", "influences"],
        )?;
        validate_choice(
            "basis",
            &request.basis,
            &[
                "direct_observation",
                "explicit_statement",
                "user_confirmation",
                "deterministic_context",
                "contextual",
                "behavioral_inference",
                "semantic_only",
                "derived_metric",
            ],
        )?;
        let proximity = request.proximity.as_deref().unwrap_or("near");
        validate_choice(
            "proximity",
            proximity,
            &[
                "direct", "near", "middle", "far", "boundary", "outside", "unknown",
            ],
        )?;
        let strength = request.strength.as_deref().unwrap_or("medium");
        validate_choice(
            "strength",
            strength,
            &["weak", "medium", "strong", "not_applicable"],
        )?;
        if request.evidence_refs.is_empty() {
            return Err(AppError::Invalid(
                "apply-location requires at least one evidenceRef".into(),
            ));
        }

        let now = now_iso();
        let mut tx = self.pool.begin().await?;
        if let Some(cached) = begin_idempotency(&mut tx, idempotency).await? {
            return Ok(cached);
        }
        let event = fetch_node_tx(&mut tx, &request.event_node_id).await?;
        if event.kind != "evidence_event" || event.deleted_at.is_some() {
            return Err(AppError::Invalid(
                "eventNodeId must reference an active evidence_event".into(),
            ));
        }
        let center = fetch_node_tx(&mut tx, &request.star_center_node_id).await?;
        if center.deleted_at.is_some()
            || !matches!(
                center.status.as_str(),
                "active" | "scoped" | "disputed" | "proposed"
            )
        {
            return Err(AppError::Conflict(
                "starCenterNodeId is not a current graph node".into(),
            ));
        }
        let active_star: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM star_states WHERE center_node_id=? AND state_status='active'",
        )
        .bind(&request.star_center_node_id)
        .fetch_one(&mut *tx)
        .await?;
        if active_star == 0 {
            return Err(AppError::Invalid(
                "starCenterNodeId must have an active StarState".into(),
            ));
        }
        let mut seen = HashSet::new();
        for evidence_ref in &request.evidence_refs {
            if !seen.insert(evidence_ref) {
                return Err(AppError::Invalid(
                    "evidenceRefs cannot contain duplicates".into(),
                ));
            }
            validate_and_source_evidence_tx(&mut tx, evidence_ref).await?;
            let linked: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM node_evidence_links WHERE node_id=? AND evidence_ref_id=?",
            )
            .bind(&request.event_node_id)
            .bind(evidence_ref)
            .fetch_one(&mut *tx)
            .await?;
            if linked == 0 {
                return Err(AppError::Invalid(format!(
                    "evidenceRef {evidence_ref} is not linked to eventNodeId"
                )));
            }
        }

        let change_set_id = create_change_set(
            &mut tx,
            "star_maintenance",
            &request.rationale,
            &request.audit,
        )
        .await?;
        let (authority, _) = provenance_for_audit(&request.audit, false);
        let status = if request.basis == "semantic_only" {
            "proposed"
        } else {
            "active"
        };
        let orbit_edge_id = create_edge_with_semantics_tx(
            &mut tx,
            &request.event_node_id,
            &request.star_center_node_id,
            EdgeSemantics {
                family: "orbital",
                relation_type: "orbits",
                direction: "directed",
                proximity,
                strength,
                basis: &request.basis,
                authority,
                status,
                rationale: &request.rationale,
            },
            &serde_json::from_str(&event.scope_json).unwrap_or_else(|_| json!({})),
            &now,
        )
        .await?;
        let semantic_edge_id = create_edge_with_semantics_tx(
            &mut tx,
            &request.event_node_id,
            &request.star_center_node_id,
            EdgeSemantics {
                family: "semantic",
                relation_type: &request.relation_type,
                direction: "directed",
                proximity,
                strength,
                basis: &request.basis,
                authority,
                status,
                rationale: &request.rationale,
            },
            &serde_json::from_str(&event.scope_json).unwrap_or_else(|_| json!({})),
            &now,
        )
        .await?;
        for evidence_ref in &request.evidence_refs {
            for edge_id in [&orbit_edge_id, &semantic_edge_id] {
                sqlx::query(
                    "INSERT INTO edge_evidence_links(edge_id, evidence_ref_id, role, created_at) \
                     VALUES (?, ?, 'reason', ?)",
                )
                .bind(edge_id)
                .bind(evidence_ref)
                .bind(&now)
                .execute(&mut *tx)
                .await?;
            }
            sqlx::query(
                "INSERT OR IGNORE INTO change_evidence_links(change_set_id, evidence_ref_id, created_at) \
                 VALUES (?, ?, ?)",
            )
            .bind(&change_set_id)
            .bind(evidence_ref)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        let orbit_edge = fetch_edge_tx(&mut tx, &orbit_edge_id).await?.to_value();
        let semantic_edge = fetch_edge_tx(&mut tx, &semantic_edge_id).await?.to_value();
        for (sequence, edge_id, edge) in [
            (0_i64, &orbit_edge_id, &orbit_edge),
            (1_i64, &semantic_edge_id, &semantic_edge),
        ] {
            insert_operation(
                &mut tx,
                &change_set_id,
                sequence,
                "create_edge",
                edge_id,
                None,
                Some(edge),
                Some(&json!({ "operation": "soft_close_edge", "targetRef": edge_id })),
            )
            .await?;
        }
        let (before_star, star_state) =
            upsert_star_state_tx(&mut tx, &request.star_center_node_id, &now).await?;
        insert_operation(
            &mut tx,
            &change_set_id,
            2,
            "upsert_star_state",
            &request.star_center_node_id,
            before_star.as_ref(),
            Some(&star_state),
            before_star.as_ref(),
        )
        .await?;
        apply_change_set(&mut tx, &change_set_id, &now).await?;
        let response = MutationResponse {
            ok: true,
            change_set_id,
            value: json!({
                "eventNodeId": request.event_node_id,
                "starCenterNodeId": request.star_center_node_id,
                "orbitEdge": orbit_edge,
                "semanticEdge": semantic_edge,
                "starState": star_state,
            }),
        };
        complete_idempotency(&mut tx, idempotency, &response, &now).await?;
        tx.commit().await?;
        Ok(response)
    }

    /// Create one evidence-backed relationship between two current graph nodes.
    ///
    /// This is intentionally separate from `apply_location`: a knowledge relationship must not
    /// fabricate an orbital edge or require either endpoint to be a StarState.
    pub async fn create_relationship(
        &self,
        request: RelationshipRequest,
        idempotency: Option<&IdempotencyContext>,
    ) -> AppResult<MutationResponse> {
        request.audit.validate().map_err(AppError::Invalid)?;
        validate_non_empty("fromNodeId", &request.from_node_id)?;
        validate_non_empty("toNodeId", &request.to_node_id)?;
        validate_non_empty("rationale", &request.rationale)?;
        validate_json_object("scope", &request.scope)?;
        validate_unique_non_empty("evidenceRefs", &request.evidence_refs)?;
        if request.from_node_id == request.to_node_id {
            return Err(AppError::Invalid(
                "a relationship cannot point to the same node".into(),
            ));
        }
        if request.evidence_refs.is_empty() {
            return Err(AppError::Invalid(
                "relationships require at least one evidenceRef".into(),
            ));
        }
        validate_choice(
            "relationType",
            &request.relation_type,
            &[
                "derived_from",
                "supports",
                "contradicts",
                "provides_evidence_for",
                "tension_of",
                "tests",
                "influences",
                "implemented_as",
                "resulted_in",
                "serves",
                "blocks",
                "about",
                "part_of",
                "used_for",
                "exemplifies",
                "conflicts_with",
                "bridges",
                "evolved_from",
                "split_from",
                "merged_from",
            ],
        )?;
        validate_choice(
            "basis",
            &request.basis,
            &[
                "direct_observation",
                "explicit_statement",
                "user_confirmation",
                "deterministic_context",
                "contextual",
                "behavioral_inference",
                "semantic_only",
                "derived_metric",
            ],
        )?;
        let proximity = request.proximity.as_deref().unwrap_or("near");
        validate_choice(
            "proximity",
            proximity,
            &[
                "direct", "near", "middle", "far", "boundary", "outside", "unknown",
            ],
        )?;
        let strength = request.strength.as_deref().unwrap_or("medium");
        validate_choice(
            "strength",
            strength,
            &["weak", "medium", "strong", "not_applicable"],
        )?;

        let now = now_iso();
        let (family, direction) = relationship_semantics(&request.relation_type);
        let mut tx = self.pool.begin().await?;
        if let Some(cached) = begin_idempotency(&mut tx, idempotency).await? {
            return Ok(cached);
        }
        let from_node = fetch_node_tx(&mut tx, &request.from_node_id).await?;
        let to_node = fetch_node_tx(&mut tx, &request.to_node_id).await?;
        validate_current_relationship_node(&from_node, &now)?;
        validate_current_relationship_node(&to_node, &now)?;
        validate_relationship_endpoint_kinds(
            &request.relation_type,
            &from_node.kind,
            &to_node.kind,
        )?;
        let mut all_evidence_is_verified_user = true;
        for evidence_ref in &request.evidence_refs {
            validate_and_source_evidence_tx(&mut tx, evidence_ref).await?;
            let attribution =
                sqlx::query("SELECT actor_role, attribution_status FROM evidence_refs WHERE id=?")
                    .bind(evidence_ref)
                    .fetch_one(&mut *tx)
                    .await?;
            all_evidence_is_verified_user &= attribution.get::<String, _>("actor_role") == "user"
                && attribution.get::<String, _>("attribution_status") == "verified";
        }
        let relation_scope_key = scope_key(&request.scope)?;
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT id FROM edges WHERE relation_type=? AND scope_key=? \
             AND status IN ('active','proposed','disputed') \
             AND ((from_node_id=? AND to_node_id=?) \
               OR (?='symmetric' AND from_node_id=? AND to_node_id=?)) LIMIT 1",
        )
        .bind(&request.relation_type)
        .bind(&relation_scope_key)
        .bind(&request.from_node_id)
        .bind(&request.to_node_id)
        .bind(direction)
        .bind(&request.to_node_id)
        .bind(&request.from_node_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(existing_id) = existing {
            return Err(AppError::Conflict(format!(
                "relationship already exists as {existing_id}"
            )));
        }

        let change_set_id = create_change_set(
            &mut tx,
            "extraction",
            &format!(
                "Connect {} {} {} with evidence-backed rationale",
                request.from_node_id, request.relation_type, request.to_node_id
            ),
            &request.audit,
        )
        .await?;
        let (authority, status) = match (request.audit.actor.as_str(), request.basis.as_str()) {
            ("user", "explicit_statement" | "direct_observation") => {
                if !all_evidence_is_verified_user {
                    return Err(AppError::Conflict(
                        "user-stated relationships require verified user-authored evidenceRefs"
                            .into(),
                    ));
                }
                ("user_stated", "active")
            }
            ("user", "user_confirmation") => {
                if !all_evidence_is_verified_user {
                    return Err(AppError::Conflict(
                        "user-confirmed relationships require verified user-authored evidenceRefs"
                            .into(),
                    ));
                }
                ("user_confirmed", "active")
            }
            ("importer", _) => ("imported_unverified", "proposed"),
            _ => ("system_inferred", "proposed"),
        };
        let edge_id = create_edge_with_semantics_tx(
            &mut tx,
            &request.from_node_id,
            &request.to_node_id,
            EdgeSemantics {
                family,
                relation_type: &request.relation_type,
                direction,
                proximity,
                strength,
                basis: &request.basis,
                authority,
                status,
                rationale: request.rationale.trim(),
            },
            &request.scope,
            &now,
        )
        .await?;
        let evidence_role = relationship_evidence_role(&request.relation_type);
        for evidence_ref in &request.evidence_refs {
            sqlx::query(
                "INSERT INTO edge_evidence_links(edge_id, evidence_ref_id, role, created_at) \
                 VALUES (?, ?, ?, ?)",
            )
            .bind(&edge_id)
            .bind(evidence_ref)
            .bind(evidence_role)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT OR IGNORE INTO change_evidence_links(change_set_id, evidence_ref_id, created_at) \
                 VALUES (?, ?, ?)",
            )
            .bind(&change_set_id)
            .bind(evidence_ref)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        let edge = fetch_edge_tx(&mut tx, &edge_id).await?.to_value();
        insert_operation(
            &mut tx,
            &change_set_id,
            0,
            "create_edge",
            &edge_id,
            None,
            Some(&edge),
            Some(&json!({ "operation": "soft_close_edge", "targetRef": edge_id })),
        )
        .await?;
        apply_change_set(&mut tx, &change_set_id, &now).await?;
        let response = MutationResponse {
            ok: true,
            change_set_id,
            value: json!({
                "relationship": edge,
                "evidenceRefs": request.evidence_refs,
            }),
        };
        complete_idempotency(&mut tx, idempotency, &response, &now).await?;
        tx.commit().await?;
        Ok(response)
    }

    /// Compile a bounded graph slice. This deliberately traverses graph relationships instead
    /// of using the legacy label/statement LIKE query.
    pub async fn compile_context(&self, request: CompileContextRequest) -> AppResult<Value> {
        if request.seed_node_ids.is_empty() {
            return Err(AppError::Invalid(
                "seedNodeIds must contain at least one node id".into(),
            ));
        }
        validate_choice(
            "sensitivityPolicy.ceiling",
            &request.sensitivity_policy.ceiling,
            SENSITIVITIES,
        )?;
        validate_json_object("timeScope", &request.time_scope)?;
        if let Some(audit) = &request.audit {
            audit.validate().map_err(AppError::Invalid)?;
        }
        let max_nodes = request.budget.max_nodes.clamp(1, 200) as usize;
        let max_edges = request.budget.max_edges.clamp(1, 500) as usize;
        let max_depth = request.budget.max_depth.clamp(0, 6);
        let ceiling_rank = sensitivity_rank(&request.sensitivity_policy.ceiling);
        let from = request
            .time_scope
            .get("from")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let to = request
            .time_scope
            .get("to")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        if let Some(value) = &from {
            validate_timestamp("timeScope.from", value)?;
        }
        if let Some(value) = &to {
            validate_timestamp("timeScope.to", value)?;
        }

        let mut queue = VecDeque::new();
        let mut path_by_node: HashMap<String, (Vec<String>, Vec<String>, String)> = HashMap::new();
        for seed in &request.seed_node_ids {
            validate_non_empty("seedNodeIds[]", seed)?;
            if path_by_node.contains_key(seed) {
                continue;
            }
            path_by_node.insert(seed.clone(), (vec![seed.clone()], vec![], "seed".into()));
            queue.push_back((seed.clone(), 0_u32));
        }
        let mut nodes = Vec::<NodeRecord>::new();
        let mut node_ids = HashSet::<String>::new();
        let mut edges = Vec::<EdgeRecord>::new();
        let mut edge_ids = HashSet::<String>::new();
        let mut truncated = false;

        while let Some((node_id, depth)) = queue.pop_front() {
            if node_ids.contains(&node_id) {
                continue;
            }
            let node = fetch_node_pool(&self.pool, &node_id).await?;
            if node.deleted_at.is_some()
                || matches!(
                    node.status.as_str(),
                    "revoked" | "deleted" | "superseded" | "expired"
                )
                || sensitivity_rank(&node.sensitivity) > ceiling_rank
                || (request.epistemic_policy.canonical_only
                    && node.layer == "observation"
                    && !request.epistemic_policy.include_observations)
                || from.as_ref().is_some_and(|value| node.recorded_at < *value)
                || to.as_ref().is_some_and(|value| node.recorded_at > *value)
            {
                continue;
            }
            if nodes.len() >= max_nodes {
                truncated = true;
                break;
            }
            node_ids.insert(node.id.clone());
            nodes.push(node.clone());
            if depth >= max_depth {
                continue;
            }
            let adjacent: Vec<EdgeRecord> = sqlx::query_as(
                "SELECT id, schema_version, from_node_id, to_node_id, family, relation_type, \
                 direction, proximity, strength, basis, authority, status, rationale, scope_json, \
                 scope_key, valid_from, valid_to, recorded_at, superseded_at, created_at, updated_at \
                 FROM edges WHERE status IN ('active','disputed') \
                 AND (from_node_id=? OR to_node_id=?) \
                 ORDER BY CASE relation_type WHEN 'supports' THEN 0 WHEN 'contradicts' THEN 1 ELSE 2 END, \
                 updated_at DESC, id ASC",
            )
            .bind(&node_id)
            .bind(&node_id)
            .fetch_all(&self.pool)
            .await?;
            for edge in adjacent {
                if edges.len() >= max_edges {
                    truncated = true;
                    break;
                }
                if edge_ids.insert(edge.id.clone()) {
                    edges.push(edge.clone());
                }
                let next = if edge.from_node_id == node_id {
                    edge.to_node_id.clone()
                } else {
                    edge.from_node_id.clone()
                };
                if !path_by_node.contains_key(&next) {
                    let (mut node_path, mut edge_path, _) = path_by_node
                        .get(&node_id)
                        .cloned()
                        .unwrap_or_else(|| (vec![node_id.clone()], vec![], "graph".into()));
                    node_path.push(next.clone());
                    edge_path.push(edge.id.clone());
                    let reason = edge
                        .rationale
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| match edge.relation_type.as_str() {
                            "supports" => "supporting evidence for a selected claim".into(),
                            "contradicts" => "contradicting evidence for a selected claim".into(),
                            _ => "reachable through an active graph relationship".into(),
                        });
                    path_by_node.insert(next.clone(), (node_path, edge_path, reason));
                    queue.push_back((next, depth + 1));
                }
            }
        }
        edges.retain(|edge| {
            node_ids.contains(&edge.from_node_id) && node_ids.contains(&edge.to_node_id)
        });
        let ids_json = serde_json::to_string(&node_ids.iter().collect::<Vec<_>>())?;
        let star_states = if node_ids.is_empty() {
            Vec::new()
        } else {
            sqlx::query(
                "SELECT center_node_id, version, role, importance, importance_authority, salience, \
                 organizing_power, freshness, mass, radius, aura_version, state_status, \
                 recompute_required, valid_from, valid_to, recorded_at, updated_at \
                 FROM star_states WHERE center_node_id IN (SELECT value FROM json_each(?)) \
                 AND state_status='active' ORDER BY center_node_id",
            )
            .bind(ids_json)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(star_state_row_to_value)
            .collect::<Vec<_>>()
        };
        let paths = nodes
            .iter()
            .filter_map(|node| {
                path_by_node
                    .get(&node.id)
                    .map(|(node_path, edge_path, reason)| {
                        json!({
                            "nodeId": node.id,
                            "whyIncluded": reason,
                            "pathNodeIds": node_path,
                            "pathEdgeIds": edge_path,
                        })
                    })
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "ok": true,
            "nodes": nodes.iter().map(NodeRecord::to_value).collect::<Vec<_>>(),
            "edges": edges.iter().map(EdgeRecord::to_value).collect::<Vec<_>>(),
            "starStates": star_states,
            "paths": paths,
            "needs": request.needs,
            "epistemicPolicy": {
                "canonicalOnly": request.epistemic_policy.canonical_only,
                "includeObservations": request.epistemic_policy.include_observations,
            },
            "sensitivityCeiling": request.sensitivity_policy.ceiling,
            "budget": { "maxNodes": max_nodes, "maxEdges": max_edges, "maxDepth": max_depth },
            "truncated": truncated,
        }))
    }

    pub async fn remember(
        &self,
        request: RememberRequest,
        idempotency: Option<&IdempotencyContext>,
    ) -> AppResult<MutationResponse> {
        request.audit.validate().map_err(AppError::Invalid)?;
        validate_non_empty("label", &request.label)?;
        validate_choice("kind", &request.kind, NODE_KINDS)?;
        validate_choice("sensitivity", &request.sensitivity, SENSITIVITIES)?;
        validate_json_object("payload", &request.payload)?;
        validate_json_object("scope", &request.scope)?;
        let mut seen_evidence = HashSet::new();
        for evidence_ref in &request.evidence_refs {
            validate_non_empty("evidenceRefs[]", evidence_ref)?;
            if !seen_evidence.insert(evidence_ref.as_str()) {
                return Err(AppError::Invalid(
                    "evidenceRefs cannot contain duplicates".into(),
                ));
            }
        }

        let has_evidence = !request.evidence_refs.is_empty();
        let unsupported_model_inference = !has_evidence
            && matches!(request.audit.actor.as_str(), "model" | "system")
            && !matches!(
                request.kind.as_str(),
                "evidence_event" | "observation" | "action" | "outcome" | "resource"
            );
        let effective_kind = if unsupported_model_inference {
            "observation"
        } else {
            request.kind.as_str()
        };
        let status = if unsupported_model_inference || (!has_evidence && request.kind == "claim") {
            "proposed"
        } else {
            "active"
        };
        let mut effective_payload = request.payload.clone();
        if let Some(object) = effective_payload.as_object_mut() {
            object.insert(
                "evidenceStatus".into(),
                Value::String(if has_evidence {
                    "linked".into()
                } else {
                    "unsupported".into()
                }),
            );
            if effective_kind != request.kind {
                object.insert("requestedKind".into(), Value::String(request.kind.clone()));
                object.insert(
                    "promotionRequirement".into(),
                    Value::String("link evidence or capture explicit user feedback".into()),
                );
            }
        }

        let now = now_iso();
        let id = new_id("node");
        let mut tx = self.pool.begin().await?;
        if let Some(cached) = begin_idempotency(&mut tx, idempotency).await? {
            return Ok(cached);
        }
        let mut evidence_sources = Vec::with_capacity(request.evidence_refs.len());
        for evidence_ref in &request.evidence_refs {
            evidence_sources.push((
                evidence_ref.clone(),
                validate_and_source_evidence_tx(&mut tx, evidence_ref).await?,
            ));
        }
        let change_set_id = create_change_set(
            &mut tx,
            "extraction",
            &format!(
                "Remember {} as an auditable authority-preserving node",
                request.label
            ),
            &request.audit,
        )
        .await?;
        let (authority, origin) = provenance_for_audit(&request.audit, false);
        insert_node_with_provenance(
            &mut tx,
            NewNode {
                id: &id,
                kind: effective_kind,
                label: request.label.trim(),
                statement: request.statement.as_deref(),
                payload: &effective_payload,
                scope: &request.scope,
                sensitivity: &request.sensitivity,
                expected_outcome: request.expected_outcome.as_deref(),
                review_at: request.review_at.as_deref(),
                outcome: request.outcome.as_deref(),
                status,
                now: &now,
            },
            authority,
            origin,
        )
        .await?;
        let mut after = fetch_node_tx(&mut tx, &id).await?.to_value();
        insert_operation(
            &mut tx,
            &change_set_id,
            0,
            "create_node",
            &id,
            None,
            Some(&after),
            Some(&json!({ "operation": "soft_retract", "targetRef": id })),
        )
        .await?;
        let mut sequence = 1_i64;
        for (evidence_ref, source_node_id) in &evidence_sources {
            let role = if effective_kind == "observation" {
                "origin"
            } else {
                "support"
            };
            sqlx::query(
                "INSERT INTO node_evidence_links(node_id, evidence_ref_id, role, created_at) \
                 VALUES (?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(evidence_ref)
            .bind(role)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT OR IGNORE INTO change_evidence_links(change_set_id, evidence_ref_id, created_at) \
                 VALUES (?, ?, ?)",
            )
            .bind(&change_set_id)
            .bind(evidence_ref)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            let link = json!({
                "nodeId": id,
                "evidenceRefId": evidence_ref,
                "role": role,
                "createdAt": now,
            });
            insert_operation(
                &mut tx,
                &change_set_id,
                sequence,
                "link_node_evidence",
                &format!("{id}:{evidence_ref}:{role}"),
                None,
                Some(&link),
                Some(&json!({
                    "operation": "unlink_node_evidence",
                    "nodeId": id,
                    "evidenceRefId": evidence_ref,
                    "role": role
                })),
            )
            .await?;
            sequence += 1;

            if let Some(source_node_id) = source_node_id {
                let relation_type = if effective_kind == "observation" {
                    "derived_from"
                } else {
                    "supports"
                };
                let edge_id = create_evidenced_edge_tx(
                    &mut tx,
                    source_node_id,
                    &id,
                    "provenance",
                    relation_type,
                    "The durable node is grounded in this exact EvidenceRef",
                    &request.scope,
                    evidence_ref,
                    authority,
                    &now,
                )
                .await?;
                let edge = fetch_edge_tx(&mut tx, &edge_id).await?.to_value();
                insert_operation(
                    &mut tx,
                    &change_set_id,
                    sequence,
                    "create_edge",
                    &edge_id,
                    None,
                    Some(&edge),
                    Some(&json!({ "operation": "soft_close_edge", "targetRef": edge_id })),
                )
                .await?;
                sequence += 1;
            }
        }
        let mut star_state = Value::Null;
        if effective_kind == "claim" {
            let (before_star, after_star) = upsert_star_state_tx(&mut tx, &id, &now).await?;
            star_state = after_star.clone();
            insert_operation(
                &mut tx,
                &change_set_id,
                sequence,
                "upsert_star_state",
                &id,
                before_star.as_ref(),
                Some(&after_star),
                before_star.as_ref(),
            )
            .await?;
        }
        if let Some(object) = after.as_object_mut() {
            object.insert(
                "evidenceRefs".into(),
                serde_json::to_value(&request.evidence_refs)?,
            );
            object.insert("requestedKind".into(), Value::String(request.kind.clone()));
            object.insert("starState".into(), star_state);
        }
        apply_change_set(&mut tx, &change_set_id, &now).await?;
        let response = MutationResponse {
            ok: true,
            change_set_id,
            value: after,
        };
        complete_idempotency(&mut tx, idempotency, &response, &now).await?;
        tx.commit().await?;
        Ok(response)
    }

    pub async fn update(
        &self,
        request: UpdateRequest,
        idempotency: Option<&IdempotencyContext>,
    ) -> AppResult<MutationResponse> {
        request.audit.validate().map_err(AppError::Invalid)?;
        validate_non_empty("id", &request.id)?;
        if let Some(label) = &request.label {
            validate_non_empty("label", label)?;
        }
        if let Some(payload) = &request.payload {
            validate_json_object("payload", payload)?;
        }
        if let Some(status) = &request.status {
            validate_choice("status", status, NODE_STATUSES)?;
        }

        let now = now_iso();
        let mut tx = self.pool.begin().await?;
        if let Some(cached) = begin_idempotency(&mut tx, idempotency).await? {
            return Ok(cached);
        }
        let before = fetch_node_tx(&mut tx, &request.id).await?;
        if before.deleted_at.is_some() || matches!(before.status.as_str(), "revoked" | "deleted") {
            return Err(AppError::Conflict(
                "cannot update a retracted node; rollback it first".into(),
            ));
        }
        if before.kind == "claim" {
            return Err(AppError::Conflict(
                "claim updates must use /v1/star-map/apply-feedback, /v1/outcomes, or retract so authority and version lineage cannot be bypassed"
                    .into(),
            ));
        }
        let before_payload: Value =
            serde_json::from_str(&before.payload_json).unwrap_or_else(|_| json!({}));
        if before.kind == "experiment"
            && before_payload
                .get("interventionType")
                .and_then(Value::as_str)
                == Some("candidate")
        {
            return Err(AppError::Conflict(
                "candidate updates must use /v1/candidates/{id}/commands so the typed transition receipt cannot be bypassed"
                    .into(),
            ));
        }
        if before.kind == "observation"
            && before_payload.get("evidenceStatus").and_then(Value::as_str) == Some("unsupported")
            && before_payload.get("requestedKind").and_then(Value::as_str) == Some("claim")
            && (request.label.is_some()
                || request.statement.is_some()
                || request.payload.is_some()
                || request.status.is_some()
                || request.expected_outcome.is_some()
                || request.review_at.is_some()
                || request.outcome.is_some())
        {
            return Err(AppError::Conflict(
                "an unsupported claim observation cannot be promoted or rewritten through generic update; link evidence and create a versioned claim"
                    .into(),
            ));
        }
        let change_set_id = create_change_set(
            &mut tx,
            "extraction",
            &format!("Update node {} from model-authored context", request.id),
            &request.audit,
        )
        .await?;

        let payload_json = request
            .payload
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let (authority, origin) = provenance_for_audit(&request.audit, true);
        sqlx::query(
            "UPDATE nodes SET \
             label=COALESCE(?, label), statement=COALESCE(?, statement), \
             payload_json=COALESCE(?, payload_json), status=COALESCE(?, status), \
             expected_outcome=COALESCE(?, expected_outcome), review_at=COALESCE(?, review_at), \
             outcome=COALESCE(?, outcome), authority=?, origin=?, \
             updated_at=? WHERE id=?",
        )
        .bind(request.label.as_deref().map(str::trim))
        .bind(request.statement.as_deref())
        .bind(payload_json)
        .bind(request.status.as_deref())
        .bind(request.expected_outcome.as_deref())
        .bind(request.review_at.as_deref())
        .bind(request.outcome.as_deref())
        .bind(authority)
        .bind(origin)
        .bind(&now)
        .bind(&request.id)
        .execute(&mut *tx)
        .await?;
        let after = fetch_node_tx(&mut tx, &request.id).await?.to_value();
        let before_value = before.to_value();
        insert_operation(
            &mut tx,
            &change_set_id,
            0,
            "update_node",
            &request.id,
            Some(&before_value),
            Some(&after),
            Some(&json!({ "operation": "restore_node", "node": before_value })),
        )
        .await?;
        apply_change_set(&mut tx, &change_set_id, &now).await?;
        let response = MutationResponse {
            ok: true,
            change_set_id,
            value: after,
        };
        complete_idempotency(&mut tx, idempotency, &response, &now).await?;
        tx.commit().await?;
        Ok(response)
    }

    pub async fn retract(
        &self,
        request: RetractRequest,
        idempotency: Option<&IdempotencyContext>,
    ) -> AppResult<MutationResponse> {
        request.audit.validate().map_err(AppError::Invalid)?;
        validate_non_empty("id", &request.id)?;
        validate_non_empty("reason", &request.reason)?;

        let now = now_iso();
        let mut tx = self.pool.begin().await?;
        if let Some(cached) = begin_idempotency(&mut tx, idempotency).await? {
            return Ok(cached);
        }
        let before = fetch_node_tx(&mut tx, &request.id).await?;
        if before.deleted_at.is_some() || matches!(before.status.as_str(), "revoked" | "deleted") {
            return Err(AppError::Conflict("node is already retracted".into()));
        }
        let change_set_id =
            create_change_set(&mut tx, "deletion", &request.reason, &request.audit).await?;
        let incident_edges: Vec<EdgeRecord> = sqlx::query_as(
            "SELECT id, schema_version, from_node_id, to_node_id, family, relation_type, direction, \
             proximity, strength, basis, authority, status, rationale, scope_json, scope_key, \
             valid_from, valid_to, recorded_at, superseded_at, created_at, updated_at FROM edges \
             WHERE (from_node_id=? OR to_node_id=?) AND status!='deleted'",
        )
        .bind(&request.id)
        .bind(&request.id)
        .fetch_all(&mut *tx)
        .await?;
        let (authority, origin) = provenance_for_audit(&request.audit, true);
        sqlx::query(
            "UPDATE nodes SET status='revoked', deleted_at=?, valid_to=?, authority=?, \
             origin=?, updated_at=? WHERE id=?",
        )
        .bind(&now)
        .bind(&now)
        .bind(authority)
        .bind(origin)
        .bind(&now)
        .bind(&request.id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE edges SET status='deleted', valid_to=?, updated_at=? \
             WHERE (from_node_id=? OR to_node_id=?) AND status!='deleted'",
        )
        .bind(&now)
        .bind(&now)
        .bind(&request.id)
        .bind(&request.id)
        .execute(&mut *tx)
        .await?;
        let after = fetch_node_tx(&mut tx, &request.id).await?.to_value();
        let before_value = before.to_value();
        insert_operation(
            &mut tx,
            &change_set_id,
            0,
            "close_node",
            &request.id,
            Some(&before_value),
            Some(&after),
            Some(&json!({ "operation": "restore_node", "node": before_value })),
        )
        .await?;
        for (index, edge_before) in incident_edges.iter().enumerate() {
            let edge_after = fetch_edge_tx(&mut tx, &edge_before.id).await?.to_value();
            let edge_before_value = edge_before.to_value();
            insert_operation(
                &mut tx,
                &change_set_id,
                index as i64 + 1,
                "close_edge",
                &edge_before.id,
                Some(&edge_before_value),
                Some(&edge_after),
                Some(&json!({ "operation": "restore_edge", "edge": edge_before_value })),
            )
            .await?;
        }
        apply_change_set(&mut tx, &change_set_id, &now).await?;
        let response = MutationResponse {
            ok: true,
            change_set_id,
            value: after,
        };
        complete_idempotency(&mut tx, idempotency, &response, &now).await?;
        tx.commit().await?;
        Ok(response)
    }

    pub async fn rollback(
        &self,
        request: RollbackRequest,
        idempotency: Option<&IdempotencyContext>,
    ) -> AppResult<MutationResponse> {
        request.audit.validate().map_err(AppError::Invalid)?;
        validate_non_empty("changeSetId", &request.change_set_id)?;
        let now = now_iso();
        let mut tx = self.pool.begin().await?;
        if let Some(cached) = begin_idempotency(&mut tx, idempotency).await? {
            return Ok(cached);
        }
        let source = sqlx::query("SELECT status, reversible FROM change_sets WHERE id=?")
            .bind(&request.change_set_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("change set {}", request.change_set_id)))?;
        let status: String = source.try_get("status")?;
        let reversible: i64 = source.try_get("reversible")?;
        if status != "applied" || reversible != 1 {
            return Err(AppError::Conflict(
                "change set is not an applied reversible change".into(),
            ));
        }

        let inverse_id = create_change_set(
            &mut tx,
            "user_correction",
            request
                .reason
                .as_deref()
                .unwrap_or("Rollback an auditable model change"),
            &request.audit,
        )
        .await?;
        let operations = sqlx::query(
            "SELECT sequence, operation_type, target_ref, before_json, after_json, inverse_json \
             FROM change_operations WHERE change_set_id=? ORDER BY sequence DESC",
        )
        .bind(&request.change_set_id)
        .fetch_all(&mut *tx)
        .await?;
        let mut results = Vec::new();
        for (inverse_sequence, operation) in operations.into_iter().enumerate() {
            let operation_type: String = operation.try_get("operation_type")?;
            let target_ref: Option<String> = operation.try_get("target_ref")?;
            let before_json: Option<String> = operation.try_get("before_json")?;
            let after_json: Option<String> = operation.try_get("after_json")?;
            let target = target_ref
                .ok_or_else(|| AppError::Internal("operation missing target_ref".into()))?;

            let restored = match operation_type.as_str() {
                "create_node" => {
                    sqlx::query(
                        "UPDATE nodes SET status='revoked', deleted_at=?, valid_to=?, updated_at=? WHERE id=?",
                    )
                    .bind(&now)
                    .bind(&now)
                    .bind(&now)
                    .bind(&target)
                    .execute(&mut *tx)
                    .await?;
                    fetch_node_tx(&mut tx, &target).await?.to_value()
                }
                "update_node" | "close_node" => {
                    let before: Value =
                        serde_json::from_str(before_json.as_deref().ok_or_else(|| {
                            AppError::Internal("rollback snapshot missing".into())
                        })?)?;
                    restore_node_tx(&mut tx, &before).await?;
                    fetch_node_tx(&mut tx, &target).await?.to_value()
                }
                "create_edge" => {
                    sqlx::query(
                        "UPDATE edges SET status='deleted', valid_to=?, updated_at=? WHERE id=?",
                    )
                    .bind(&now)
                    .bind(&now)
                    .bind(&target)
                    .execute(&mut *tx)
                    .await?;
                    fetch_edge_tx(&mut tx, &target).await?.to_value()
                }
                "close_edge" => {
                    let before: Value =
                        serde_json::from_str(before_json.as_deref().ok_or_else(|| {
                            AppError::Internal("edge rollback snapshot missing".into())
                        })?)?;
                    restore_edge_tx(&mut tx, &before).await?;
                    fetch_edge_tx(&mut tx, &target).await?.to_value()
                }
                "enqueue_claim_revision" => {
                    sqlx::query("DELETE FROM claim_revision_queue WHERE id=?")
                        .bind(&target)
                        .execute(&mut *tx)
                        .await?;
                    json!({ "id": target, "status": "removed_by_rollback" })
                }
                "resolve_claim_revision" => {
                    let before: Value =
                        serde_json::from_str(before_json.as_deref().ok_or_else(|| {
                            AppError::Internal("revision rollback snapshot missing".into())
                        })?)?;
                    sqlx::query(
                        "UPDATE claim_revision_queue SET effect=?, proposed_statement=?, status=?, \
                         resolution_json=?, resolution_change_set_id=?, resolved_at=? WHERE id=?",
                    )
                    .bind(before.get("effect").and_then(Value::as_str))
                    .bind(before.get("proposedStatement").and_then(Value::as_str))
                    .bind(before.get("status").and_then(Value::as_str))
                    .bind(
                        before
                            .get("resolution")
                            .filter(|value| !value.is_null())
                            .map(serde_json::to_string)
                            .transpose()?,
                    )
                    .bind(
                        before
                            .get("resolutionChangeSetId")
                            .and_then(Value::as_str),
                    )
                    .bind(before.get("resolvedAt").and_then(Value::as_str))
                    .bind(&target)
                    .execute(&mut *tx)
                    .await?;
                    before
                }
                "upsert_star_state" => {
                    let after: Value =
                        serde_json::from_str(after_json.as_deref().ok_or_else(|| {
                            AppError::Internal("star rollback after snapshot missing".into())
                        })?)?;
                    let version =
                        after
                            .get("version")
                            .and_then(Value::as_i64)
                            .ok_or_else(|| {
                                AppError::Internal("star snapshot missing version".into())
                            })?;
                    sqlx::query(
                        "DELETE FROM star_state_evidence_links WHERE center_node_id=? AND star_version=?",
                    )
                    .bind(&target)
                    .bind(version)
                    .execute(&mut *tx)
                    .await?;
                    sqlx::query("DELETE FROM star_states WHERE center_node_id=? AND version=?")
                        .bind(&target)
                        .bind(version)
                        .execute(&mut *tx)
                        .await?;
                    if let Some(raw) = before_json.as_deref() {
                        let before: Value = serde_json::from_str(raw)?;
                        let prior_version = before
                            .get("version")
                            .and_then(Value::as_i64)
                            .ok_or_else(|| {
                                AppError::Internal("prior star snapshot missing version".into())
                            })?;
                        sqlx::query(
                            "UPDATE star_states SET state_status=?, recompute_required=?, \
                             valid_to=?, updated_at=? WHERE center_node_id=? AND version=?",
                        )
                        .bind(before.get("stateStatus").and_then(Value::as_str))
                        .bind(
                            before
                                .get("recomputeRequired")
                                .and_then(Value::as_bool)
                                .unwrap_or(false) as i64,
                        )
                        .bind(before.get("validTo").and_then(Value::as_str))
                        .bind(before.get("updatedAt").and_then(Value::as_str))
                        .bind(&target)
                        .bind(prior_version)
                        .execute(&mut *tx)
                        .await?;
                        before
                    } else {
                        json!({ "centerNodeId": target, "status": "removed_by_rollback" })
                    }
                }
                "create_weekly_review" => {
                    sqlx::query("DELETE FROM weekly_reviews WHERE id=?")
                        .bind(&target)
                        .execute(&mut *tx)
                        .await?;
                    json!({ "id": target, "status": "removed_by_rollback" })
                }
                "link_node_evidence" => {
                    let after: Value =
                        serde_json::from_str(after_json.as_deref().ok_or_else(|| {
                            AppError::Internal("evidence link snapshot missing".into())
                        })?)?;
                    sqlx::query(
                        "DELETE FROM node_evidence_links WHERE node_id=? AND evidence_ref_id=? AND role=?",
                    )
                    .bind(after.get("nodeId").and_then(Value::as_str))
                    .bind(after.get("evidenceRefId").and_then(Value::as_str))
                    .bind(after.get("role").and_then(Value::as_str))
                    .execute(&mut *tx)
                    .await?;
                    json!({ "status": "removed_by_rollback" })
                }
                "create_evidence" => {
                    sqlx::query("UPDATE evidence_refs SET retracted_at=? WHERE id=?")
                        .bind(&now)
                        .bind(&target)
                        .execute(&mut *tx)
                        .await?;
                    json!({ "id": target, "retractedAt": now })
                }
                "create_source" => {
                    sqlx::query("UPDATE source_records SET deleted_at=? WHERE id=?")
                        .bind(&now)
                        .bind(&target)
                        .execute(&mut *tx)
                        .await?;
                    json!({ "id": target, "deletedAt": now })
                }
                other => {
                    return Err(AppError::Conflict(format!(
                        "rollback for {other} is not implemented"
                    )))
                }
            };
            let prior_after = after_json
                .as_deref()
                .and_then(|raw| serde_json::from_str(raw).ok());
            insert_operation(
                &mut tx,
                &inverse_id,
                inverse_sequence as i64,
                match operation_type.as_str() {
                    "create_edge" => "close_edge",
                    "close_edge" => "update_edge",
                    "enqueue_claim_revision" => "resolve_claim_revision",
                    "resolve_claim_revision" => "resolve_claim_revision",
                    "upsert_star_state" => "upsert_star_state",
                    "create_weekly_review" => "remove_weekly_review",
                    "create_evidence" => "retract_evidence",
                    "create_source" => "delete_source",
                    "link_node_evidence" => "link_node_evidence",
                    _ => "update_node",
                },
                &target,
                prior_after.as_ref(),
                Some(&restored),
                prior_after.as_ref(),
            )
            .await?;
            results.push(restored);
        }
        sqlx::query(
            "UPDATE change_sets SET status='rolled_back', inverse_change_set_id=? WHERE id=?",
        )
        .bind(&inverse_id)
        .bind(&request.change_set_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE change_sets SET reversible=0 WHERE id=?")
            .bind(&inverse_id)
            .execute(&mut *tx)
            .await?;
        apply_change_set(&mut tx, &inverse_id, &now).await?;
        let response = MutationResponse {
            ok: true,
            change_set_id: inverse_id,
            value: json!({ "rolledBackChangeSetId": request.change_set_id, "results": results }),
        };
        complete_idempotency(&mut tx, idempotency, &response, &now).await?;
        tx.commit().await?;
        Ok(response)
    }

    pub async fn apply_feedback(
        &self,
        request: ApplyFeedbackRequest,
        idempotency: Option<&IdempotencyContext>,
    ) -> AppResult<MutationResponse> {
        request.audit.validate().map_err(AppError::Invalid)?;
        validate_choice(
            "feedbackType",
            &request.feedback_type,
            &["confirm", "reject", "correct", "outcome"],
        )?;
        validate_non_empty("targetNodeId", &request.target_node_id)?;
        if request.feedback_type == "outcome" {
            let outcome = request
                .outcome
                .ok_or_else(|| AppError::Invalid("outcome feedback requires outcome".into()))?;
            return self
                .record_outcome(
                    OutcomeRequest {
                        client_request_id: request.client_request_id,
                        action_id: outcome.action_id,
                        label: Some("用户反馈的行动结果".into()),
                        outcome: outcome.outcome,
                        observed_at: outcome.observed_at,
                        effect: outcome.effect,
                        claim_id: outcome.claim_id,
                        revised_statement: outcome.revised_statement,
                        revised_scope: outcome.revised_scope,
                        evidence_refs: outcome.evidence_refs,
                        payload: outcome.payload,
                        audit: request.audit,
                    },
                    idempotency,
                )
                .await;
        }
        if !matches!(request.audit.actor.as_str(), "user" | "model") {
            return Err(AppError::Invalid(
                "confirm/reject/correct feedback requires a direct user actor or a model executor with verified user evidence"
                    .into(),
            ));
        }
        if request.feedback_type == "correct" {
            validate_non_empty(
                "correctedStatement",
                request.corrected_statement.as_deref().unwrap_or_default(),
            )?;
        }
        if let Some(scope) = &request.corrected_scope {
            validate_json_object("correctedScope", scope)?;
        }

        let now = now_iso();
        let mut tx = self.pool.begin().await?;
        if let Some(cached) = begin_idempotency(&mut tx, idempotency).await? {
            return Ok(cached);
        }
        let target_before = fetch_node_tx(&mut tx, &request.target_node_id).await?;
        if target_before.deleted_at.is_some()
            || matches!(target_before.status.as_str(), "revoked" | "deleted")
        {
            return Err(AppError::Conflict(
                "feedback target has been retracted".into(),
            ));
        }
        if request.feedback_type == "correct"
            && !matches!(target_before.kind.as_str(), "claim" | "resource")
        {
            return Err(AppError::Invalid(
                "correct feedback versions claims or records a resource curator preference".into(),
            ));
        }
        let reason_type = if request.feedback_type == "confirm" {
            "user_confirmation"
        } else {
            "user_correction"
        };
        let change_set_id = create_change_set(
            &mut tx,
            reason_type,
            &format!(
                "Apply explicit user {} feedback to {}",
                request.feedback_type, request.target_node_id
            ),
            &request.audit,
        )
        .await?;
        let mut sequence = 0_i64;
        let mut feedback_ref = None;
        let mut evidence_sources: Vec<(String, Option<String>)> = Vec::new();
        let mut seen = HashSet::new();
        if request.audit.actor == "user" {
            let (created_ref, feedback_event) = create_inline_feedback_evidence_tx(
                &mut tx,
                &request.target_node_id,
                &request.feedback_type,
                None,
                &request.audit,
                &change_set_id,
                &mut sequence,
                &now,
            )
            .await?;
            feedback_ref = Some(created_ref.clone());
            seen.insert(created_ref.clone());
            evidence_sources.push((created_ref, Some(feedback_event)));
        }
        let mut has_verified_user_evidence = request.audit.actor == "user";
        for evidence_ref in &request.evidence_refs {
            if seen.insert(evidence_ref.clone()) {
                let attribution = sqlx::query(
                    "SELECT actor_role, attribution_status, retracted_at FROM evidence_refs WHERE id=?",
                )
                .bind(evidence_ref)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| AppError::NotFound(format!("evidenceRef {evidence_ref}")))?;
                if attribution.get::<String, _>("actor_role") == "user"
                    && attribution.get::<String, _>("attribution_status") == "verified"
                    && attribution
                        .get::<Option<String>, _>("retracted_at")
                        .is_none()
                {
                    has_verified_user_evidence = true;
                }
                evidence_sources.push((
                    evidence_ref.clone(),
                    validate_and_source_evidence_tx(&mut tx, evidence_ref).await?,
                ));
            }
        }
        if request.audit.actor == "model" && evidence_sources.is_empty() {
            return Err(AppError::Invalid(
                "model-executed feedback requires at least one valid EvidenceRef".into(),
            ));
        }
        if request.audit.actor == "model"
            && target_before.kind == "resource"
            && !has_verified_user_evidence
        {
            return Err(AppError::Invalid(
                "a model cannot invent a curator preference without verified user evidence".into(),
            ));
        }

        let model_inferred_feedback = request.audit.actor == "model" && !has_verified_user_evidence;
        let (authority, origin) = if target_before.kind == "resource" {
            ("user_stated", "user")
        } else if model_inferred_feedback {
            ("system_inferred", "model")
        } else if request.feedback_type == "confirm" {
            ("user_confirmed", "user")
        } else {
            ("user_corrected", "user")
        };
        let mut previous_claim = Value::Null;
        let mut curator_preference = Value::Null;
        let mut applied_node;
        let effective_target_id;
        if target_before.kind == "resource" {
            let resource_payload: Value =
                serde_json::from_str(&target_before.payload_json).unwrap_or_else(|_| json!({}));
            let curator_feedback = request
                .corrected_scope
                .as_ref()
                .and_then(|scope| scope.get("curatorFeedback"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            let feedback_marker = curator_feedback
                .get("feedback")
                .and_then(Value::as_str)
                .unwrap_or(request.feedback_type.as_str());
            let signal = match feedback_marker {
                "new-angle" | "confirm" | "positive" => "positive",
                "known" | "already-known" | "already_known" => "already_known",
                "not-useful" | "reject" | "negative" => "negative",
                _ if request.feedback_type == "reject" => "negative",
                _ => "corrected",
            };
            let preference_id = new_id("node");
            let preference_payload = json!({
                "preferenceType": "curator_preference",
                "signal": signal,
                "targetResourceId": request.target_node_id,
                "url": resource_payload.get("url").cloned().unwrap_or(Value::Null),
                "provider": resource_payload.get("provider").cloned().unwrap_or(Value::Null),
                "contentHash": resource_payload.get("contentHash").cloned().unwrap_or(Value::Null),
                "query": resource_payload.get("query").cloned().unwrap_or(Value::Null),
                "reason": curator_feedback.get("reason").cloned().unwrap_or(Value::Null),
                "curatorFeedback": curator_feedback,
                "recordedAt": now,
            });
            let preference_scope = request.corrected_scope.clone().unwrap_or_else(|| json!({}));
            let statement = request.corrected_statement.clone().unwrap_or_else(|| {
                format!("用户对资讯“{}”给出 {signal} 策展信号", target_before.label)
            });
            insert_node_with_provenance(
                &mut tx,
                NewNode {
                    id: &preference_id,
                    kind: "interest",
                    label: "Feed 策展偏好",
                    statement: Some(&statement),
                    payload: &preference_payload,
                    scope: &preference_scope,
                    sensitivity: &target_before.sensitivity,
                    expected_outcome: None,
                    review_at: None,
                    outcome: None,
                    status: "active",
                    now: &now,
                },
                "user_stated",
                "user",
            )
            .await?;
            applied_node = fetch_node_tx(&mut tx, &preference_id).await?.to_value();
            curator_preference = applied_node.clone();
            insert_operation(
                &mut tx,
                &change_set_id,
                sequence,
                "create_node",
                &preference_id,
                None,
                Some(&applied_node),
                Some(&json!({ "operation": "soft_retract", "targetRef": preference_id })),
            )
            .await?;
            sequence += 1;
            let preference_edge_id = create_edge_with_semantics_tx(
                &mut tx,
                &preference_id,
                &request.target_node_id,
                EdgeSemantics {
                    family: "semantic",
                    relation_type: "about",
                    direction: "directed",
                    proximity: "direct",
                    strength: "strong",
                    basis: "user_confirmation",
                    authority: "user_stated",
                    status: "active",
                    rationale:
                        "Curator preference targets this resource without changing source trust",
                },
                &preference_scope,
                &now,
            )
            .await?;
            let preference_edge = fetch_edge_tx(&mut tx, &preference_edge_id)
                .await?
                .to_value();
            insert_operation(
                &mut tx,
                &change_set_id,
                sequence,
                "create_edge",
                &preference_edge_id,
                None,
                Some(&preference_edge),
                Some(&json!({ "operation": "soft_close_edge", "targetRef": preference_edge_id })),
            )
            .await?;
            sequence += 1;
            effective_target_id = preference_id;
        } else if request.feedback_type == "correct"
            || (target_before.kind == "claim" && model_inferred_feedback)
        {
            previous_claim = target_before.to_value();
            sqlx::query(
                "UPDATE nodes SET status='superseded', valid_to=?, superseded_at=?, authority=?, \
                 origin=?, updated_at=? WHERE id=?",
            )
            .bind(&now)
            .bind(&now)
            .bind(authority)
            .bind(origin)
            .bind(&now)
            .bind(&request.target_node_id)
            .execute(&mut *tx)
            .await?;
            let old_after = fetch_node_tx(&mut tx, &request.target_node_id)
                .await?
                .to_value();
            insert_operation(
                &mut tx,
                &change_set_id,
                sequence,
                "update_node",
                &request.target_node_id,
                Some(&previous_claim),
                Some(&old_after),
                Some(&json!({ "operation": "restore_node", "node": previous_claim })),
            )
            .await?;
            sequence += 1;

            let new_id = new_id("node");
            let mut payload: Value =
                serde_json::from_str(&target_before.payload_json).unwrap_or_else(|_| json!({}));
            if let Some(object) = payload.as_object_mut() {
                object.insert(
                    "supersedesClaimId".into(),
                    Value::String(request.target_node_id.clone()),
                );
                object.insert(
                    "revisionCause".into(),
                    Value::String(if model_inferred_feedback {
                        "model_evidence_revision".into()
                    } else {
                        "user_feedback".into()
                    }),
                );
                object.insert(
                    "revisionEffect".into(),
                    Value::String(request.feedback_type.clone()),
                );
                if request.feedback_type == "confirm" {
                    let current = object
                        .get("confidenceBand")
                        .or_else(|| object.get("confidence"))
                        .and_then(Value::as_str)
                        .unwrap_or("weak");
                    object.insert(
                        "confidenceBand".into(),
                        Value::String(strengthen_confidence_band(current).into()),
                    );
                }
            }
            let scope = request.corrected_scope.clone().unwrap_or_else(|| {
                serde_json::from_str(&target_before.scope_json).unwrap_or_else(|_| json!({}))
            });
            insert_node_with_provenance(
                &mut tx,
                NewNode {
                    id: &new_id,
                    kind: "claim",
                    label: &target_before.label,
                    statement: request
                        .corrected_statement
                        .as_deref()
                        .or(target_before.statement.as_deref()),
                    payload: &payload,
                    scope: &scope,
                    sensitivity: &target_before.sensitivity,
                    expected_outcome: None,
                    review_at: None,
                    outcome: None,
                    status: if request.feedback_type == "reject" {
                        "unsupported"
                    } else {
                        "active"
                    },
                    now: &now,
                },
                authority,
                origin,
            )
            .await?;
            applied_node = fetch_node_tx(&mut tx, &new_id).await?.to_value();
            insert_operation(
                &mut tx,
                &change_set_id,
                sequence,
                "create_node",
                &new_id,
                None,
                Some(&applied_node),
                Some(&json!({ "operation": "soft_retract", "targetRef": new_id })),
            )
            .await?;
            sequence += 1;
            let lineage_edge = create_edge_with_semantics_tx(
                &mut tx,
                &new_id,
                &request.target_node_id,
                EdgeSemantics {
                    family: "lineage",
                    relation_type: "supersedes",
                    direction: "directed",
                    proximity: "direct",
                    strength: "strong",
                    basis: if model_inferred_feedback {
                        "contextual"
                    } else {
                        "user_confirmation"
                    },
                    authority,
                    status: "active",
                    rationale: "Explicit user correction creates a new claim version",
                },
                &scope,
                &now,
            )
            .await?;
            let lineage = fetch_edge_tx(&mut tx, &lineage_edge).await?.to_value();
            insert_operation(
                &mut tx,
                &change_set_id,
                sequence,
                "create_edge",
                &lineage_edge,
                None,
                Some(&lineage),
                Some(&json!({ "operation": "soft_close_edge", "targetRef": lineage_edge })),
            )
            .await?;
            sequence += 1;
            effective_target_id = new_id;
        } else {
            let status = if request.feedback_type == "reject" {
                "rejected"
            } else {
                "active"
            };
            sqlx::query(
                "UPDATE nodes SET status=?, authority=?, origin=?, updated_at=? WHERE id=?",
            )
            .bind(status)
            .bind(authority)
            .bind(origin)
            .bind(&now)
            .bind(&request.target_node_id)
            .execute(&mut *tx)
            .await?;
            applied_node = fetch_node_tx(&mut tx, &request.target_node_id)
                .await?
                .to_value();
            let before = target_before.to_value();
            insert_operation(
                &mut tx,
                &change_set_id,
                sequence,
                "update_node",
                &request.target_node_id,
                Some(&before),
                Some(&applied_node),
                Some(&json!({ "operation": "restore_node", "node": before })),
            )
            .await?;
            sequence += 1;
            effective_target_id = request.target_node_id.clone();
        }

        let evidence_role =
            if target_before.kind == "resource" || request.feedback_type == "confirm" {
                "support"
            } else {
                "correction"
            };
        let relation = if target_before.kind == "resource" {
            "supports"
        } else {
            match request.feedback_type.as_str() {
                "confirm" => "updates_confirms",
                "reject" => "contradicts",
                _ => "updates_revises",
            }
        };
        for (evidence_ref, source_node_id) in &evidence_sources {
            sqlx::query(
                "INSERT OR IGNORE INTO node_evidence_links(node_id, evidence_ref_id, role, created_at) \
                 VALUES (?, ?, ?, ?)",
            )
            .bind(&effective_target_id)
            .bind(evidence_ref)
            .bind(evidence_role)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT OR IGNORE INTO change_evidence_links(change_set_id, evidence_ref_id, created_at) \
                 VALUES (?, ?, ?)",
            )
            .bind(&change_set_id)
            .bind(evidence_ref)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            if let Some(source_node_id) = source_node_id {
                let edge_id = create_evidenced_edge_tx(
                    &mut tx,
                    source_node_id,
                    &effective_target_id,
                    "epistemic",
                    relation,
                    "Explicit user feedback is preserved as evidence for this change",
                    &json!({}),
                    evidence_ref,
                    authority,
                    &now,
                )
                .await?;
                let edge = fetch_edge_tx(&mut tx, &edge_id).await?.to_value();
                insert_operation(
                    &mut tx,
                    &change_set_id,
                    sequence,
                    "create_edge",
                    &edge_id,
                    None,
                    Some(&edge),
                    Some(&json!({ "operation": "soft_close_edge", "targetRef": edge_id })),
                )
                .await?;
                sequence += 1;
            }
        }
        if target_before.kind == "claim" {
            let (before_star, after_star) =
                upsert_star_state_tx(&mut tx, &effective_target_id, &now).await?;
            insert_operation(
                &mut tx,
                &change_set_id,
                sequence,
                "upsert_star_state",
                &effective_target_id,
                before_star.as_ref(),
                Some(&after_star),
                before_star.as_ref(),
            )
            .await?;
        }
        if let Some(object) = applied_node.as_object_mut() {
            object.insert(
                "evidenceRefs".into(),
                serde_json::to_value(
                    evidence_sources
                        .iter()
                        .map(|(id, _)| id)
                        .collect::<Vec<_>>(),
                )?,
            );
        }
        apply_change_set(&mut tx, &change_set_id, &now).await?;
        let response = MutationResponse {
            ok: true,
            change_set_id,
            value: json!({
                "feedbackType": request.feedback_type,
                "targetNodeId": request.target_node_id,
                "appliedNode": applied_node,
                "curatorPreference": curator_preference,
                "previousClaim": previous_claim,
                "feedbackEvidenceRefId": feedback_ref,
            }),
        };
        complete_idempotency(&mut tx, idempotency, &response, &now).await?;
        tx.commit().await?;
        Ok(response)
    }

    pub async fn create_candidate(
        &self,
        request: CandidateCreateRequest,
        idempotency: Option<&IdempotencyContext>,
    ) -> AppResult<MutationResponse> {
        request.audit.validate().map_err(AppError::Invalid)?;
        validate_non_empty("label", &request.label)?;
        validate_non_empty("statement", &request.statement)?;
        validate_choice("sensitivity", &request.sensitivity, SENSITIVITIES)?;
        validate_json_object("payload", &request.payload)?;
        validate_json_object("scope", &request.scope)?;
        if request.source_node_ids.len() > 64 {
            return Err(AppError::Invalid(
                "sourceNodeIds cannot contain more than 64 nodes".into(),
            ));
        }
        if request.evidence_refs.len() > 64 {
            return Err(AppError::Invalid(
                "evidenceRefs cannot contain more than 64 refs".into(),
            ));
        }
        validate_unique_non_empty("sourceNodeIds", &request.source_node_ids)?;
        validate_unique_non_empty("evidenceRefs", &request.evidence_refs)?;

        let entered_at = Utc::now();
        let now = entered_at.to_rfc3339_opts(SecondsFormat::Millis, true);
        let proposed_silence_due_at =
            (entered_at + ChronoDuration::days(3)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let candidate_id = new_id("candidate");
        let mut candidate_payload = request.payload.clone();
        let payload = candidate_payload
            .as_object_mut()
            .ok_or_else(|| AppError::Invalid("payload must be a JSON object".into()))?;
        payload.insert("candidateState".into(), Value::String("proposed".into()));
        payload.insert("interventionType".into(), Value::String("candidate".into()));
        payload.insert("stateEnteredAt".into(), Value::String(now.clone()));
        payload.insert(
            "sourceNodeIds".into(),
            serde_json::to_value(&request.source_node_ids)?,
        );
        payload.insert(
            "proposedSilenceDueAt".into(),
            Value::String(proposed_silence_due_at.clone()),
        );
        payload.remove("shapingFollowupDueAt");
        payload.remove("shapingPromptedAt");

        let mut tx = self.pool.begin().await?;
        if let Some(cached) = begin_idempotency(&mut tx, idempotency).await? {
            return Ok(cached);
        }
        for source_node_id in &request.source_node_ids {
            let source = fetch_node_tx(&mut tx, source_node_id).await?;
            if source.deleted_at.is_some()
                || matches!(source.status.as_str(), "revoked" | "deleted")
            {
                return Err(AppError::Conflict(format!(
                    "source node {source_node_id} is retracted"
                )));
            }
        }
        let mut evidence_sources = Vec::with_capacity(request.evidence_refs.len());
        for evidence_ref in &request.evidence_refs {
            evidence_sources.push((
                evidence_ref.clone(),
                validate_and_source_evidence_tx(&mut tx, evidence_ref).await?,
            ));
        }

        let change_set_id = create_change_set(
            &mut tx,
            "extraction",
            &format!(
                "Propose co-creation candidate with a three-day silence clock: {}",
                request.label.trim()
            ),
            &request.audit,
        )
        .await?;
        let (authority, origin) = provenance_for_audit(&request.audit, false);
        insert_node_with_provenance(
            &mut tx,
            NewNode {
                id: &candidate_id,
                kind: "experiment",
                label: request.label.trim(),
                statement: Some(request.statement.trim()),
                payload: &candidate_payload,
                scope: &request.scope,
                sensitivity: &request.sensitivity,
                expected_outcome: None,
                review_at: None,
                outcome: None,
                status: "proposed",
                now: &now,
            },
            authority,
            origin,
        )
        .await?;
        let candidate = fetch_node_tx(&mut tx, &candidate_id).await?.to_value();
        insert_operation(
            &mut tx,
            &change_set_id,
            0,
            "create_node",
            &candidate_id,
            None,
            Some(&candidate),
            Some(&json!({ "operation": "soft_retract", "targetRef": candidate_id })),
        )
        .await?;

        let mut sequence = 1_i64;
        let mut source_edges = Vec::new();
        for source_node_id in &request.source_node_ids {
            let edge_id = create_edge_with_semantics_tx(
                &mut tx,
                &candidate_id,
                source_node_id,
                EdgeSemantics {
                    family: "provenance",
                    relation_type: "derived_from",
                    direction: "directed",
                    proximity: "direct",
                    strength: "medium",
                    basis: "contextual",
                    authority,
                    status: "active",
                    rationale: "Candidate was proposed from this explicit source node",
                },
                &request.scope,
                &now,
            )
            .await?;
            let edge = fetch_edge_tx(&mut tx, &edge_id).await?.to_value();
            insert_operation(
                &mut tx,
                &change_set_id,
                sequence,
                "create_edge",
                &edge_id,
                None,
                Some(&edge),
                Some(&json!({ "operation": "soft_close_edge", "targetRef": edge_id })),
            )
            .await?;
            sequence += 1;
            source_edges.push(edge);
        }

        let mut evidence_edges = Vec::new();
        for (evidence_ref, source_node_id) in &evidence_sources {
            sqlx::query(
                "INSERT INTO node_evidence_links(node_id, evidence_ref_id, role, created_at) \
                 VALUES (?, ?, 'origin', ?)",
            )
            .bind(&candidate_id)
            .bind(evidence_ref)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT OR IGNORE INTO change_evidence_links(change_set_id, evidence_ref_id, created_at) \
                 VALUES (?, ?, ?)",
            )
            .bind(&change_set_id)
            .bind(evidence_ref)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            let link = json!({
                "nodeId": candidate_id,
                "evidenceRefId": evidence_ref,
                "role": "origin",
                "createdAt": now,
            });
            insert_operation(
                &mut tx,
                &change_set_id,
                sequence,
                "link_node_evidence",
                &format!("{candidate_id}:{evidence_ref}:origin"),
                None,
                Some(&link),
                Some(&json!({
                    "operation": "unlink_node_evidence",
                    "nodeId": candidate_id,
                    "evidenceRefId": evidence_ref,
                    "role": "origin"
                })),
            )
            .await?;
            sequence += 1;

            if let Some(source_node_id) = source_node_id {
                let edge_id = create_evidenced_edge_tx(
                    &mut tx,
                    source_node_id,
                    &candidate_id,
                    "provenance",
                    "supports",
                    "This candidate is grounded in the exact EvidenceRef",
                    &request.scope,
                    evidence_ref,
                    authority,
                    &now,
                )
                .await?;
                let edge = fetch_edge_tx(&mut tx, &edge_id).await?.to_value();
                insert_operation(
                    &mut tx,
                    &change_set_id,
                    sequence,
                    "create_edge",
                    &edge_id,
                    None,
                    Some(&edge),
                    Some(&json!({ "operation": "soft_close_edge", "targetRef": edge_id })),
                )
                .await?;
                sequence += 1;
                evidence_edges.push(edge);
            }
        }

        apply_change_set(&mut tx, &change_set_id, &now).await?;
        let response = MutationResponse {
            ok: true,
            change_set_id: change_set_id.clone(),
            value: json!({
                "candidate": candidate,
                "sourceEdges": source_edges,
                "evidenceEdges": evidence_edges,
                "receipt": {
                    "command": "create",
                    "previousState": null,
                    "state": "proposed",
                    "recordedAt": now,
                    "proposedSilenceDueAt": proposed_silence_due_at,
                    "changeSetId": change_set_id,
                }
            }),
        };
        complete_idempotency(&mut tx, idempotency, &response, &now).await?;
        tx.commit().await?;
        Ok(response)
    }

    pub async fn command_candidate(
        &self,
        candidate_id: &str,
        request: CandidateCommandRequest,
        idempotency: Option<&IdempotencyContext>,
    ) -> AppResult<MutationResponse> {
        request.audit.validate().map_err(AppError::Invalid)?;
        validate_non_empty("candidateId", candidate_id)?;
        validate_choice(
            "command",
            &request.command,
            &["touch", "shape", "conclude", "park", "acknowledge_due"],
        )?;
        if let Some(note) = &request.note {
            validate_non_empty("note", note)?;
        }
        if request.evidence_refs.len() > 64 {
            return Err(AppError::Invalid(
                "evidenceRefs cannot contain more than 64 refs".into(),
            ));
        }
        validate_unique_non_empty("evidenceRefs", &request.evidence_refs)?;

        let at = Utc::now();
        let now = at.to_rfc3339_opts(SecondsFormat::Millis, true);
        let mut tx = self.pool.begin().await?;
        if let Some(cached) = begin_idempotency(&mut tx, idempotency).await? {
            return Ok(cached);
        }
        let before = fetch_node_tx(&mut tx, candidate_id).await?;
        let before_payload: Value = serde_json::from_str(&before.payload_json)?;
        if before.kind != "experiment"
            || before_payload
                .get("interventionType")
                .and_then(Value::as_str)
                != Some("candidate")
        {
            return Err(AppError::Invalid(
                "candidateId must reference a candidate node".into(),
            ));
        }
        if before.deleted_at.is_some() || matches!(before.status.as_str(), "revoked" | "deleted") {
            return Err(AppError::Conflict(
                "cannot command a retracted candidate; rollback it first".into(),
            ));
        }
        let payload_state = before_payload
            .get("candidateState")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::Conflict(
                    "candidate payload is missing candidateState; repair the profile before transition"
                        .into(),
                )
            })?;
        let expected_node_status = candidate_node_status(payload_state)
            .ok_or_else(|| AppError::Conflict(format!("unknown candidateState {payload_state}")))?;
        if expected_node_status != before.status {
            return Err(AppError::Conflict(format!(
                "candidate state mismatch: node status={} payload state={payload_state}",
                before.status
            )));
        }

        let next_state = match (payload_state, request.command.as_str()) {
            ("proposed", "touch") => "touched",
            // Parking is a reversible pause; reopening does not confirm a conclusion.
            ("parked", "touch") => "touched",
            ("proposed", "park") => "parked",
            ("proposed", "acknowledge_due") => "proposed",
            ("touched", "shape") => "shaping",
            ("touched", "conclude") => "concluded",
            ("touched", "park") => "parked",
            ("shaping", "conclude") => "concluded",
            ("shaping", "park") => "parked",
            ("shaping", "acknowledge_due") => "shaping",
            _ => {
                return Err(AppError::Conflict(format!(
                    "command {} is not legal from candidate state {payload_state}",
                    request.command
                )))
            }
        };

        if request.command == "acknowledge_due" {
            let (prompted_field, due_field, due_label) = match payload_state {
                "proposed" => (
                    "proposedPromptedAt",
                    "proposedSilenceDueAt",
                    "proposed silence prompt",
                ),
                "shaping" => (
                    "shapingPromptedAt",
                    "shapingFollowupDueAt",
                    "shaping follow-up",
                ),
                _ => {
                    return Err(AppError::Conflict(format!(
                        "candidate state {payload_state} has no due prompt to acknowledge"
                    )))
                }
            };
            if before_payload.get(prompted_field).is_some() {
                return Err(AppError::Conflict(format!(
                    "the {due_label} has already been acknowledged"
                )));
            }
            let due_at = before_payload
                .get(due_field)
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::Conflict(format!("candidate has no {due_label} due clock"))
                })?;
            let due_at = chrono::DateTime::parse_from_rfc3339(due_at)
                .map_err(|_| AppError::Conflict(format!("candidate {due_label} clock is invalid")))?
                .with_timezone(&Utc);
            if due_at > at {
                return Err(AppError::Conflict(format!(
                    "the {due_label} is not due yet"
                )));
            }
        }

        let mut evidence_sources = Vec::with_capacity(request.evidence_refs.len());
        for evidence_ref in &request.evidence_refs {
            evidence_sources.push((
                evidence_ref.clone(),
                validate_and_source_evidence_tx(&mut tx, evidence_ref).await?,
            ));
        }
        let change_set_id = create_change_set(
            &mut tx,
            "user_correction",
            &format!(
                "Apply typed candidate command {} from {} to {}",
                request.command, payload_state, next_state
            ),
            &request.audit,
        )
        .await?;

        let mut next_payload = before_payload.clone();
        let payload = next_payload
            .as_object_mut()
            .ok_or_else(|| AppError::Conflict("candidate payload is not an object".into()))?;
        payload.insert("lastCommand".into(), Value::String(request.command.clone()));
        payload.insert("lastCommandAt".into(), Value::String(now.clone()));
        if let Some(note) = request.note.as_deref() {
            payload.insert("lastNote".into(), Value::String(note.trim().to_string()));
        }
        if request.command == "acknowledge_due" {
            let prompted_field = if payload_state == "proposed" {
                "proposedPromptedAt"
            } else {
                "shapingPromptedAt"
            };
            payload.insert(prompted_field.into(), Value::String(now.clone()));
        } else {
            payload.insert(
                "candidateState".into(),
                Value::String(next_state.to_string()),
            );
            payload.insert("stateEnteredAt".into(), Value::String(now.clone()));
            payload.insert("lastTransitionAt".into(), Value::String(now.clone()));
            payload.remove("proposedSilenceDueAt");
            payload.remove("proposedPromptedAt");
            payload.remove("shapingFollowupDueAt");
            payload.remove("shapingPromptedAt");
            if next_state == "shaping" {
                payload.insert(
                    "shapingFollowupDueAt".into(),
                    Value::String(
                        (at + ChronoDuration::days(7)).to_rfc3339_opts(SecondsFormat::Millis, true),
                    ),
                );
            }
        }

        let (authority, origin) = if request.command == "acknowledge_due" {
            (before.authority.as_str(), before.origin.as_str())
        } else {
            provenance_for_audit(&request.audit, true)
        };
        sqlx::query(
            "UPDATE nodes SET payload_json=?, status=?, authority=?, origin=?, updated_at=? WHERE id=?",
        )
        .bind(serde_json::to_string(&next_payload)?)
        .bind(candidate_node_status(next_state).ok_or_else(|| {
            AppError::Internal(format!("missing node status mapping for {next_state}"))
        })?)
        .bind(authority)
        .bind(origin)
        .bind(&now)
        .bind(candidate_id)
        .execute(&mut *tx)
        .await?;
        let before_value = before.to_value();
        let candidate = fetch_node_tx(&mut tx, candidate_id).await?.to_value();
        insert_operation(
            &mut tx,
            &change_set_id,
            0,
            "update_node",
            candidate_id,
            Some(&before_value),
            Some(&candidate),
            Some(&json!({ "operation": "restore_node", "node": before_value })),
        )
        .await?;

        let mut sequence = 1_i64;
        let mut evidence_edges = Vec::new();
        for (evidence_ref, source_node_id) in &evidence_sources {
            sqlx::query(
                "INSERT INTO node_evidence_links(node_id, evidence_ref_id, role, created_at) \
                 VALUES (?, ?, 'support', ?)",
            )
            .bind(candidate_id)
            .bind(evidence_ref)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT OR IGNORE INTO change_evidence_links(change_set_id, evidence_ref_id, created_at) \
                 VALUES (?, ?, ?)",
            )
            .bind(&change_set_id)
            .bind(evidence_ref)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            let link = json!({
                "nodeId": candidate_id,
                "evidenceRefId": evidence_ref,
                "role": "support",
                "createdAt": now,
            });
            insert_operation(
                &mut tx,
                &change_set_id,
                sequence,
                "link_node_evidence",
                &format!("{candidate_id}:{evidence_ref}:support"),
                None,
                Some(&link),
                Some(&json!({
                    "operation": "unlink_node_evidence",
                    "nodeId": candidate_id,
                    "evidenceRefId": evidence_ref,
                    "role": "support"
                })),
            )
            .await?;
            sequence += 1;
            if let Some(source_node_id) = source_node_id {
                let edge_id = create_evidenced_edge_tx(
                    &mut tx,
                    source_node_id,
                    candidate_id,
                    "provenance",
                    "supports",
                    "This candidate transition is grounded in the exact EvidenceRef",
                    &serde_json::from_str(&before.scope_json)?,
                    evidence_ref,
                    authority,
                    &now,
                )
                .await?;
                let edge = fetch_edge_tx(&mut tx, &edge_id).await?.to_value();
                insert_operation(
                    &mut tx,
                    &change_set_id,
                    sequence,
                    "create_edge",
                    &edge_id,
                    None,
                    Some(&edge),
                    Some(&json!({ "operation": "soft_close_edge", "targetRef": edge_id })),
                )
                .await?;
                sequence += 1;
                evidence_edges.push(edge);
            }
        }

        let due_kind = if request.command == "acknowledge_due" {
            Some(if payload_state == "proposed" {
                "proposed_silence"
            } else {
                "shaping_followup"
            })
        } else {
            None
        };
        apply_change_set(&mut tx, &change_set_id, &now).await?;
        let response = MutationResponse {
            ok: true,
            change_set_id: change_set_id.clone(),
            value: json!({
                "candidate": candidate,
                "evidenceEdges": evidence_edges,
                "receipt": {
                    "command": request.command,
                    "previousState": payload_state,
                    "state": next_state,
                    "dueKind": due_kind,
                    "recordedAt": now,
                    "changeSetId": change_set_id,
                }
            }),
        };
        complete_idempotency(&mut tx, idempotency, &response, &now).await?;
        tx.commit().await?;
        Ok(response)
    }

    pub async fn create_action(
        &self,
        request: ActionRequest,
        idempotency: Option<&IdempotencyContext>,
    ) -> AppResult<MutationResponse> {
        request.audit.validate().map_err(AppError::Invalid)?;
        validate_non_empty("label", &request.label)?;
        validate_non_empty("expectedOutcome", &request.expected_outcome)?;
        validate_non_empty("trigger", &request.trigger)?;
        validate_observation_window(&request.observation_window)?;
        validate_timestamp("reviewAt", &request.review_at)?;
        validate_choice("sensitivity", &request.sensitivity, SENSITIVITIES)?;
        validate_json_object("payload", &request.payload)?;
        validate_json_object("scope", &request.scope)?;

        let now = now_iso();
        let action_id = new_id("node");
        let mut action_payload = request.payload.clone();
        if let Some(object) = action_payload.as_object_mut() {
            object.insert("trigger".into(), Value::String(request.trigger.clone()));
            object.insert(
                "observationWindow".into(),
                request.observation_window.clone(),
            );
        }
        let mut tx = self.pool.begin().await?;
        if let Some(cached) = begin_idempotency(&mut tx, idempotency).await? {
            return Ok(cached);
        }
        if let Some(claim_id) = &request.claim_id {
            let claim = fetch_node_tx(&mut tx, claim_id).await?;
            if claim.kind != "claim" {
                return Err(AppError::Invalid(
                    "claimId must reference a claim node".into(),
                ));
            }
        }

        let change_set_id = create_change_set(
            &mut tx,
            "extraction",
            &format!(
                "Create action with expected result and timed review: {}",
                request.label
            ),
            &request.audit,
        )
        .await?;
        let (authority, origin) = provenance_for_audit(&request.audit, false);
        insert_node_with_provenance(
            &mut tx,
            NewNode {
                id: &action_id,
                kind: "action",
                label: request.label.trim(),
                statement: request.statement.as_deref(),
                payload: &action_payload,
                scope: &request.scope,
                sensitivity: &request.sensitivity,
                expected_outcome: Some(request.expected_outcome.trim()),
                review_at: Some(&request.review_at),
                outcome: None,
                status: "active",
                now: &now,
            },
            authority,
            origin,
        )
        .await?;
        let action = fetch_node_tx(&mut tx, &action_id).await?.to_value();
        insert_operation(
            &mut tx,
            &change_set_id,
            0,
            "create_node",
            &action_id,
            None,
            Some(&action),
            Some(&json!({ "operation": "soft_retract", "targetRef": action_id })),
        )
        .await?;

        let mut edge_value = Value::Null;
        if let Some(claim_id) = &request.claim_id {
            let edge_id = create_edge_tx(
                &mut tx,
                &action_id,
                claim_id,
                "behavioral",
                "tests",
                "Action is an explicit experiment against this claim",
                &request.scope,
                &now,
            )
            .await?;
            edge_value = fetch_edge_tx(&mut tx, &edge_id).await?.to_value();
            insert_operation(
                &mut tx,
                &change_set_id,
                1,
                "create_edge",
                &edge_id,
                None,
                Some(&edge_value),
                Some(&json!({ "operation": "soft_close_edge", "targetRef": edge_id })),
            )
            .await?;
        }
        apply_change_set(&mut tx, &change_set_id, &now).await?;
        let response = MutationResponse {
            ok: true,
            change_set_id,
            value: json!({ "action": action, "claimEdge": edge_value }),
        };
        complete_idempotency(&mut tx, idempotency, &response, &now).await?;
        tx.commit().await?;
        Ok(response)
    }

    pub async fn record_outcome(
        &self,
        request: OutcomeRequest,
        idempotency: Option<&IdempotencyContext>,
    ) -> AppResult<MutationResponse> {
        request.audit.validate().map_err(AppError::Invalid)?;
        validate_choice("audit.actor", &request.audit.actor, &["user", "model"])?;
        validate_non_empty("actionId", &request.action_id)?;
        validate_non_empty("outcome", &request.outcome)?;
        let effect = request.effect.as_deref().unwrap_or("unknown");
        validate_choice(
            "effect",
            effect,
            &["confirms", "contracts", "revises", "refutes", "unknown"],
        )?;
        if matches!(effect, "contracts" | "revises") {
            validate_non_empty(
                "revisedStatement",
                request.revised_statement.as_deref().unwrap_or_default(),
            )?;
        }
        if let Some(scope) = &request.revised_scope {
            validate_json_object("revisedScope", scope)?;
        }
        if let Some(observed_at) = &request.observed_at {
            validate_timestamp("observedAt", observed_at)?;
        }
        validate_json_object("payload", &request.payload)?;
        let mut seen_evidence = HashSet::new();
        for evidence_ref in &request.evidence_refs {
            validate_non_empty("evidenceRefs[]", evidence_ref)?;
            if !seen_evidence.insert(evidence_ref.as_str()) {
                return Err(AppError::Invalid(
                    "evidenceRefs cannot contain duplicates".into(),
                ));
            }
        }
        if request.audit.actor == "model" && request.evidence_refs.is_empty() {
            return Err(AppError::Invalid(
                "model-recorded outcomes require at least one valid EvidenceRef".into(),
            ));
        }

        let now = now_iso();
        let observed_at = request.observed_at.as_deref().unwrap_or(&now).to_string();
        let outcome_id = new_id("node");
        let mut tx = self.pool.begin().await?;
        if let Some(cached) = begin_idempotency(&mut tx, idempotency).await? {
            return Ok(cached);
        }
        let action_before = fetch_node_tx(&mut tx, &request.action_id).await?;
        if action_before.kind != "action" {
            return Err(AppError::Invalid(
                "actionId must reference an action node".into(),
            ));
        }
        if action_before.deleted_at.is_some() {
            return Err(AppError::Conflict(
                "cannot record an outcome for a retracted action".into(),
            ));
        }

        let linked_claim_id = if request.claim_id.is_some() {
            request.claim_id.clone()
        } else {
            sqlx::query_scalar::<_, String>(
                "SELECT to_node_id FROM edges WHERE from_node_id=? AND relation_type='tests' \
                 AND status='active' ORDER BY created_at DESC LIMIT 1",
            )
            .bind(&request.action_id)
            .fetch_optional(&mut *tx)
            .await?
        };
        if let Some(claim_id) = &linked_claim_id {
            let claim = fetch_node_tx(&mut tx, claim_id).await?;
            if claim.kind != "claim" {
                return Err(AppError::Invalid(
                    "claimId must reference a claim node".into(),
                ));
            }
        }

        let mut evidence_sources: Vec<(String, Option<String>)> =
            Vec::with_capacity(request.evidence_refs.len().max(1));
        for evidence_ref in &request.evidence_refs {
            evidence_sources.push((
                evidence_ref.clone(),
                validate_and_source_evidence_tx(&mut tx, evidence_ref).await?,
            ));
        }

        let change_set_id = create_change_set(
            &mut tx,
            "action_outcome",
            &format!(
                "Collect real outcome for action {} and trigger claim revision",
                request.action_id
            ),
            &request.audit,
        )
        .await?;
        let mut sequence = 0_i64;
        if request.audit.actor == "user" && evidence_sources.is_empty() {
            let (evidence_ref, source_node_id) = create_inline_feedback_evidence_tx(
                &mut tx,
                &request.action_id,
                "outcome",
                Some(request.outcome.trim()),
                &request.audit,
                &change_set_id,
                &mut sequence,
                &now,
            )
            .await?;
            evidence_sources.push((evidence_ref, Some(source_node_id)));
        }
        let direct_user_outcome = request.audit.actor == "user";
        let (correction_authority, correction_origin) = if direct_user_outcome {
            ("user_corrected", "user")
        } else {
            ("system_inferred", "model")
        };
        sqlx::query(
            "UPDATE nodes SET outcome=?, status='concluded', authority=?, \
             origin=?, updated_at=? WHERE id=?",
        )
        .bind(request.outcome.trim())
        .bind(correction_authority)
        .bind(correction_origin)
        .bind(&now)
        .bind(&request.action_id)
        .execute(&mut *tx)
        .await?;
        let action_after = fetch_node_tx(&mut tx, &request.action_id).await?.to_value();
        let action_before_value = action_before.to_value();
        insert_operation(
            &mut tx,
            &change_set_id,
            sequence,
            "update_node",
            &request.action_id,
            Some(&action_before_value),
            Some(&action_after),
            Some(&json!({ "operation": "restore_node", "node": action_before_value })),
        )
        .await?;
        sequence += 1;

        let mut outcome_payload = request.payload.clone();
        if let Some(object) = outcome_payload.as_object_mut() {
            object.insert("observedAt".into(), Value::String(observed_at.clone()));
            object.insert("effect".into(), Value::String(effect.into()));
            object.insert("actionId".into(), Value::String(request.action_id.clone()));
        }
        let (outcome_authority, outcome_origin) = if direct_user_outcome {
            ("user_stated", "user")
        } else {
            ("system_inferred", "model")
        };
        insert_node_with_provenance(
            &mut tx,
            NewNode {
                id: &outcome_id,
                kind: "outcome",
                label: request.label.as_deref().unwrap_or("行动结果"),
                statement: Some(request.outcome.trim()),
                payload: &outcome_payload,
                scope: &serde_json::from_str(&action_before.scope_json)
                    .unwrap_or_else(|_| json!({})),
                sensitivity: &action_before.sensitivity,
                expected_outcome: action_before.expected_outcome.as_deref(),
                review_at: Some(&observed_at),
                outcome: Some(request.outcome.trim()),
                status: "active",
                now: &now,
            },
            outcome_authority,
            outcome_origin,
        )
        .await?;
        let outcome_node = fetch_node_tx(&mut tx, &outcome_id).await?.to_value();
        insert_operation(
            &mut tx,
            &change_set_id,
            sequence,
            "create_node",
            &outcome_id,
            None,
            Some(&outcome_node),
            Some(&json!({ "operation": "soft_retract", "targetRef": outcome_id })),
        )
        .await?;
        sequence += 1;

        let result_edge_id = create_edge_with_semantics_tx(
            &mut tx,
            &request.action_id,
            &outcome_id,
            EdgeSemantics {
                family: "behavioral",
                relation_type: "resulted_in",
                direction: "directed",
                proximity: "direct",
                strength: "strong",
                basis: if direct_user_outcome {
                    "explicit_statement"
                } else {
                    "contextual"
                },
                authority: outcome_authority,
                status: "active",
                rationale: "Observed result of the action",
            },
            &serde_json::from_str(&action_before.scope_json).unwrap_or_else(|_| json!({})),
            &now,
        )
        .await?;
        let result_edge = fetch_edge_tx(&mut tx, &result_edge_id).await?.to_value();
        insert_operation(
            &mut tx,
            &change_set_id,
            sequence,
            "create_edge",
            &result_edge_id,
            None,
            Some(&result_edge),
            Some(&json!({ "operation": "soft_close_edge", "targetRef": result_edge_id })),
        )
        .await?;
        sequence += 1;

        for (evidence_ref, source_node_id) in &evidence_sources {
            sqlx::query(
                "INSERT OR IGNORE INTO node_evidence_links(node_id, evidence_ref_id, role, created_at) \
                 VALUES (?, ?, 'provenance', ?)",
            )
            .bind(&outcome_id)
            .bind(evidence_ref)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT OR IGNORE INTO change_evidence_links(change_set_id, evidence_ref_id, created_at) \
                 VALUES (?, ?, ?)",
            )
            .bind(&change_set_id)
            .bind(evidence_ref)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT OR IGNORE INTO edge_evidence_links(edge_id, evidence_ref_id, role, created_at) \
                 VALUES (?, ?, 'reason', ?)",
            )
            .bind(&result_edge_id)
            .bind(evidence_ref)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            let link = json!({
                "nodeId": outcome_id,
                "evidenceRefId": evidence_ref,
                "role": "provenance",
                "createdAt": now,
            });
            insert_operation(
                &mut tx,
                &change_set_id,
                sequence,
                "link_node_evidence",
                &format!("{outcome_id}:{evidence_ref}:provenance"),
                None,
                Some(&link),
                Some(&json!({
                    "operation": "unlink_node_evidence",
                    "nodeId": outcome_id,
                    "evidenceRefId": evidence_ref,
                    "role": "provenance"
                })),
            )
            .await?;
            sequence += 1;
            if let Some(source_node_id) = source_node_id {
                let evidence_edge_id = create_evidenced_edge_tx(
                    &mut tx,
                    source_node_id,
                    &outcome_id,
                    "provenance",
                    "supports",
                    "The result is grounded in this exact EvidenceRef",
                    &json!({ "actionId": request.action_id }),
                    evidence_ref,
                    outcome_authority,
                    &now,
                )
                .await?;
                let evidence_edge = fetch_edge_tx(&mut tx, &evidence_edge_id).await?.to_value();
                insert_operation(
                    &mut tx,
                    &change_set_id,
                    sequence,
                    "create_edge",
                    &evidence_edge_id,
                    None,
                    Some(&evidence_edge),
                    Some(&json!({ "operation": "soft_close_edge", "targetRef": evidence_edge_id })),
                )
                .await?;
                sequence += 1;
            }
        }

        let revision_hook = if let Some(claim_id) = linked_claim_id {
            apply_claim_effect_tx(
                &mut tx,
                &change_set_id,
                sequence,
                &claim_id,
                &outcome_id,
                effect,
                request.revised_statement.as_deref(),
                request.revised_scope.as_ref(),
                &request.audit,
                Some((correction_authority, correction_origin)),
                true,
                &now,
            )
            .await?
            .value
        } else {
            Value::Null
        };

        apply_change_set(&mut tx, &change_set_id, &now).await?;
        let response = MutationResponse {
            ok: true,
            change_set_id,
            value: json!({
                "action": action_after,
                "outcome": outcome_node,
                "resultEdge": result_edge,
                "revisionHook": revision_hook,
            }),
        };
        complete_idempotency(&mut tx, idempotency, &response, &now).await?;
        tx.commit().await?;
        Ok(response)
    }

    pub async fn list_revisions(
        &self,
        status: Option<&str>,
        limit: u32,
        sensitivity_ceiling: &str,
    ) -> AppResult<Value> {
        let status = status.unwrap_or("pending");
        validate_choice(
            "status",
            status,
            &["pending", "applied", "dismissed", "all"],
        )?;
        validate_choice("sensitivityCeiling", sensitivity_ceiling, SENSITIVITIES)?;
        let rows = if status == "all" {
            sqlx::query(
                "SELECT q.id, q.claim_node_id, q.outcome_node_id, q.effect, q.proposed_statement, \
                 q.status, q.resolution_json, q.resolution_change_set_id, q.created_at, q.resolved_at \
                 FROM claim_revision_queue q JOIN nodes n ON n.id=q.claim_node_id \
                 WHERE CASE n.sensitivity WHEN 'low' THEN 0 WHEN 'medium' THEN 1 \
                 WHEN 'high' THEN 2 WHEN 'highest' THEN 3 ELSE 99 END <= ? \
                 ORDER BY q.created_at DESC LIMIT ?",
            )
            .bind(sensitivity_rank(sensitivity_ceiling) as i64)
            .bind(limit.clamp(1, 500) as i64)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT q.id, q.claim_node_id, q.outcome_node_id, q.effect, q.proposed_statement, \
                 q.status, q.resolution_json, q.resolution_change_set_id, q.created_at, q.resolved_at \
                 FROM claim_revision_queue q JOIN nodes n ON n.id=q.claim_node_id \
                 WHERE q.status=? AND CASE n.sensitivity WHEN 'low' THEN 0 WHEN 'medium' THEN 1 \
                 WHEN 'high' THEN 2 WHEN 'highest' THEN 3 ELSE 99 END <= ? \
                 ORDER BY q.created_at DESC LIMIT ?",
            )
            .bind(status)
            .bind(sensitivity_rank(sensitivity_ceiling) as i64)
            .bind(limit.clamp(1, 500) as i64)
            .fetch_all(&self.pool)
            .await?
        };
        Ok(json!({
            "ok": true,
            "items": rows.into_iter().map(revision_row_to_value).collect::<Vec<_>>(),
        }))
    }

    pub async fn resolve_revision(
        &self,
        revision_id: &str,
        request: ResolveRevisionRequest,
        idempotency: Option<&IdempotencyContext>,
    ) -> AppResult<MutationResponse> {
        validate_non_empty("revisionId", revision_id)?;
        request.audit.validate().map_err(AppError::Invalid)?;
        validate_choice(
            "resolution",
            &request.resolution,
            &["confirms", "contracts", "revises", "refutes", "dismissed"],
        )?;
        if matches!(request.resolution.as_str(), "contracts" | "revises") {
            validate_non_empty(
                "revisedStatement",
                request.revised_statement.as_deref().unwrap_or_default(),
            )?;
        }
        if let Some(scope) = &request.revised_scope {
            validate_json_object("revisedScope", scope)?;
        }

        let now = now_iso();
        let mut tx = self.pool.begin().await?;
        if let Some(cached) = begin_idempotency(&mut tx, idempotency).await? {
            return Ok(cached);
        }
        let row = sqlx::query(
            "SELECT id, claim_node_id, outcome_node_id, effect, proposed_statement, status, \
             resolution_json, resolution_change_set_id, created_at, resolved_at \
             FROM claim_revision_queue WHERE id=?",
        )
        .bind(revision_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("revision {revision_id}")))?;
        if row.get::<String, _>("status") != "pending" {
            return Err(AppError::Conflict(
                "only a pending revision can be resolved".into(),
            ));
        }
        let before = revision_row_to_value(row);
        let claim_id = before["claimNodeId"]
            .as_str()
            .ok_or_else(|| AppError::Internal("revision missing claimNodeId".into()))?
            .to_string();
        let outcome_id = before["outcomeNodeId"]
            .as_str()
            .ok_or_else(|| AppError::Internal("revision missing outcomeNodeId".into()))?
            .to_string();
        let change_set_id = create_change_set(
            &mut tx,
            "action_outcome",
            &format!(
                "Resolve pending claim revision {revision_id} as {}",
                request.resolution
            ),
            &request.audit,
        )
        .await?;
        let mut effect_value = Value::Null;
        let status = if request.resolution == "dismissed" {
            "dismissed"
        } else {
            effect_value = apply_claim_effect_tx(
                &mut tx,
                &change_set_id,
                0,
                &claim_id,
                &outcome_id,
                &request.resolution,
                request.revised_statement.as_deref(),
                request.revised_scope.as_ref(),
                &request.audit,
                None,
                false,
                &now,
            )
            .await?
            .value;
            "applied"
        };
        let resolution = json!({
            "resolution": request.resolution,
            "revisedStatement": request.revised_statement,
            "revisedScope": request.revised_scope,
            "actor": request.audit.actor,
            "resolvedAt": now,
        });
        sqlx::query(
            "UPDATE claim_revision_queue SET status=?, resolution_json=?, \
             resolution_change_set_id=?, resolved_at=? WHERE id=?",
        )
        .bind(status)
        .bind(serde_json::to_string(&resolution)?)
        .bind(&change_set_id)
        .bind(&now)
        .bind(revision_id)
        .execute(&mut *tx)
        .await?;
        let after_row = sqlx::query(
            "SELECT id, claim_node_id, outcome_node_id, effect, proposed_statement, status, \
             resolution_json, resolution_change_set_id, created_at, resolved_at \
             FROM claim_revision_queue WHERE id=?",
        )
        .bind(revision_id)
        .fetch_one(&mut *tx)
        .await?;
        let after = revision_row_to_value(after_row);
        let sequence: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(sequence), -1) + 1 FROM change_operations WHERE change_set_id=?",
        )
        .bind(&change_set_id)
        .fetch_one(&mut *tx)
        .await?;
        insert_operation(
            &mut tx,
            &change_set_id,
            sequence,
            "resolve_claim_revision",
            revision_id,
            Some(&before),
            Some(&after),
            Some(&json!({ "operation": "restore_claim_revision", "revision": before })),
        )
        .await?;
        apply_change_set(&mut tx, &change_set_id, &now).await?;
        let response = MutationResponse {
            ok: true,
            change_set_id,
            value: json!({ "revision": after, "claimEffect": effect_value }),
        };
        complete_idempotency(&mut tx, idempotency, &response, &now).await?;
        tx.commit().await?;
        Ok(response)
    }

    /// Import one immutable Computer History segment into the raw evidence
    /// layer. No semantic node is inferred here; later knowledge writes cite
    /// the returned EvidenceRefs so the original event stays independently
    /// searchable and reversible.
    pub async fn record_computer_history_evidence(
        &self,
        request: ComputerHistoryEvidenceRequest,
        idempotency: Option<&IdempotencyContext>,
    ) -> AppResult<MutationResponse> {
        request.audit.validate().map_err(AppError::Invalid)?;
        validate_non_empty("segmentId", &request.segment_id)?;
        validate_non_empty("storageUri", &request.storage_uri)?;
        validate_non_empty("contentHash", &request.content_hash)?;
        validate_timestamp("startedAt", &request.started_at)?;
        if let Some(ended_at) = &request.ended_at {
            validate_timestamp("endedAt", ended_at)?;
        }
        validate_choice(
            "coverageStatus",
            &request.coverage_status,
            &["complete", "partial", "unknown"],
        )?;
        validate_json_object("metadata", &request.metadata)?;
        if request.events.is_empty() {
            return Err(AppError::Invalid(
                "computer history import requires at least one event".into(),
            ));
        }
        if request.events.len() > 1_000 {
            return Err(AppError::Invalid(
                "computer history import accepts at most 1000 events per request; continue the segment in batches".into(),
            ));
        }

        let mut parsed_events = Vec::with_capacity(request.events.len());
        for (index, event) in request.events.iter().enumerate() {
            let object = event.as_object().ok_or_else(|| {
                AppError::Invalid(format!("events[{index}] must be a JSON object"))
            })?;
            let raw_event_id = object
                .get("id")
                .cloned()
                .ok_or_else(|| AppError::Invalid(format!("events[{index}].id is required")))?;
            if !raw_event_id.is_string() && !raw_event_id.is_number() {
                return Err(AppError::Invalid(format!(
                    "events[{index}].id must be a string or number"
                )));
            }
            let timestamp = object
                .get("timestamp")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::Invalid(format!("events[{index}].timestamp is required")))?
                .to_string();
            validate_timestamp(&format!("events[{index}].timestamp"), &timestamp)?;
            let raw = serde_json::to_string(event)?;
            let content_hash = format!("sha256:{:x}", Sha256::digest(raw.as_bytes()));
            let kind = object
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            parsed_events.push((raw_event_id, timestamp, kind, raw, content_hash));
        }

        let now = now_iso();
        let source_id = new_id("source");
        let mut tx = self.pool.begin().await?;
        if let Some(cached) = begin_idempotency(&mut tx, idempotency).await? {
            return Ok(cached);
        }
        let change_set_id = create_change_set(
            &mut tx,
            "extraction",
            &format!(
                "Import Computer History segment {} as raw searchable evidence",
                request.segment_id
            ),
            &request.audit,
        )
        .await?;
        let metadata = json!({
            "segmentId": request.segment_id,
            "eventCount": parsed_events.len(),
            "format": "skysight.events.jsonl",
            "sourceMetadata": request.metadata,
        });
        let collector_version = request
            .collector_version
            .as_deref()
            .unwrap_or("computer-history.unknown");
        sqlx::query(
            "INSERT INTO source_records(\
             id, source_type, captured_at, ended_at, storage_uri, content_hash, privacy_level, \
             storage_policy, model_access, coverage_status, collector_version, metadata_json, \
             created_at) VALUES (?, 'computer_history', ?, ?, ?, ?, 'highest', 'local_only', \
             'external_allowed', ?, ?, ?, ?)",
        )
        .bind(&source_id)
        .bind(&request.started_at)
        .bind(&request.ended_at)
        .bind(&request.storage_uri)
        .bind(&request.content_hash)
        .bind(&request.coverage_status)
        .bind(collector_version)
        .bind(serde_json::to_string(&metadata)?)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

        let source_value = json!({
            "id": source_id,
            "sourceType": "computer_history",
            "capturedAt": request.started_at,
            "endedAt": request.ended_at,
            "storageUri": request.storage_uri,
            "contentHash": request.content_hash,
            "privacyLevel": "highest",
            "storagePolicy": "local_only",
            "modelAccess": "external_allowed",
            "coverageStatus": request.coverage_status,
            "collectorVersion": collector_version,
            "metadata": metadata,
            "createdAt": now,
        });
        insert_operation(
            &mut tx,
            &change_set_id,
            0,
            "create_source",
            &source_id,
            None,
            Some(&source_value),
            Some(&json!({ "operation": "soft_delete_source", "targetRef": source_id })),
        )
        .await?;

        let mut evidence_receipts = Vec::with_capacity(parsed_events.len());
        for (offset, (raw_event_id, timestamp, kind, raw, content_hash)) in
            parsed_events.into_iter().enumerate()
        {
            let evidence_id = new_id("evidence");
            let actor_role = if kind.starts_with("keyboard.")
                || kind.starts_with("mouse.")
                || kind.starts_with("selection.")
            {
                "user"
            } else {
                "system"
            };
            let attribution_status = if actor_role == "user" {
                "probable"
            } else {
                "verified"
            };
            let raw_event_ids = json!([raw_event_id]);
            sqlx::query(
                "INSERT INTO evidence_refs(\
                 id, source_record_id, actor_role, attribution_status, segment_id, \
                 raw_event_ids_json, start_time, resource_id, excerpt, content_hash, \
                 redaction_status, processor_name, processor_version, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', \
                 'latitude.computer-history-import', '0.1.0', ?)",
            )
            .bind(&evidence_id)
            .bind(&source_id)
            .bind(actor_role)
            .bind(attribution_status)
            .bind(&request.segment_id)
            .bind(serde_json::to_string(&raw_event_ids)?)
            .bind(&timestamp)
            .bind(&request.storage_uri)
            .bind(&raw)
            .bind(&content_hash)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO change_evidence_links(change_set_id, evidence_ref_id, created_at) \
                 VALUES (?, ?, ?)",
            )
            .bind(&change_set_id)
            .bind(&evidence_id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            let evidence_value = json!({
                "id": evidence_id,
                "sourceRecordId": source_id,
                "actorRole": actor_role,
                "attributionStatus": attribution_status,
                "segmentId": request.segment_id,
                "rawEventIds": raw_event_ids,
                "startTime": timestamp,
                "resourceId": request.storage_uri,
                "excerpt": raw,
                "contentHash": content_hash,
                "redactionStatus": "none",
                "processorName": "latitude.computer-history-import",
                "processorVersion": "0.1.0",
                "createdAt": now,
                "retractedAt": Value::Null,
            });
            insert_operation(
                &mut tx,
                &change_set_id,
                (1 + offset) as i64,
                "create_evidence",
                &evidence_id,
                None,
                Some(&evidence_value),
                Some(&json!({ "operation": "retract_evidence", "targetRef": evidence_id })),
            )
            .await?;
            evidence_receipts.push(json!({
                "evidenceRefId": evidence_id,
                "rawEventIds": raw_event_ids,
                "startTime": timestamp,
                "kind": kind,
            }));
        }
        apply_change_set(&mut tx, &change_set_id, &now).await?;
        let response = MutationResponse {
            ok: true,
            change_set_id,
            value: json!({
                "sourceRecordId": source_id,
                "segmentId": request.segment_id,
                "importedEventCount": evidence_receipts.len(),
                "evidence": evidence_receipts,
            }),
        };
        complete_idempotency(&mut tx, idempotency, &response, &now).await?;
        tx.commit().await?;
        Ok(response)
    }

    pub async fn record_message_evidence(
        &self,
        request: MessageEvidenceRequest,
        idempotency: Option<&IdempotencyContext>,
    ) -> AppResult<MutationResponse> {
        request.audit.validate().map_err(AppError::Invalid)?;
        if request.audit.actor != "user" {
            return Err(AppError::Invalid(
                "message evidence must be submitted with audit.actor=user".into(),
            ));
        }
        validate_non_empty("content", &request.content)?;
        validate_choice("sensitivity", &request.sensitivity, SENSITIVITIES)?;
        if let Some(occurred_at) = &request.occurred_at {
            validate_timestamp("occurredAt", occurred_at)?;
        }
        if let Some(message_id) = &request.message_id {
            validate_non_empty("messageId", message_id)?;
        }
        let evidence_type = request
            .evidence_type
            .clone()
            .unwrap_or_else(|| "message".to_string());
        validate_choice("evidenceType", &evidence_type, &["message", "activity"])?;

        let now = now_iso();
        let occurred_at = request.occurred_at.as_deref().unwrap_or(&now).to_string();
        let source_id = new_id("source");
        let evidence_id = new_id("evidence");
        let node_id = new_id("node");
        let content_hash = format!("sha256:{:x}", Sha256::digest(request.content.as_bytes()));
        let message_id = request
            .message_id
            .clone()
            .unwrap_or_else(|| new_id("message"));
        let (conversation_context, source_label) =
            conversation_source(request.audit.session_id.as_deref());
        let mut tx = self.pool.begin().await?;
        if let Some(cached) = begin_idempotency(&mut tx, idempotency).await? {
            return Ok(cached);
        }
        let change_set_id = create_change_set(
            &mut tx,
            "extraction",
            if evidence_type == "activity" {
                "Capture a user-authored activity as first-class evidence"
            } else {
                "Capture the current user-authored message as first-class evidence"
            },
            &request.audit,
        )
        .await?;
        let metadata = json!({
            "messageId": message_id,
            "sessionId": request.audit.session_id,
            "turnId": request.audit.turn_id,
            "toolCallId": request.audit.tool_call_id,
            "authorship": "user",
            "evidenceType": evidence_type,
            "conversationContext": conversation_context,
            "sourceLabel": source_label,
        });
        sqlx::query(
            "INSERT INTO source_records(\
             id, source_type, captured_at, storage_uri, content_hash, privacy_level, storage_policy, \
             model_access, coverage_status, collector_version, metadata_json, created_at) \
             VALUES (?, 'chat', ?, ?, ?, ?, 'local_only', 'redacted_external_allowed', \
             'complete', 'latitude.message-evidence@p0', ?, ?)",
        )
        .bind(&source_id)
        .bind(&occurred_at)
        .bind(format!("latitude://message/{message_id}"))
        .bind(&content_hash)
        .bind(&request.sensitivity)
        .bind(serde_json::to_string(&metadata)?)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO evidence_refs(\
             id, source_record_id, actor_role, attribution_status, start_time, transcript_span, \
             resource_id, excerpt, content_hash, redaction_status, processor_name, \
             processor_version, created_at) \
             VALUES (?, ?, 'user', 'verified', ?, ?, ?, ?, ?, 'none', \
             'latitude.message-evidence', '0.1.0', ?)",
        )
        .bind(&evidence_id)
        .bind(&source_id)
        .bind(&occurred_at)
        .bind(&message_id)
        .bind(&message_id)
        .bind(&request.content)
        .bind(&content_hash)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let payload = json!({
            "messageId": message_id,
            "evidenceRefId": evidence_id,
            "occurredAt": occurred_at,
            "contentHash": content_hash,
            "authorship": "user",
            "evidenceType": evidence_type,
        });
        insert_node_with_provenance(
            &mut tx,
            NewNode {
                id: &node_id,
                kind: "evidence_event",
                label: if evidence_type == "activity" {
                    "用户记录的行动"
                } else {
                    "用户消息"
                },
                statement: Some(request.content.trim()),
                payload: &payload,
                scope: &json!({
                    "sessionId": request.audit.session_id,
                    "turnId": request.audit.turn_id,
                }),
                sensitivity: &request.sensitivity,
                expected_outcome: None,
                review_at: None,
                outcome: None,
                status: "active",
                now: &now,
            },
            "source_verified",
            "user",
        )
        .await?;
        sqlx::query(
            "INSERT INTO node_evidence_links(node_id, evidence_ref_id, role, created_at) \
             VALUES (?, ?, 'provenance', ?)",
        )
        .bind(&node_id)
        .bind(&evidence_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO change_evidence_links(change_set_id, evidence_ref_id, created_at) \
             VALUES (?, ?, ?)",
        )
        .bind(&change_set_id)
        .bind(&evidence_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let node = fetch_node_tx(&mut tx, &node_id).await?.to_value();
        let source = json!({
            "id": source_id,
            "sourceType": "chat",
            "capturedAt": occurred_at,
            "storageUri": format!("latitude://message/{message_id}"),
            "contentHash": content_hash,
            "privacyLevel": request.sensitivity,
            "storagePolicy": "local_only",
            "modelAccess": "redacted_external_allowed",
            "coverageStatus": "complete",
            "collectorVersion": "latitude.message-evidence@p0",
            "metadata": metadata,
            "createdAt": now,
        });
        let evidence = json!({
            "id": evidence_id,
            "sourceRecordId": source_id,
            "actorRole": "user",
            "attributionStatus": "verified",
            "startTime": occurred_at,
            "transcriptSpan": message_id,
            "resourceId": message_id,
            "excerpt": request.content,
            "contentHash": content_hash,
            "redactionStatus": "none",
            "processorName": "latitude.message-evidence",
            "processorVersion": "0.1.0",
            "createdAt": now,
        });
        for (sequence, operation_type, target, after) in [
            (0_i64, "create_source", source_id.as_str(), &source),
            (1_i64, "create_evidence", evidence_id.as_str(), &evidence),
            (2_i64, "create_node", node_id.as_str(), &node),
        ] {
            insert_operation(
                &mut tx,
                &change_set_id,
                sequence,
                operation_type,
                target,
                None,
                Some(after),
                Some(&json!({ "operation": "soft_remove", "targetRef": target })),
            )
            .await?;
        }
        let link = json!({
            "nodeId": node_id,
            "evidenceRefId": evidence_id,
            "role": "provenance",
            "createdAt": now,
        });
        insert_operation(
            &mut tx,
            &change_set_id,
            3,
            "link_node_evidence",
            &format!("{node_id}:{evidence_id}:provenance"),
            None,
            Some(&link),
            Some(&json!({
                "operation": "unlink_node_evidence",
                "nodeId": node_id,
                "evidenceRefId": evidence_id,
                "role": "provenance"
            })),
        )
        .await?;
        apply_change_set(&mut tx, &change_set_id, &now).await?;
        let response = MutationResponse {
            ok: true,
            change_set_id,
            value: json!({
                "sourceRecordId": source_id,
                "evidenceRefId": evidence_id,
                "nodeId": node_id,
                "node": node,
            }),
        };
        complete_idempotency(&mut tx, idempotency, &response, &now).await?;
        tx.commit().await?;
        Ok(response)
    }

    pub async fn record_web_evidence(
        &self,
        request: WebEvidenceRequest,
        idempotency: Option<&IdempotencyContext>,
    ) -> AppResult<MutationResponse> {
        request.audit.validate().map_err(AppError::Invalid)?;
        validate_non_empty("query", &request.query)?;
        validate_non_empty("whyNow", &request.why_now)?;
        if request.why_now.chars().count() > 500 {
            return Err(AppError::Invalid(
                "whyNow must not exceed 500 characters".into(),
            ));
        }
        validate_non_empty("url", &request.url)?;
        validate_non_empty("title", &request.title)?;
        validate_non_empty("snippet", &request.snippet)?;
        validate_non_empty("contentHash", &request.content_hash)?;
        if let Some(provider) = &request.provider {
            validate_non_empty("provider", provider)?;
        }
        validate_timestamp("retrievedAt", &request.retrieved_at)?;
        if let Some(published_at) = &request.published_at {
            validate_timestamp("publishedAt", published_at)?;
        }
        let parsed_url = Url::parse(request.url.trim())
            .map_err(|_| AppError::Invalid("url must be an absolute HTTP(S) URL".into()))?;
        if !matches!(parsed_url.scheme(), "http" | "https") || parsed_url.host_str().is_none() {
            return Err(AppError::Invalid(
                "url must use http or https and contain a host".into(),
            ));
        }
        if !parsed_url.username().is_empty() || parsed_url.password().is_some() {
            return Err(AppError::Invalid(
                "url userinfo is forbidden because it may contain credentials".into(),
            ));
        }
        let canonical_url = parsed_url.to_string();
        validate_choice("sensitivity", &request.sensitivity, SENSITIVITIES)?;

        let now = now_iso();
        let source_id = new_id("source");
        let evidence_id = new_id("evidence");
        let node_id = new_id("node");
        let mut tx = self.pool.begin().await?;
        if let Some(cached) = begin_idempotency(&mut tx, idempotency).await? {
            return Ok(cached);
        }
        let change_set_id = create_change_set(
            &mut tx,
            "extraction",
            "Ingest web search result as untrusted provenance, never as prompt authority",
            &request.audit,
        )
        .await?;
        let provider = request.provider.as_deref().unwrap_or("deepseek-official");

        let source_metadata = json!({
            "query": request.query,
            "whyNow": request.why_now,
            "url": canonical_url,
            "title": request.title,
            "publishedAt": request.published_at,
            "retrievedAt": request.retrieved_at,
            "provider": provider,
            "untrustedContent": true,
            "promptAuthority": "none"
        });
        sqlx::query(
            "INSERT INTO source_records(\
             id, source_type, captured_at, storage_uri, content_hash, privacy_level, storage_policy, \
             model_access, coverage_status, collector_version, metadata_json, created_at) \
             VALUES (?, 'web_search', ?, ?, ?, 'low', 'local_only', 'external_allowed', \
             'partial', 'dsh-web@p0', ?, ?)",
        )
        .bind(&source_id)
        .bind(&request.retrieved_at)
        .bind(&canonical_url)
        .bind(&request.content_hash)
        .bind(serde_json::to_string(&source_metadata)?)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO evidence_refs(\
             id, source_record_id, actor_role, attribution_status, start_time, resource_id, excerpt, \
             content_hash, redaction_status, processor_name, processor_version, created_at) \
             VALUES (?, ?, 'third_party', 'unknown', ?, ?, ?, ?, 'none', \
             'latitude.web-evidence', '0.1.0', ?)",
        )
        .bind(&evidence_id)
        .bind(&source_id)
        .bind(request.published_at.as_deref().or(Some(request.retrieved_at.as_str())))
        .bind(&canonical_url)
        .bind(&request.snippet)
        .bind(&request.content_hash)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

        let payload = json!({
            "query": request.query,
            "whyNow": request.why_now,
            "url": canonical_url,
            "title": request.title,
            "snippet": request.snippet,
            "publishedAt": request.published_at,
            "retrievedAt": request.retrieved_at,
            "contentHash": request.content_hash,
            "provider": provider,
            "evidenceRefId": evidence_id,
            "untrustedContent": true,
            "promptAuthority": "none"
        });
        insert_node_with_provenance(
            &mut tx,
            NewNode {
                id: &node_id,
                kind: "resource",
                label: &request.title,
                statement: Some(&request.snippet),
                payload: &payload,
                scope: &json!({ "query": request.query }),
                sensitivity: &request.sensitivity,
                expected_outcome: None,
                review_at: None,
                outcome: None,
                status: "active",
                now: &now,
            },
            "imported_unverified",
            "system",
        )
        .await?;
        sqlx::query(
            "INSERT INTO node_evidence_links(node_id, evidence_ref_id, role, created_at) \
             VALUES (?, ?, 'provenance', ?)",
        )
        .bind(&node_id)
        .bind(&evidence_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO change_evidence_links(change_set_id, evidence_ref_id, created_at) \
             VALUES (?, ?, ?)",
        )
        .bind(&change_set_id)
        .bind(&evidence_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let node = fetch_node_tx(&mut tx, &node_id).await?.to_value();
        let source_value = json!({
            "id": source_id,
            "sourceType": "web_search",
            "capturedAt": request.retrieved_at,
            "storageUri": canonical_url,
            "contentHash": request.content_hash,
            "privacyLevel": "low",
            "storagePolicy": "local_only",
            "modelAccess": "external_allowed",
            "coverageStatus": "partial",
            "collectorVersion": "dsh-web@p0",
            "metadata": source_metadata,
            "createdAt": now,
            "deletedAt": Value::Null,
        });
        let evidence_value = json!({
            "id": evidence_id,
            "sourceRecordId": source_id,
            "actorRole": "third_party",
            "attributionStatus": "unknown",
            "startTime": request.published_at.as_deref().unwrap_or(&request.retrieved_at),
            "resourceId": canonical_url,
            "excerpt": request.snippet,
            "contentHash": request.content_hash,
            "redactionStatus": "none",
            "processorName": "latitude.web-evidence",
            "processorVersion": "0.1.0",
            "createdAt": now,
            "retractedAt": Value::Null,
        });
        let evidence_link_value = json!({
            "nodeId": node_id,
            "evidenceRefId": evidence_id,
            "role": "provenance",
            "createdAt": now,
        });
        insert_operation(
            &mut tx,
            &change_set_id,
            0,
            "create_source",
            &source_id,
            None,
            Some(&source_value),
            Some(&json!({ "operation": "soft_delete_source", "targetRef": source_id })),
        )
        .await?;
        insert_operation(
            &mut tx,
            &change_set_id,
            1,
            "create_evidence",
            &evidence_id,
            None,
            Some(&evidence_value),
            Some(&json!({ "operation": "retract_evidence", "targetRef": evidence_id })),
        )
        .await?;
        insert_operation(
            &mut tx,
            &change_set_id,
            2,
            "create_node",
            &node_id,
            None,
            Some(&node),
            Some(&json!({ "operation": "soft_retract", "targetRef": node_id })),
        )
        .await?;
        insert_operation(
            &mut tx,
            &change_set_id,
            3,
            "link_node_evidence",
            &format!("{node_id}:{evidence_id}:provenance"),
            None,
            Some(&evidence_link_value),
            Some(&json!({ "operation": "unlink_node_evidence", "nodeId": node_id, "evidenceRefId": evidence_id, "role": "provenance" })),
        )
        .await?;
        apply_change_set(&mut tx, &change_set_id, &now).await?;
        let response = MutationResponse {
            ok: true,
            change_set_id,
            value: json!({
                "sourceRecordId": source_id,
                "evidenceRefId": evidence_id,
                "node": node,
                "provider": provider,
                "trust": { "untrustedContent": true, "promptAuthority": "none" }
            }),
        };
        complete_idempotency(&mut tx, idempotency, &response, &now).await?;
        tx.commit().await?;
        Ok(response)
    }

    pub async fn create_weekly_review(
        &self,
        request: WeeklyReviewRequest,
        idempotency: Option<&IdempotencyContext>,
    ) -> AppResult<MutationResponse> {
        request.audit.validate().map_err(AppError::Invalid)?;
        validate_choice(
            "sensitivityCeiling",
            &request.sensitivity_ceiling,
            SENSITIVITIES,
        )?;
        let ceiling_rank = sensitivity_rank(&request.sensitivity_ceiling) as i64;
        let period_end = request.period_end.unwrap_or_else(now_iso);
        validate_timestamp("periodEnd", &period_end)?;
        let parsed_end = chrono::DateTime::parse_from_rfc3339(&period_end)
            .map_err(|_| AppError::Invalid("periodEnd must be RFC3339".into()))?
            .with_timezone(&Utc);
        let period_start = request.period_start.unwrap_or_else(|| {
            (parsed_end - ChronoDuration::days(7)).to_rfc3339_opts(SecondsFormat::Millis, true)
        });
        validate_timestamp("periodStart", &period_start)?;
        let parsed_start = chrono::DateTime::parse_from_rfc3339(&period_start)
            .map_err(|_| AppError::Invalid("periodStart must be RFC3339".into()))?
            .with_timezone(&Utc);
        if parsed_start >= parsed_end {
            return Err(AppError::Invalid(
                "periodStart must be before periodEnd".into(),
            ));
        }
        let receipt_key =
            weekly_receipt_key(&period_start, &period_end, &request.sensitivity_ceiling);
        // Reuse the exact event-first/calendar-fallback read model so the weekly fold cannot
        // silently omit an action whose related EvidenceEvent arrived before reviewAt.
        let due_action_snapshot = self
            .due_actions(Some(&period_end), 500, &request.sensitivity_ceiling)
            .await?;
        let due_action_values = due_action_snapshot["items"]
            .as_array()
            .cloned()
            .ok_or_else(|| AppError::Internal("due action snapshot is malformed".into()))?;

        let now = now_iso();
        let review_id = new_id("review");
        let node_id = new_id("node");
        let mut tx = self.pool.begin().await?;
        if let Some(cached) = begin_idempotency(&mut tx, idempotency).await? {
            return Ok(cached);
        }
        if let Some(existing) = sqlx::query(
            "SELECT id, node_id, change_set_id, due_actions_json, outcomes_json, \
             pending_revisions_json, changed_claims_json, contradictions_json, \
             no_evidence_actions_json FROM weekly_reviews WHERE receipt_key=?",
        )
        .bind(&receipt_key)
        .fetch_optional(&mut *tx)
        .await?
        {
            let existing_node_id: String = existing.try_get("node_id")?;
            let existing_change_set_id: String = existing.try_get("change_set_id")?;
            let existing_node = fetch_node_tx(&mut tx, &existing_node_id).await?;
            let existing_payload: Value = serde_json::from_str(&existing_node.payload_json)?;
            let existing_sections = existing_payload.get("sections").cloned().unwrap_or_else(|| {
                json!({
                    "singleLoop": {
                        "dueActions": serde_json::from_str::<Value>(&existing.get::<String, _>("due_actions_json")).unwrap_or_else(|_| json!([])),
                        "outcomes": serde_json::from_str::<Value>(&existing.get::<String, _>("outcomes_json")).unwrap_or_else(|_| json!([])),
                        "actionsWithoutEvidence": serde_json::from_str::<Value>(&existing.get::<String, _>("no_evidence_actions_json")).unwrap_or_else(|_| json!([])),
                    },
                    "doubleLoop": {
                        "changedClaims": serde_json::from_str::<Value>(&existing.get::<String, _>("changed_claims_json")).unwrap_or_else(|_| json!([])),
                        "contradictions": serde_json::from_str::<Value>(&existing.get::<String, _>("contradictions_json")).unwrap_or_else(|_| json!([])),
                        "pendingRevisions": serde_json::from_str::<Value>(&existing.get::<String, _>("pending_revisions_json")).unwrap_or_else(|_| json!([])),
                    }
                })
            });
            let response = MutationResponse {
                ok: true,
                change_set_id: existing_change_set_id,
                value: json!({
                    "review": {
                        "id": existing.get::<String, _>("id"),
                        "receiptKey": receipt_key,
                        "periodStart": period_start,
                        "periodEnd": period_end,
                        "deduplicated": true,
                    },
                    "node": existing_node.to_value(),
                    "dueActions": serde_json::from_str::<Value>(&existing.get::<String, _>("due_actions_json"))?,
                    "outcomes": serde_json::from_str::<Value>(&existing.get::<String, _>("outcomes_json"))?,
                    "pendingRevisions": serde_json::from_str::<Value>(&existing.get::<String, _>("pending_revisions_json"))?,
                    "candidates": existing_payload.get("candidates").cloned().unwrap_or_else(|| json!({ "open": [], "concluded": [], "parked": [] })),
                    "sections": existing_sections,
                }),
            };
            complete_idempotency(&mut tx, idempotency, &response, &now).await?;
            tx.commit().await?;
            return Ok(response);
        }
        let outcomes: Vec<NodeRecord> = sqlx::query_as(
            "SELECT id, schema_version, kind, layer, label, statement, payload_json, status, \
             authority, origin, scope_json, scope_key, sensitivity, valid_from, valid_to, \
             recorded_at, superseded_at, created_at, updated_at, deleted_at, expected_outcome, \
             review_at, outcome FROM nodes WHERE kind='outcome' AND deleted_at IS NULL \
             AND CASE sensitivity WHEN 'low' THEN 0 WHEN 'medium' THEN 1 \
             WHEN 'high' THEN 2 WHEN 'highest' THEN 3 ELSE 99 END <= ? \
             AND julianday(recorded_at)>=julianday(?) AND julianday(recorded_at)<=julianday(?) \
             ORDER BY julianday(recorded_at) ASC",
        )
        .bind(ceiling_rank)
        .bind(&period_start)
        .bind(&period_end)
        .fetch_all(&mut *tx)
        .await?;
        let pending_revision_rows = sqlx::query(
            "SELECT q.id, q.claim_node_id, q.outcome_node_id, q.effect, q.proposed_statement, \
             q.status, q.created_at, c.label AS claim_label \
             FROM claim_revision_queue q JOIN nodes c ON c.id=q.claim_node_id \
             WHERE q.status='pending' AND CASE c.sensitivity WHEN 'low' THEN 0 \
             WHEN 'medium' THEN 1 WHEN 'high' THEN 2 WHEN 'highest' THEN 3 ELSE 99 END <= ? \
             ORDER BY q.created_at ASC",
        )
        .bind(ceiling_rank)
        .fetch_all(&mut *tx)
        .await?;
        let pending_revisions: Vec<Value> = pending_revision_rows
            .into_iter()
            .map(|row| {
                json!({
                    "id": row.get::<String, _>("id"),
                    "claimId": row.get::<String, _>("claim_node_id"),
                    "claimLabel": row.get::<String, _>("claim_label"),
                    "outcomeId": row.get::<String, _>("outcome_node_id"),
                    "effect": row.get::<String, _>("effect"),
                    "proposedStatement": row.get::<Option<String>, _>("proposed_statement"),
                    "createdAt": row.get::<String, _>("created_at"),
                })
            })
            .collect();
        let changed_claim_rows = sqlx::query(
            "SELECT o.after_json, c.id AS change_set_id, c.reason_type, c.applied_at \
             FROM change_operations o JOIN change_sets c ON c.id=o.change_set_id \
             WHERE c.status='applied' AND julianday(c.applied_at)>=julianday(?) \
             AND julianday(c.applied_at)<=julianday(?) \
             AND o.operation_type IN ('create_node','update_node','close_node') \
             AND o.after_json IS NOT NULL \
             AND json_extract(o.after_json, '$.kind')='claim' \
             AND CASE json_extract(o.after_json, '$.sensitivity') WHEN 'low' THEN 0 \
             WHEN 'medium' THEN 1 WHEN 'high' THEN 2 WHEN 'highest' THEN 3 ELSE 99 END <= ? \
             ORDER BY c.applied_at DESC, o.sequence DESC",
        )
        .bind(&period_start)
        .bind(&period_end)
        .bind(ceiling_rank)
        .fetch_all(&mut *tx)
        .await?;
        let mut seen_claims = HashSet::new();
        let mut changed_claims = Vec::new();
        for row in changed_claim_rows {
            let after: Value = serde_json::from_str(&row.get::<String, _>("after_json"))?;
            let Some(id) = after.get("id").and_then(Value::as_str) else {
                continue;
            };
            if seen_claims.insert(id.to_string()) {
                changed_claims.push(json!({
                    "claim": after,
                    "changeSetId": row.get::<String, _>("change_set_id"),
                    "reasonType": row.get::<String, _>("reason_type"),
                    "changedAt": row.get::<Option<String>, _>("applied_at"),
                }));
            }
        }
        let contradiction_rows: Vec<EdgeRecord> = sqlx::query_as(
            "SELECT e.id, e.schema_version, e.from_node_id, e.to_node_id, e.family, \
             e.relation_type, e.direction, e.proximity, e.strength, e.basis, e.authority, \
             e.status, e.rationale, e.scope_json, e.scope_key, e.valid_from, e.valid_to, \
             e.recorded_at, e.superseded_at, e.created_at, e.updated_at FROM edges e \
             JOIN nodes f ON f.id=e.from_node_id JOIN nodes t ON t.id=e.to_node_id \
             WHERE relation_type IN ('contradicts','conflicts_with') \
             AND e.status IN ('active','disputed') \
             AND CASE f.sensitivity WHEN 'low' THEN 0 WHEN 'medium' THEN 1 \
             WHEN 'high' THEN 2 WHEN 'highest' THEN 3 ELSE 99 END <= ? \
             AND CASE t.sensitivity WHEN 'low' THEN 0 WHEN 'medium' THEN 1 \
             WHEN 'high' THEN 2 WHEN 'highest' THEN 3 ELSE 99 END <= ? \
             ORDER BY e.updated_at DESC",
        )
        .bind(ceiling_rank)
        .bind(ceiling_rank)
        .fetch_all(&mut *tx)
        .await?;
        let contradictions = contradiction_rows
            .iter()
            .map(EdgeRecord::to_value)
            .collect::<Vec<_>>();
        let no_evidence_actions: Vec<NodeRecord> = sqlx::query_as(
            "SELECT id, schema_version, kind, layer, label, statement, payload_json, status, \
             authority, origin, scope_json, scope_key, sensitivity, valid_from, valid_to, \
             recorded_at, superseded_at, created_at, updated_at, deleted_at, expected_outcome, \
             review_at, outcome FROM nodes a WHERE a.kind='action' AND a.deleted_at IS NULL \
             AND julianday(a.recorded_at)>=julianday(?) \
             AND julianday(a.recorded_at)<=julianday(?) \
             AND CASE a.sensitivity WHEN 'low' THEN 0 WHEN 'medium' THEN 1 \
             WHEN 'high' THEN 2 WHEN 'highest' THEN 3 ELSE 99 END <= ? \
             AND NOT EXISTS (SELECT 1 FROM node_evidence_links l WHERE l.node_id=a.id) \
             AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.to_node_id=a.id \
               AND e.relation_type IN ('supports','provides_evidence_for','derived_from') \
               AND e.status IN ('active','disputed')) ORDER BY a.recorded_at ASC",
        )
        .bind(&period_start)
        .bind(&period_end)
        .bind(ceiling_rank)
        .fetch_all(&mut *tx)
        .await?;
        let candidate_nodes: Vec<NodeRecord> = sqlx::query_as(
            "SELECT id, schema_version, kind, layer, label, statement, payload_json, status, \
             authority, origin, scope_json, scope_key, sensitivity, valid_from, valid_to, \
             recorded_at, superseded_at, created_at, updated_at, deleted_at, expected_outcome, \
             review_at, outcome FROM nodes WHERE kind='experiment' AND deleted_at IS NULL \
             AND json_extract(payload_json, '$.interventionType')='candidate' \
             AND CASE sensitivity WHEN 'low' THEN 0 WHEN 'medium' THEN 1 \
             WHEN 'high' THEN 2 WHEN 'highest' THEN 3 ELSE 99 END <= ? \
             AND (status IN ('proposed','active','shaping') OR \
               (status IN ('concluded','parked') \
                AND julianday(updated_at)>=julianday(?) \
                AND julianday(updated_at)<=julianday(?))) \
             ORDER BY CASE status WHEN 'shaping' THEN 0 WHEN 'active' THEN 1 \
               WHEN 'proposed' THEN 2 WHEN 'concluded' THEN 3 ELSE 4 END, \
               julianday(updated_at) DESC",
        )
        .bind(ceiling_rank)
        .bind(&period_start)
        .bind(&period_end)
        .fetch_all(&mut *tx)
        .await?;
        let outcome_values = outcomes
            .iter()
            .map(NodeRecord::to_value)
            .collect::<Vec<_>>();
        let no_evidence_action_values = no_evidence_actions
            .iter()
            .map(NodeRecord::to_value)
            .collect::<Vec<_>>();
        let open_candidate_values = candidate_nodes
            .iter()
            .filter(|node| matches!(node.status.as_str(), "proposed" | "active" | "shaping"))
            .map(NodeRecord::to_value)
            .collect::<Vec<_>>();
        let concluded_candidate_values = candidate_nodes
            .iter()
            .filter(|node| node.status == "concluded")
            .map(NodeRecord::to_value)
            .collect::<Vec<_>>();
        let parked_candidate_values = candidate_nodes
            .iter()
            .filter(|node| node.status == "parked")
            .map(NodeRecord::to_value)
            .collect::<Vec<_>>();
        let candidate_values = json!({
            "open": open_candidate_values,
            "concluded": concluded_candidate_values,
            "parked": parked_candidate_values,
        });
        let reframe_prompts = vec![
            json!({
                "type": "belief_revision",
                "prompt": format!("有 {} 条认知在本周改变；哪些前提已经不再成立？", changed_claims.len()),
                "entityIds": changed_claims.iter().filter_map(|value| value.pointer("/claim/id").and_then(Value::as_str)).collect::<Vec<_>>(),
            }),
            json!({
                "type": "contradiction_resolution",
                "prompt": format!("仍有 {} 组矛盾；下一周最小的判别行动是什么？", contradictions.len()),
                "entityIds": contradictions.iter().filter_map(|value| value.get("id").and_then(Value::as_str)).collect::<Vec<_>>(),
            }),
        ];
        let sections = json!({
            "singleLoop": {
                "dueActions": due_action_values,
                "outcomes": outcome_values,
                "actionsWithoutEvidence": no_evidence_action_values,
                "question": "哪些做法有效、无效，下一次如何调整执行？"
            },
            "doubleLoop": {
                "changedClaims": changed_claims,
                "contradictions": contradictions,
                "pendingRevisions": pending_revisions,
                "reframePrompts": reframe_prompts,
                "candidates": candidate_values,
                "question": "哪些假设、边界或目标本身需要改变？"
            }
        });
        let payload = json!({
            "periodStart": period_start,
            "periodEnd": period_end,
            "sensitivityCeiling": request.sensitivity_ceiling,
            "dueActions": due_action_values,
            "outcomes": outcome_values,
            "pendingRevisions": pending_revisions,
            "changedClaims": changed_claims,
            "contradictions": contradictions,
            "actionsWithoutEvidence": no_evidence_action_values,
            "candidates": candidate_values,
            "sections": sections,
            "timingDesign": {
                "actionClock": "linked evidence relation",
                "eventTrigger": "an EvidenceEvent is linked to the action or the Claim it tests",
                "calendarFallback": "reviewAt, then the real weekly review",
                "candidateClocks": {
                    "proposed": "3d due prompt only; never auto-transition",
                    "shaping": "7d one-time follow-up receipt; never auto-conclude"
                }
            }
        });
        let change_set_id = create_change_set(
            &mut tx,
            "extraction",
            "Create the real weekly review fallback over due actions, outcomes, and claim revisions",
            &request.audit,
        )
        .await?;
        let statement = format!(
            "本周回收 {} 个结果、识别 {} 条认知变化、{} 组矛盾、{} 个无证据行动与 {} 个开放候选；先调整做法，再检查前提。",
            outcome_values.len(),
            changed_claims.len(),
            contradictions.len(),
            no_evidence_action_values.len(),
            open_candidate_values.len(),
        );
        insert_node_with_provenance(
            &mut tx,
            NewNode {
                id: &node_id,
                kind: "insight",
                label: "真实周回顾",
                statement: Some(&statement),
                payload: &payload,
                scope: &json!({ "periodStart": period_start, "periodEnd": period_end }),
                sensitivity: &request.sensitivity_ceiling,
                expected_outcome: None,
                review_at: Some(&period_end),
                outcome: None,
                status: "active",
                now: &now,
            },
            "system_inferred",
            "system",
        )
        .await?;
        let node = fetch_node_tx(&mut tx, &node_id).await?.to_value();
        sqlx::query(
            "INSERT INTO weekly_reviews(id, node_id, change_set_id, receipt_key, period_start, \
             period_end, due_actions_json, outcomes_json, pending_revisions_json, \
             changed_claims_json, contradictions_json, no_evidence_actions_json, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&review_id)
        .bind(&node_id)
        .bind(&change_set_id)
        .bind(&receipt_key)
        .bind(&period_start)
        .bind(&period_end)
        .bind(serde_json::to_string(&due_action_values)?)
        .bind(serde_json::to_string(&outcome_values)?)
        .bind(serde_json::to_string(&pending_revisions)?)
        .bind(serde_json::to_string(&changed_claims)?)
        .bind(serde_json::to_string(&contradictions)?)
        .bind(serde_json::to_string(&no_evidence_action_values)?)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        insert_operation(
            &mut tx,
            &change_set_id,
            0,
            "create_node",
            &node_id,
            None,
            Some(&node),
            Some(&json!({ "operation": "soft_retract", "targetRef": node_id })),
        )
        .await?;
        let review_record = json!({
            "id": review_id,
            "nodeId": node_id,
            "changeSetId": change_set_id,
            "receiptKey": receipt_key,
            "periodStart": period_start,
            "periodEnd": period_end,
            "dueActions": due_action_values,
            "outcomes": outcome_values,
            "pendingRevisions": pending_revisions,
            "changedClaims": changed_claims,
            "contradictions": contradictions,
            "actionsWithoutEvidence": no_evidence_action_values,
            "candidates": candidate_values,
            "sections": sections,
            "createdAt": now,
        });
        insert_operation(
            &mut tx,
            &change_set_id,
            1,
            "create_weekly_review",
            &review_id,
            None,
            Some(&review_record),
            Some(&json!({ "operation": "remove_weekly_review", "targetRef": review_id })),
        )
        .await?;
        let mut summary_target_ids: Vec<String> = Vec::new();
        let mut seen_summary_targets = HashSet::new();
        for value in due_action_values.iter().chain(outcome_values.iter()) {
            if let Some(id) = value.get("id").and_then(Value::as_str) {
                if seen_summary_targets.insert(id.to_string()) {
                    summary_target_ids.push(id.to_string());
                }
            }
        }
        for value in &changed_claims {
            if let Some(id) = value.pointer("/claim/id").and_then(Value::as_str) {
                if seen_summary_targets.insert(id.to_string()) {
                    summary_target_ids.push(id.to_string());
                }
            }
        }
        for value in open_candidate_values
            .iter()
            .chain(concluded_candidate_values.iter())
            .chain(parked_candidate_values.iter())
        {
            if let Some(id) = value.get("id").and_then(Value::as_str) {
                if seen_summary_targets.insert(id.to_string()) {
                    summary_target_ids.push(id.to_string());
                }
            }
        }
        summary_target_ids.truncate(96);
        let mut trace_edges = Vec::new();
        let mut sequence = 2_i64;
        let mut inherited_evidence = HashSet::new();
        for target_id in summary_target_ids {
            let edge_id = create_edge_with_semantics_tx(
                &mut tx,
                &node_id,
                &target_id,
                EdgeSemantics {
                    family: "provenance",
                    relation_type: "derived_from",
                    direction: "directed",
                    proximity: "near",
                    strength: "medium",
                    basis: "derived_metric",
                    authority: "system_inferred",
                    status: "active",
                    rationale: "Weekly review traceability to an included action, outcome, or changed claim",
                },
                &json!({ "periodStart": period_start, "periodEnd": period_end }),
                &now,
            )
            .await?;
            let target_evidence: Vec<String> = sqlx::query_scalar(
                "SELECT evidence_ref_id FROM node_evidence_links WHERE node_id=? \
                 ORDER BY created_at, evidence_ref_id LIMIT 4",
            )
            .bind(&target_id)
            .fetch_all(&mut *tx)
            .await?;
            for evidence_ref in target_evidence {
                sqlx::query(
                    "INSERT OR IGNORE INTO edge_evidence_links(edge_id, evidence_ref_id, role, created_at) \
                     VALUES (?, ?, 'support', ?)",
                )
                .bind(&edge_id)
                .bind(&evidence_ref)
                .bind(&now)
                .execute(&mut *tx)
                .await?;
                sqlx::query(
                    "INSERT OR IGNORE INTO change_evidence_links(change_set_id, evidence_ref_id, created_at) \
                     VALUES (?, ?, ?)",
                )
                .bind(&change_set_id)
                .bind(&evidence_ref)
                .bind(&now)
                .execute(&mut *tx)
                .await?;
                if inherited_evidence.len() < 128 && inherited_evidence.insert(evidence_ref.clone())
                {
                    let inserted = sqlx::query(
                        "INSERT OR IGNORE INTO node_evidence_links(node_id, evidence_ref_id, role, created_at) \
                         VALUES (?, ?, 'support', ?)",
                    )
                    .bind(&node_id)
                    .bind(&evidence_ref)
                    .bind(&now)
                    .execute(&mut *tx)
                    .await?;
                    if inserted.rows_affected() > 0 {
                        let link = json!({
                            "nodeId": node_id,
                            "evidenceRefId": evidence_ref,
                            "role": "support",
                            "createdAt": now,
                        });
                        insert_operation(
                            &mut tx,
                            &change_set_id,
                            sequence,
                            "link_node_evidence",
                            &format!("{node_id}:{evidence_ref}:support"),
                            None,
                            Some(&link),
                            Some(&json!({
                                "operation": "unlink_node_evidence",
                                "nodeId": node_id,
                                "evidenceRefId": evidence_ref,
                                "role": "support"
                            })),
                        )
                        .await?;
                        sequence += 1;
                    }
                }
            }
            let edge = fetch_edge_tx(&mut tx, &edge_id).await?.to_value();
            insert_operation(
                &mut tx,
                &change_set_id,
                sequence,
                "create_edge",
                &edge_id,
                None,
                Some(&edge),
                Some(&json!({ "operation": "soft_close_edge", "targetRef": edge_id })),
            )
            .await?;
            sequence += 1;
            trace_edges.push(edge);
        }
        apply_change_set(&mut tx, &change_set_id, &now).await?;
        let response = MutationResponse {
            ok: true,
            change_set_id,
            value: json!({
                "review": { "id": review_id, "receiptKey": receipt_key, "periodStart": period_start, "periodEnd": period_end },
                "node": node,
                "dueActions": due_action_values,
                "outcomes": outcome_values,
                "pendingRevisions": pending_revisions,
                "changedClaims": changed_claims,
                "contradictions": contradictions,
                "actionsWithoutEvidence": no_evidence_action_values,
                "candidates": candidate_values,
                "sections": sections,
                "traceEdges": trace_edges,
            }),
        };
        complete_idempotency(&mut tx, idempotency, &response, &now).await?;
        tx.commit().await?;
        Ok(response)
    }

    pub async fn list_changes(&self, limit: u32) -> AppResult<Value> {
        let rows = sqlx::query(
            "SELECT id, status, reason_type, rationale, proposer_actor, authorization_mode, \
             reversible, created_at, applied_at, inverse_change_set_id \
             FROM change_sets ORDER BY created_at DESC LIMIT ?",
        )
        .bind(limit.clamp(1, 500) as i64)
        .fetch_all(&self.pool)
        .await?;
        let mut items = Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.try_get("id")?;
            let operations = sqlx::query(
                "SELECT sequence, operation_type, target_ref, before_json, after_json, inverse_json \
                 FROM change_operations WHERE change_set_id=? ORDER BY sequence ASC",
            )
            .bind(&id)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(|operation| {
                let before = operation
                    .get::<Option<String>, _>("before_json")
                    .and_then(|value| serde_json::from_str::<Value>(&value).ok());
                let after = operation
                    .get::<Option<String>, _>("after_json")
                    .and_then(|value| serde_json::from_str::<Value>(&value).ok());
                let inverse = operation
                    .get::<Option<String>, _>("inverse_json")
                    .and_then(|value| serde_json::from_str::<Value>(&value).ok());
                json!({
                    "sequence": operation.get::<i64, _>("sequence"),
                    "operationType": operation.get::<String, _>("operation_type"),
                    "targetRef": operation.get::<Option<String>, _>("target_ref"),
                    "before": before,
                    "after": after,
                    "inverse": inverse,
                })
            })
            .collect::<Vec<_>>();
            let evidence_refs: Vec<String> = sqlx::query_scalar(
                "SELECT evidence_ref_id FROM change_evidence_links WHERE change_set_id=? \
                 ORDER BY created_at, evidence_ref_id",
            )
            .bind(&id)
            .fetch_all(&self.pool)
            .await?;
            items.push(json!({
                "id": id,
                "status": row.get::<String, _>("status"),
                "reasonType": row.get::<String, _>("reason_type"),
                "rationale": row.get::<String, _>("rationale"),
                "proposerActor": row.get::<String, _>("proposer_actor"),
                "authorizationMode": row.get::<String, _>("authorization_mode"),
                "reversible": row.get::<i64, _>("reversible") == 1,
                "createdAt": row.get::<String, _>("created_at"),
                "appliedAt": row.get::<Option<String>, _>("applied_at"),
                "inverseChangeSetId": row.get::<Option<String>, _>("inverse_change_set_id"),
                "evidenceRefs": evidence_refs,
                "operations": operations,
            }));
        }
        Ok(json!({ "items": items }))
    }

    pub async fn due_actions(
        &self,
        at: Option<&str>,
        limit: u32,
        sensitivity_ceiling: &str,
    ) -> AppResult<Value> {
        let at = at.map(ToOwned::to_owned).unwrap_or_else(now_iso);
        validate_timestamp("at", &at)?;
        validate_choice("sensitivityCeiling", sensitivity_ceiling, SENSITIVITIES)?;
        let at_timestamp = chrono::DateTime::parse_from_rfc3339(&at)
            .map_err(|_| AppError::Invalid("at must be RFC3339".into()))?
            .timestamp_millis();
        // Standard Browser chat evidence is medium by default. A medium event
        // may wake a low action only as an opaque control-plane signal: the
        // due projection below returns no event statement or source excerpt.
        // High/highest evidence remains behind the caller's explicit ceiling.
        let event_signal_ceiling_rank =
            sensitivity_rank(sensitivity_ceiling).max(sensitivity_rank("medium")) as i64;
        let actions: Vec<NodeRecord> = sqlx::query_as(
            "SELECT id, schema_version, kind, layer, label, statement, payload_json, status, \
             authority, origin, scope_json, scope_key, sensitivity, valid_from, valid_to, \
             recorded_at, superseded_at, created_at, updated_at, deleted_at, expected_outcome, \
             review_at, outcome FROM nodes WHERE kind='action' AND deleted_at IS NULL \
             AND outcome IS NULL AND status IN ('active','shaping','scoped','disputed') \
             AND CASE sensitivity WHEN 'low' THEN 0 WHEN 'medium' THEN 1 \
             WHEN 'high' THEN 2 WHEN 'highest' THEN 3 ELSE 99 END <= ? \
             AND julianday(created_at)<=julianday(?) \
             ORDER BY julianday(created_at) ASC",
        )
        .bind(sensitivity_rank(sensitivity_ceiling) as i64)
        .bind(&at)
        .fetch_all(&self.pool)
        .await?;

        let mut due_items = Vec::new();
        for action in actions {
            // The event clock is driven by a durable, evidence-backed relation created after the
            // action. Merely ingesting an unrelated EvidenceEvent is intentionally insufficient.
            // A relation can target the action directly, or the Claim that this action tests.
            let event = sqlx::query(
                "SELECT event_id, observed_at, linked_at, relation_kind, relation_ref FROM ( \
                   SELECT ev.id AS event_id, ev.recorded_at AS observed_at, e.created_at AS linked_at, \
                          'direct_edge' AS relation_kind, e.id AS relation_ref \
                   FROM nodes ev JOIN edges e ON e.from_node_id=ev.id \
                   WHERE ev.kind='evidence_event' AND ev.deleted_at IS NULL \
                     AND CASE ev.sensitivity WHEN 'low' THEN 0 WHEN 'medium' THEN 1 \
                       WHEN 'high' THEN 2 WHEN 'highest' THEN 3 ELSE 99 END <= ? \
                     AND julianday(ev.recorded_at)<=julianday(?) \
                     AND e.to_node_id=? AND e.status IN ('active','disputed') \
                     AND e.relation_type IN ('supports','provides_evidence_for','derived_from', \
                       'about','part_of','serves','influences') \
                     AND julianday(e.created_at)>=julianday(?) \
                     AND julianday(e.created_at)<=julianday(?) \
                   UNION ALL \
                   SELECT ev.id, ev.recorded_at, related.created_at, 'tested_claim_edge', related.id \
                   FROM edges tested \
                   JOIN edges related ON related.to_node_id=tested.to_node_id \
                   JOIN nodes ev ON ev.id=related.from_node_id \
                   WHERE tested.from_node_id=? AND tested.relation_type='tests' \
                     AND tested.status IN ('active','disputed') \
                     AND ev.kind='evidence_event' AND ev.deleted_at IS NULL \
                     AND CASE ev.sensitivity WHEN 'low' THEN 0 WHEN 'medium' THEN 1 \
                       WHEN 'high' THEN 2 WHEN 'highest' THEN 3 ELSE 99 END <= ? \
                     AND julianday(ev.recorded_at)<=julianday(?) \
                     AND related.status IN ('active','disputed') \
                     AND related.relation_type IN ('supports','provides_evidence_for','derived_from', \
                       'about','part_of','serves','influences') \
                     AND (julianday(related.created_at)>julianday(?) OR ( \
                       julianday(related.created_at)=julianday(?) AND related.rowid>tested.rowid \
                     )) \
                     AND julianday(related.created_at)<=julianday(?) \
                   UNION ALL \
                   SELECT ev.id, ev.recorded_at, target_link.created_at, \
                          'shared_evidence', target_link.evidence_ref_id \
                   FROM nodes ev \
                   JOIN node_evidence_links event_link ON event_link.node_id=ev.id \
                   JOIN node_evidence_links target_link \
                     ON target_link.evidence_ref_id=event_link.evidence_ref_id \
                   WHERE ev.kind='evidence_event' AND ev.deleted_at IS NULL \
                     AND CASE ev.sensitivity WHEN 'low' THEN 0 WHEN 'medium' THEN 1 \
                       WHEN 'high' THEN 2 WHEN 'highest' THEN 3 ELSE 99 END <= ? \
                     AND julianday(ev.recorded_at)<=julianday(?) \
                     AND (target_link.node_id=? OR EXISTS ( \
                       SELECT 1 FROM edges tested \
                       WHERE tested.from_node_id=? AND tested.to_node_id=target_link.node_id \
                         AND tested.relation_type='tests' \
                         AND tested.status IN ('active','disputed') \
                     )) \
                     AND julianday(target_link.created_at)>julianday(?) \
                     AND julianday(target_link.created_at)<=julianday(?) \
                 ) ORDER BY julianday(linked_at) DESC, event_id DESC LIMIT 1",
            )
            .bind(event_signal_ceiling_rank)
            .bind(&at)
            .bind(&action.id)
            .bind(&action.created_at)
            .bind(&at)
            .bind(&action.id)
            .bind(event_signal_ceiling_rank)
            .bind(&at)
            .bind(&action.created_at)
            .bind(&action.created_at)
            .bind(&at)
            .bind(event_signal_ceiling_rank)
            .bind(&at)
            .bind(&action.id)
            .bind(&action.id)
            .bind(&action.created_at)
            .bind(&at)
            .fetch_optional(&self.pool)
            .await?;

            let (due_at, due_reason, event_receipt) = if let Some(event) = event {
                let linked_at = event.get::<String, _>("linked_at");
                (
                    linked_at.clone(),
                    "linked_event",
                    Some(json!({
                        "eventNodeId": event.get::<String, _>("event_id"),
                        "observedAt": event.get::<String, _>("observed_at"),
                        "linkedAt": linked_at,
                        "relationKind": event.get::<String, _>("relation_kind"),
                        "relationRef": event.get::<String, _>("relation_ref"),
                    })),
                )
            } else {
                let Some(review_at) = action.review_at.as_deref() else {
                    continue;
                };
                let review_timestamp = chrono::DateTime::parse_from_rfc3339(review_at)
                    .map_err(|_| {
                        AppError::Internal(format!("action {} has invalid reviewAt", action.id))
                    })?
                    .timestamp_millis();
                if review_timestamp > at_timestamp {
                    continue;
                }
                (review_at.to_string(), "calendar_fallback", None)
            };

            let mut value = action.to_value();
            if let Some(object) = value.as_object_mut() {
                object.insert("dueAt".into(), Value::String(due_at.clone()));
                object.insert("dueReason".into(), Value::String(due_reason.into()));
                if let Some(receipt) = event_receipt {
                    object.insert("triggerEventReceipt".into(), receipt);
                }
            }
            let sort_key = chrono::DateTime::parse_from_rfc3339(&due_at)
                .map(|value| value.timestamp_millis())
                .unwrap_or(i64::MAX);
            due_items.push((sort_key, value));
        }
        due_items.sort_by(|left, right| {
            left.0.cmp(&right.0).then_with(|| {
                left.1["id"]
                    .as_str()
                    .unwrap_or_default()
                    .cmp(right.1["id"].as_str().unwrap_or_default())
            })
        });
        due_items.truncate(limit.clamp(1, 500) as usize);
        Ok(json!({
            "ok": true,
            "dueBefore": at,
            "sensitivityCeiling": sensitivity_ceiling,
            "items": due_items.into_iter().map(|(_, value)| value).collect::<Vec<_>>(),
        }))
    }

    pub async fn due_candidates(
        &self,
        at: Option<&str>,
        limit: u32,
        sensitivity_ceiling: &str,
    ) -> AppResult<Value> {
        let at = at.map(ToOwned::to_owned).unwrap_or_else(now_iso);
        validate_timestamp("at", &at)?;
        validate_choice("sensitivityCeiling", sensitivity_ceiling, SENSITIVITIES)?;
        let candidates: Vec<NodeRecord> = sqlx::query_as(
            "SELECT id, schema_version, kind, layer, label, statement, payload_json, status, \
             authority, origin, scope_json, scope_key, sensitivity, valid_from, valid_to, \
             recorded_at, superseded_at, created_at, updated_at, deleted_at, expected_outcome, \
             review_at, outcome FROM nodes WHERE kind='experiment' AND deleted_at IS NULL \
             AND json_extract(payload_json, '$.interventionType')='candidate' \
             AND CASE sensitivity WHEN 'low' THEN 0 WHEN 'medium' THEN 1 \
             WHEN 'high' THEN 2 WHEN 'highest' THEN 3 ELSE 99 END <= ? \
             AND ((status='proposed' \
               AND json_type(payload_json, '$.proposedSilenceDueAt')='text' \
               AND julianday(json_extract(payload_json, '$.proposedSilenceDueAt'))<=julianday(?) \
               AND json_type(payload_json, '$.proposedPromptedAt') IS NULL) \
              OR (status='shaping' \
               AND json_type(payload_json, '$.shapingFollowupDueAt')='text' \
               AND julianday(json_extract(payload_json, '$.shapingFollowupDueAt'))<=julianday(?) \
               AND json_type(payload_json, '$.shapingPromptedAt') IS NULL)) \
             ORDER BY CASE status WHEN 'proposed' \
               THEN julianday(json_extract(payload_json, '$.proposedSilenceDueAt')) \
               ELSE julianday(json_extract(payload_json, '$.shapingFollowupDueAt')) END ASC, id ASC \
             LIMIT ?",
        )
        .bind(sensitivity_rank(sensitivity_ceiling) as i64)
        .bind(&at)
        .bind(&at)
        .bind(limit.clamp(1, 500) as i64)
        .fetch_all(&self.pool)
        .await?;

        let items = candidates
            .into_iter()
            .map(|candidate| {
                let payload: Value =
                    serde_json::from_str(&candidate.payload_json).unwrap_or_else(|_| json!({}));
                let (due_kind, due_at, recommended_command, prompt) =
                    if candidate.status == "proposed" {
                        (
                            "proposed_silence",
                            payload
                                .get("proposedSilenceDueAt")
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                            "acknowledge_due",
                            "这个候选已经安静放了 3 天。要不要先搁置，等新的触发再回来？",
                        )
                    } else {
                        (
                            "shaping_followup",
                            payload
                                .get("shapingFollowupDueAt")
                                .and_then(Value::as_str)
                                .unwrap_or_default(),
                            "acknowledge_due",
                            "这个候选已经塑形 7 天。还要继续共创，还是先形成结论或搁置？",
                        )
                    };
                json!({
                    "candidate": candidate.to_value(),
                    "dueKind": due_kind,
                    "dueAt": due_at,
                    "receiptKey": format!("candidate:{}:{due_kind}:{due_at}", candidate.id),
                    "recommendedCommand": recommended_command,
                    "prompt": prompt,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "ok": true,
            "dueBefore": at,
            "sensitivityCeiling": sensitivity_ceiling,
            "items": items,
            "mutationPolicy": "due queries never transition, conclude, or park candidates",
        }))
    }

    pub async fn review_status(
        &self,
        due_before: Option<&str>,
        status_filter: Option<&str>,
        limit: u32,
        sensitivity_ceiling: &str,
    ) -> AppResult<Value> {
        validate_choice("sensitivityCeiling", sensitivity_ceiling, SENSITIVITIES)?;
        let cutoff = match due_before {
            Some(value) => chrono::DateTime::parse_from_rfc3339(value)
                .map_err(|_| AppError::Invalid("dueBefore must be RFC3339".into()))?
                .with_timezone(&Local),
            None => Local::now(),
        };
        let days_from_monday = cutoff.weekday().num_days_from_monday() as i64;
        let current_week_start_date = cutoff.date_naive() - ChronoDuration::days(days_from_monday);
        let current_week_start_naive = current_week_start_date
            .and_hms_opt(0, 0, 0)
            .ok_or_else(|| AppError::Internal("could not calculate local week boundary".into()))?;
        let current_week_start = Local
            .from_local_datetime(&current_week_start_naive)
            .earliest()
            .ok_or_else(|| AppError::Internal("ambiguous local week boundary".into()))?;
        let period_end = current_week_start;
        let period_start = period_end - ChronoDuration::days(7);
        let period_start_iso = period_start.to_rfc3339_opts(SecondsFormat::Millis, true);
        let period_end_iso = period_end.to_rfc3339_opts(SecondsFormat::Millis, true);
        let receipt_key =
            weekly_receipt_key(&period_start_iso, &period_end_iso, sensitivity_ceiling);
        let generated = sqlx::query(
            "SELECT id, node_id, change_set_id, receipt_key, period_start, period_end, created_at \
             FROM weekly_reviews WHERE receipt_key=?",
        )
        .bind(&receipt_key)
        .fetch_optional(&self.pool)
        .await?;
        let ceiling_rank = sensitivity_rank(sensitivity_ceiling) as i64;
        let due_action_snapshot = self
            .due_actions(Some(&period_end_iso), 500, sensitivity_ceiling)
            .await?;
        let due_action_count = due_action_snapshot["items"]
            .as_array()
            .map(|items| items.len() as i64)
            .ok_or_else(|| AppError::Internal("due action snapshot is malformed".into()))?;
        let other_artifact_count: i64 = sqlx::query_scalar(
            "SELECT \
             (SELECT COUNT(*) FROM nodes o WHERE o.kind='outcome' AND o.deleted_at IS NULL \
               AND julianday(o.recorded_at)>=julianday(?) \
               AND julianday(o.recorded_at)<=julianday(?) \
               AND CASE o.sensitivity WHEN 'low' THEN 0 WHEN 'medium' THEN 1 \
                 WHEN 'high' THEN 2 WHEN 'highest' THEN 3 ELSE 99 END <= ?) + \
             (SELECT COUNT(*) FROM claim_revision_queue q JOIN nodes c ON c.id=q.claim_node_id \
               WHERE q.status='pending' AND c.deleted_at IS NULL \
               AND CASE c.sensitivity WHEN 'low' THEN 0 WHEN 'medium' THEN 1 \
                 WHEN 'high' THEN 2 WHEN 'highest' THEN 3 ELSE 99 END <= ?) + \
             (SELECT COUNT(*) FROM change_operations op \
               JOIN change_sets cs ON cs.id=op.change_set_id \
               WHERE cs.status='applied' AND julianday(cs.applied_at)>=julianday(?) \
                 AND julianday(cs.applied_at)<=julianday(?) \
                 AND op.operation_type IN ('create_node','update_node','close_node') \
                 AND op.after_json IS NOT NULL \
                 AND json_extract(op.after_json, '$.kind')='claim' \
                 AND CASE json_extract(op.after_json, '$.sensitivity') \
                   WHEN 'low' THEN 0 WHEN 'medium' THEN 1 WHEN 'high' THEN 2 \
                   WHEN 'highest' THEN 3 ELSE 99 END <= ?) + \
             (SELECT COUNT(*) FROM change_operations op \
               JOIN change_sets cs ON cs.id=op.change_set_id \
               WHERE cs.status='applied' AND julianday(cs.applied_at)>=julianday(?) \
                 AND julianday(cs.applied_at)<=julianday(?) \
                 AND op.operation_type IN ('create_node','update_node','close_node') \
                 AND op.after_json IS NOT NULL \
                 AND json_extract(op.after_json, '$.kind')='experiment' \
                 AND json_extract(op.after_json, '$.payload.interventionType')='candidate' \
                 AND CASE json_extract(op.after_json, '$.sensitivity') \
                   WHEN 'low' THEN 0 WHEN 'medium' THEN 1 WHEN 'high' THEN 2 \
                   WHEN 'highest' THEN 3 ELSE 99 END <= ?)",
        )
        .bind(&period_start_iso)
        .bind(&period_end_iso)
        .bind(ceiling_rank)
        .bind(ceiling_rank)
        .bind(&period_start_iso)
        .bind(&period_end_iso)
        .bind(ceiling_rank)
        .bind(&period_start_iso)
        .bind(&period_end_iso)
        .bind(ceiling_rank)
        .fetch_one(&self.pool)
        .await?;
        let eligible_artifact_count = due_action_count + other_artifact_count;
        let latest_complete_week = match generated {
            Some(row) => json!({
                "receiptKey": receipt_key,
                "periodStart": period_start_iso,
                "periodEnd": period_end_iso,
                "reviewAt": period_end_iso,
                "status": "generated",
                "reviewId": row.get::<String, _>("id"),
                "nodeId": row.get::<String, _>("node_id"),
                "changeSetId": row.get::<String, _>("change_set_id"),
                "createdAt": row.get::<String, _>("created_at"),
            }),
            None if eligible_artifact_count > 0 => json!({
                "receiptKey": receipt_key,
                "periodStart": period_start_iso,
                "periodEnd": period_end_iso,
                "reviewAt": period_end_iso,
                "status": "due",
                "eligibleArtifactCount": eligible_artifact_count,
            }),
            None => json!({
                "receiptKey": receipt_key,
                "periodStart": period_start_iso,
                "periodEnd": period_end_iso,
                "reviewAt": period_end_iso,
                "status": "empty",
                "eligibleArtifactCount": 0,
            }),
        };
        if status_filter == Some("due") {
            let due = if latest_complete_week["status"] == "due" {
                vec![latest_complete_week.clone()]
            } else {
                Vec::new()
            };
            return Ok(
                json!({ "ok": true, "items": due, "latestCompleteWeek": latest_complete_week, "sensitivityCeiling": sensitivity_ceiling }),
            );
        }

        let rows = sqlx::query(
            "SELECT id, node_id, change_set_id, receipt_key, period_start, period_end, created_at \
             FROM weekly_reviews ORDER BY period_end DESC LIMIT ?",
        )
        .bind(limit.clamp(1, 100) as i64)
        .fetch_all(&self.pool)
        .await?;
        let items = rows
            .into_iter()
            .map(|row| {
                json!({
                    "id": row.get::<String, _>("id"),
                    "nodeId": row.get::<String, _>("node_id"),
                    "changeSetId": row.get::<String, _>("change_set_id"),
                    "receiptKey": row.get::<String, _>("receipt_key"),
                    "periodStart": row.get::<String, _>("period_start"),
                    "periodEnd": row.get::<String, _>("period_end"),
                    "createdAt": row.get::<String, _>("created_at"),
                    "status": "generated",
                })
            })
            .collect::<Vec<_>>();
        Ok(
            json!({ "ok": true, "items": items, "latestCompleteWeek": latest_complete_week, "sensitivityCeiling": sensitivity_ceiling }),
        )
    }

    pub async fn export_document(&self) -> AppResult<ExportDocument> {
        // Keep every exported table on one SQLite read snapshot. Exporting each
        // table through the pool independently lets a concurrent Domain write
        // land between tables and can produce a checksum-valid document with
        // broken cross-table references.
        let mut tx = self.pool.begin().await?;
        let data = export_data_tx(&mut tx).await?;
        let checksum = export_content_checksum(&data)?;
        tx.commit().await?;
        Ok(ExportDocument {
            format: "latitude.constellation.export@0.1".into(),
            schema_version: CURRENT_SCHEMA_VERSION.into(),
            exported_at: now_iso(),
            checksum,
            data,
        })
    }

    pub async fn integrity(&self) -> AppResult<Value> {
        let quick_check: String = sqlx::query_scalar("PRAGMA quick_check")
            .fetch_one(&self.pool)
            .await?;
        let foreign_key_violations = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(|row| {
                json!({
                    "table": row.try_get::<String, _>("table").ok(),
                    "rowId": row.try_get::<i64, _>("rowid").ok(),
                    "parent": row.try_get::<String, _>("parent").ok(),
                    "foreignKeyIndex": row.try_get::<i64, _>("fkid").ok(),
                })
            })
            .collect::<Vec<_>>();
        let migration_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM schema_migrations")
            .fetch_one(&self.pool)
            .await?;
        let counts = json!({
            "nodes": sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM nodes").fetch_one(&self.pool).await?,
            "edges": sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM edges").fetch_one(&self.pool).await?,
            "evidenceRefs": sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM evidence_refs").fetch_one(&self.pool).await?,
            "changeSets": sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM change_sets").fetch_one(&self.pool).await?,
        });
        Ok(json!({
            "ok": quick_check == "ok" && foreign_key_violations.is_empty(),
            "quickCheck": quick_check,
            "foreignKeyViolations": foreign_key_violations,
            "migrationCount": migration_count,
            "counts": counts,
        }))
    }

    pub async fn restore_document(
        &self,
        document: &ExportDocument,
        audit: &AuditContext,
    ) -> AppResult<MutationResponse> {
        let _file_guard = self.history_file_lock.lock().await;
        audit.validate().map_err(AppError::Invalid)?;
        validate_export(document)?;
        let deletions: Vec<String> = sqlx::query_scalar("SELECT id FROM history_deletions")
            .fetch_all(&self.pool)
            .await?;
        let imported_deletions = document.data["historyDeletions"].as_array();
        if deletions
            .iter()
            .any(|id| !imported_deletions.is_some_and(|rows| rows.iter().any(|r| r["id"] == *id)))
        {
            return Err(AppError::Conflict("此快照早于你清理电脑记录的操作，恢复会重新引入已删除内容。请选择清理之后导出的快照。".into()));
        }
        let backup = self.create_backup("pre-restore").await?;
        let now = now_iso();
        let mut tx = self.pool.begin().await?;
        clear_domain_tables(&mut tx).await?;

        let data = document
            .data
            .as_object()
            .ok_or_else(|| AppError::Invalid("snapshot.data must be an object".into()))?;
        for (json_key, table, columns) in restore_table_order() {
            let rows = data.get(json_key).cloned().unwrap_or_else(|| json!([]));
            restore_table(&mut tx, table, columns, &rows).await?;
        }
        let quick_check: String = sqlx::query_scalar("PRAGMA quick_check")
            .fetch_one(&mut *tx)
            .await?;
        let foreign_key_violations = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut *tx)
            .await?;
        if quick_check != "ok" || !foreign_key_violations.is_empty() {
            return Err(AppError::Invalid(
                "restored snapshot failed SQLite integrity validation".into(),
            ));
        }
        let restored_data = export_data_tx(&mut tx).await?;
        let restored_checksum = export_content_checksum(&restored_data)?;
        if restored_checksum != document.checksum {
            return Err(AppError::Invalid(
                "restored snapshot content checksum does not match the export".into(),
            ));
        }
        // Restoring a profile cannot silently turn capture or cloud processing
        // back on. The visible switch is the user's authority for that action.
        let restored_config: String =
            sqlx::query_scalar("SELECT config_json FROM history_settings WHERE id=1")
                .fetch_optional(&mut *tx)
                .await?
                .unwrap_or_else(|| "{}".into());
        let mut history_config: Value = serde_json::from_str(&restored_config)?;
        if history_config["enabled"] == true
            || history_config["modelProcessing"] == true
            || history_config["externalEnabled"] == true
        {
            for key in ["enabled", "modelProcessing", "externalEnabled", "paused"] {
                history_config[key] = json!(false);
            }
            sqlx::query("UPDATE history_settings SET revision=revision+1,config_json=?,status_json='{}' WHERE id=1").bind(history_config.to_string()).execute(&mut *tx).await?;
            sqlx::query("UPDATE source_records SET model_access='forbidden' WHERE collector_version LIKE 'latitude-history/%'").execute(&mut *tx).await?;
        }
        let change_set_id = create_change_set(
            &mut tx,
            "migration",
            "Restore a validated local export after creating a recoverable pre-restore backup",
            audit,
        )
        .await?;
        sqlx::query("UPDATE change_sets SET reversible=0 WHERE id=?")
            .bind(&change_set_id)
            .execute(&mut *tx)
            .await?;
        let after = json!({
            "restoredChecksum": document.checksum,
            "verifiedChecksum": restored_checksum,
            "integrity": "ok",
            "preRestoreBackup": backup,
        });
        insert_operation(
            &mut tx,
            &change_set_id,
            0,
            "restore_database",
            "database",
            None,
            Some(&after),
            Some(&json!({ "operation": "restore_backup", "backupPath": backup })),
        )
        .await?;
        apply_change_set(&mut tx, &change_set_id, &now).await?;
        let response = MutationResponse {
            ok: true,
            change_set_id,
            value: after,
        };
        tx.commit().await?;
        self.write_history_memory_file().await?;
        Ok(response)
    }

    pub async fn delete_all(&self, audit: &AuditContext) -> AppResult<MutationResponse> {
        let _file_guard = self.history_file_lock.lock().await;
        audit.validate().map_err(AppError::Invalid)?;
        let backup = self.create_backup("pre-delete-all").await?;
        let before_integrity = self.integrity().await?;
        let now = now_iso();
        let reset_id = new_id("reset");
        let receipt_hash = checksum_value(&json!({
            "resetId": reset_id,
            "resetAt": now,
            "backupPath": backup,
            "before": before_integrity,
        }))?;
        let mut tx = self.pool.begin().await?;
        clear_domain_tables(&mut tx).await?;
        sqlx::query("DELETE FROM data_reset_log")
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO data_reset_log(id, reset_at, backup_path, receipt_hash) VALUES (?, ?, ?, ?)",
        )
        .bind(&reset_id)
        .bind(&now)
        .bind(backup.to_string_lossy().as_ref())
        .bind(&receipt_hash)
        .execute(&mut *tx)
        .await?;
        let change_set_id = create_change_set(
            &mut tx,
            "deletion",
            "Delete all local domain data after two-stage token confirmation; retain only reset receipt",
            audit,
        )
        .await?;
        sqlx::query("UPDATE change_sets SET reversible=0 WHERE id=?")
            .bind(&change_set_id)
            .execute(&mut *tx)
            .await?;
        let after = json!({
            "resetId": reset_id,
            "resetAt": now,
            "receiptHash": receipt_hash,
            "recoverableBackup": backup,
        });
        insert_operation(
            &mut tx,
            &change_set_id,
            0,
            "delete_all",
            "database",
            Some(&before_integrity),
            Some(&after),
            Some(&json!({ "operation": "restore_backup", "backupPath": backup })),
        )
        .await?;
        apply_change_set(&mut tx, &change_set_id, &now).await?;
        let response = MutationResponse {
            ok: true,
            change_set_id,
            value: after,
        };
        tx.commit().await?;
        self.write_history_memory_file().await?;
        Ok(response)
    }

    /// Permanently remove all Latitude domain/user/audit data controlled by this service.
    ///
    /// Unlike `delete_all`, this deliberately creates no backup and no persistent ChangeSet.
    /// Backup cleanup is allowlist-only: unknown entries and symlinks are never followed or
    /// removed, and make the returned result `partial` rather than widening the delete scope.
    pub async fn purge_all(&self) -> AppResult<Value> {
        let _file_guard = self.history_file_lock.lock().await;
        let purged_at = now_iso();
        let before = self.integrity().await?;

        let mut tx = self.pool.begin().await?;
        clear_domain_tables(&mut tx).await?;
        sqlx::query("DELETE FROM data_reset_log")
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        self.write_history_memory_file().await?;

        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&self.pool)
            .await?;
        let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode=DELETE")
            .fetch_one(&self.pool)
            .await?;
        sqlx::query("VACUUM").execute(&self.pool).await?;

        let sidecar_cleanup = cleanup_database_sidecars(&self.path).await;
        let backup_cleanup = cleanup_owned_backup_artifacts(&self.path, &self.backup_dir).await;

        let remaining = json!({
            "nodes": sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM nodes").fetch_one(&self.pool).await?,
            "edges": sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM edges").fetch_one(&self.pool).await?,
            "sourceRecords": sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM source_records").fetch_one(&self.pool).await?,
            "evidenceRefs": sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM evidence_refs").fetch_one(&self.pool).await?,
            "changeSets": sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM change_sets").fetch_one(&self.pool).await?,
            "idempotencyRows": sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM idempotency_ledger").fetch_one(&self.pool).await?,
            "resetReceipts": sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM data_reset_log").fetch_one(&self.pool).await?,
            "weeklyReviews": sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM weekly_reviews").fetch_one(&self.pool).await?,
        });
        let database_empty = remaining
            .as_object()
            .is_some_and(|counts| counts.values().all(|value| value.as_i64() == Some(0)));
        let cleanup_complete =
            sidecar_cleanup["status"] == "complete" && backup_cleanup["status"] == "complete";
        let status = if database_empty && cleanup_complete {
            "complete"
        } else {
            "partial"
        };
        Ok(json!({
            "ok": database_empty,
            "status": status,
            "operation": "purge_all",
            "purgedAt": purged_at,
            "recoverable": false,
            "persistentAudit": false,
            "journalMode": journal_mode,
            "beforeCounts": before["counts"],
            "remainingCounts": remaining,
            "sidecarCleanup": sidecar_cleanup,
            "backupCleanup": backup_cleanup,
            "externalCopiesNotice": "Exports or copies stored outside LATITUDE_BACKUP_DIR cannot be erased by this service."
        }))
    }
}

fn is_backup_timestamp(value: &str) -> bool {
    if value.len() != 20 {
        return false;
    }
    value.bytes().enumerate().all(|(index, byte)| match index {
        8 => byte == b'T',
        15 => byte == b'.',
        19 => byte == b'Z',
        _ => byte.is_ascii_digit(),
    })
}

#[derive(Clone, Copy)]
struct EdgeSemantics<'a> {
    family: &'a str,
    relation_type: &'a str,
    direction: &'a str,
    proximity: &'a str,
    strength: &'a str,
    basis: &'a str,
    authority: &'a str,
    status: &'a str,
    rationale: &'a str,
}

fn relationship_semantics(relation_type: &str) -> (&'static str, &'static str) {
    let family = match relation_type {
        "supports" | "contradicts" | "provides_evidence_for" | "tension_of" => "epistemic",
        "tests" | "implemented_as" | "resulted_in" | "blocks" => "behavioral",
        "derived_from" | "evolved_from" | "split_from" | "merged_from" => "lineage",
        _ => "semantic",
    };
    let direction = match relation_type {
        "conflicts_with" | "bridges" => "symmetric",
        _ => "directed",
    };
    (family, direction)
}

fn validate_current_relationship_node(node: &NodeRecord, now: &str) -> AppResult<()> {
    let closed_status = matches!(
        node.status.as_str(),
        "unsupported" | "revoked" | "deleted" | "rejected" | "superseded" | "expired"
    );
    let validity_expired = node.valid_to.as_deref().is_some_and(|valid_to| {
        match (
            chrono::DateTime::parse_from_rfc3339(valid_to),
            chrono::DateTime::parse_from_rfc3339(now),
        ) {
            (Ok(valid_to), Ok(now)) => valid_to <= now,
            _ => true,
        }
    });
    if node.deleted_at.is_some() || closed_status || validity_expired {
        Err(AppError::Conflict(format!(
            "node {} is not a current graph node",
            node.id
        )))
    } else {
        Ok(())
    }
}

fn validate_relationship_endpoint_kinds(
    relation_type: &str,
    from_kind: &str,
    to_kind: &str,
) -> AppResult<()> {
    let valid = match relation_type {
        "tests" => {
            matches!(from_kind, "action" | "experiment")
                && matches!(to_kind, "claim" | "observation")
        }
        "implemented_as" => {
            matches!(from_kind, "claim" | "decision" | "method" | "goal")
                && matches!(to_kind, "action" | "experiment")
        }
        "resulted_in" => matches!(from_kind, "action" | "experiment") && to_kind == "outcome",
        "tension_of" => {
            matches!(from_kind, "evidence_event" | "observation" | "claim") && to_kind == "tension"
        }
        "evolved_from" | "split_from" | "merged_from" => from_kind == to_kind,
        _ => true,
    };
    if valid {
        Ok(())
    } else {
        Err(AppError::Invalid(format!(
            "relationType {relation_type} is not valid from {from_kind} to {to_kind}"
        )))
    }
}

fn relationship_evidence_role(relation_type: &str) -> &'static str {
    match relation_type {
        "supports" | "provides_evidence_for" => "support",
        "contradicts" | "conflicts_with" | "tension_of" => "contradiction",
        _ => "reason",
    }
}

struct ClaimEffectResult {
    value: Value,
}

async fn fetch_node_pool(pool: &SqlitePool, id: &str) -> AppResult<NodeRecord> {
    sqlx::query_as::<_, NodeRecord>(
        "SELECT id, schema_version, kind, layer, label, statement, payload_json, status, \
         authority, origin, scope_json, scope_key, sensitivity, valid_from, valid_to, recorded_at, \
         superseded_at, created_at, updated_at, deleted_at, expected_outcome, review_at, outcome \
         FROM nodes WHERE id=?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("node {id}")))
}

fn sensitivity_rank(value: &str) -> u8 {
    match value {
        "low" => 0,
        "medium" => 1,
        "high" => 2,
        "highest" => 3,
        _ => u8::MAX,
    }
}

fn validate_observation_window(value: &Value) -> AppResult<()> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Ok(()),
        Value::Object(object) if !object.is_empty() => Ok(()),
        _ => Err(AppError::Invalid(
            "observationWindow must be a non-empty string or JSON object".into(),
        )),
    }
}

fn scalar_fingerprint(value: &Value, output: &mut HashSet<String>) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                match value {
                    Value::String(text) => {
                        output.insert(format!("{key}={}", text.trim().to_lowercase()));
                    }
                    Value::Number(number) => {
                        output.insert(format!("{key}={number}"));
                    }
                    Value::Bool(boolean) => {
                        output.insert(format!("{key}={boolean}"));
                    }
                    nested => scalar_fingerprint(nested, output),
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                scalar_fingerprint(item, output);
            }
        }
        _ => {}
    }
}

fn json_objects_overlap(left: &Value, right: &Value) -> bool {
    let mut left_values = HashSet::new();
    let mut right_values = HashSet::new();
    scalar_fingerprint(left, &mut left_values);
    scalar_fingerprint(right, &mut right_values);
    !left_values.is_empty() && !left_values.is_disjoint(&right_values)
}

fn semantic_overlap(left: &str, right: &str) -> bool {
    let left = left.trim().to_lowercase();
    let right = right.trim().to_lowercase();
    if left.chars().count() >= 2 && right.contains(&left) {
        return true;
    }
    if right.chars().count() >= 2 && left.contains(&right) {
        return true;
    }
    let tokens = |text: &str| {
        text.split(|character: char| !character.is_alphanumeric())
            .filter(|token| token.chars().count() >= 2)
            .map(ToOwned::to_owned)
            .collect::<HashSet<_>>()
    };
    let left_tokens = tokens(&left);
    let right_tokens = tokens(&right);
    !left_tokens.is_empty() && !left_tokens.is_disjoint(&right_tokens)
}

fn revision_row_to_value(row: sqlx::sqlite::SqliteRow) -> Value {
    let resolution = row
        .get::<Option<String>, _>("resolution_json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    json!({
        "id": row.get::<String, _>("id"),
        "claimNodeId": row.get::<String, _>("claim_node_id"),
        "outcomeNodeId": row.get::<String, _>("outcome_node_id"),
        "effect": row.get::<String, _>("effect"),
        "proposedStatement": row.get::<Option<String>, _>("proposed_statement"),
        "status": row.get::<String, _>("status"),
        "resolution": resolution,
        "resolutionChangeSetId": row.get::<Option<String>, _>("resolution_change_set_id"),
        "createdAt": row.get::<String, _>("created_at"),
        "resolvedAt": row.get::<Option<String>, _>("resolved_at"),
    })
}

async fn validate_and_source_evidence_tx(
    tx: &mut Transaction<'_, Sqlite>,
    evidence_ref: &str,
) -> AppResult<Option<String>> {
    let retracted: Option<String> = sqlx::query_scalar(
        "SELECT e.retracted_at FROM evidence_refs e \
             JOIN source_records s ON s.id=e.source_record_id \
             WHERE e.id=? AND s.deleted_at IS NULL",
    )
    .bind(evidence_ref)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("evidenceRef {evidence_ref}")))?;
    if retracted.is_some() {
        return Err(AppError::Conflict(format!(
            "evidenceRef {evidence_ref} is retracted"
        )));
    }
    let source_node_id = sqlx::query_scalar(
        "SELECT n.id FROM node_evidence_links l JOIN nodes n ON n.id=l.node_id \
         WHERE l.evidence_ref_id=? AND n.deleted_at IS NULL \
         AND n.status NOT IN ('deleted','revoked') \
         AND n.kind IN ('evidence_event','resource') \
         ORDER BY CASE n.kind WHEN 'evidence_event' THEN 0 WHEN 'resource' THEN 1 ELSE 2 END, \
         n.created_at ASC LIMIT 1",
    )
    .bind(evidence_ref)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(source_node_id)
}

async fn link_outcome_evidence_to_edge_tx(
    tx: &mut Transaction<'_, Sqlite>,
    change_set_id: &str,
    outcome_node_id: &str,
    edge_id: &str,
    now: &str,
) -> AppResult<()> {
    let evidence_refs: Vec<String> = sqlx::query_scalar(
        "SELECT evidence_ref_id FROM node_evidence_links WHERE node_id=? \
         ORDER BY created_at, evidence_ref_id LIMIT 32",
    )
    .bind(outcome_node_id)
    .fetch_all(&mut **tx)
    .await?;
    for evidence_ref in evidence_refs {
        sqlx::query(
            "INSERT OR IGNORE INTO edge_evidence_links(edge_id, evidence_ref_id, role, created_at) \
             VALUES (?, ?, 'reason', ?)",
        )
        .bind(edge_id)
        .bind(&evidence_ref)
        .bind(now)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            "INSERT OR IGNORE INTO change_evidence_links(change_set_id, evidence_ref_id, created_at) \
             VALUES (?, ?, ?)",
        )
        .bind(change_set_id)
        .bind(&evidence_ref)
        .bind(now)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn create_edge_with_semantics_tx(
    tx: &mut Transaction<'_, Sqlite>,
    from_node_id: &str,
    to_node_id: &str,
    semantics: EdgeSemantics<'_>,
    scope: &Value,
    now: &str,
) -> AppResult<String> {
    if from_node_id == to_node_id {
        return Err(AppError::Invalid("an edge cannot point to itself".into()));
    }
    let id = new_id("edge");
    sqlx::query(
        "INSERT INTO edges(\
         id, from_node_id, to_node_id, family, relation_type, direction, proximity, strength, basis, \
         authority, status, rationale, scope_json, scope_key, valid_from, recorded_at, created_at, \
         updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(from_node_id)
    .bind(to_node_id)
    .bind(semantics.family)
    .bind(semantics.relation_type)
    .bind(semantics.direction)
    .bind(semantics.proximity)
    .bind(semantics.strength)
    .bind(semantics.basis)
    .bind(semantics.authority)
    .bind(semantics.status)
    .bind(semantics.rationale)
    .bind(serde_json::to_string(scope)?)
    .bind(scope_key(scope)?)
    .bind(now)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(id)
}

#[allow(clippy::too_many_arguments)]
async fn create_evidenced_edge_tx(
    tx: &mut Transaction<'_, Sqlite>,
    from_node_id: &str,
    to_node_id: &str,
    family: &str,
    relation_type: &str,
    rationale: &str,
    scope: &Value,
    evidence_ref: &str,
    authority: &str,
    now: &str,
) -> AppResult<String> {
    let basis = match authority {
        "user_confirmed" | "user_corrected" => "user_confirmation",
        "source_verified" | "user_stated" => "explicit_statement",
        _ => "contextual",
    };
    let id = create_edge_with_semantics_tx(
        tx,
        from_node_id,
        to_node_id,
        EdgeSemantics {
            family,
            relation_type,
            direction: "directed",
            proximity: "direct",
            strength: "strong",
            basis,
            authority,
            status: "active",
            rationale,
        },
        scope,
        now,
    )
    .await?;
    sqlx::query(
        "INSERT INTO edge_evidence_links(edge_id, evidence_ref_id, role, created_at) \
         VALUES (?, ?, 'reason', ?)",
    )
    .bind(&id)
    .bind(evidence_ref)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(id)
}

#[allow(clippy::too_many_arguments)]
async fn create_inline_feedback_evidence_tx(
    tx: &mut Transaction<'_, Sqlite>,
    target_node_id: &str,
    feedback_type: &str,
    content_override: Option<&str>,
    audit: &AuditContext,
    change_set_id: &str,
    sequence: &mut i64,
    now: &str,
) -> AppResult<(String, String)> {
    let target = fetch_node_tx(tx, target_node_id).await?;
    let source_id = new_id("source");
    let evidence_id = new_id("evidence");
    let event_id = new_id("node");
    let statement = content_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("user {feedback_type} feedback for {target_node_id}"));
    let is_outcome = feedback_type == "outcome";
    let source_type = if is_outcome {
        "checkin"
    } else {
        "feed_feedback"
    };
    let processor = if is_outcome {
        "latitude.outcome-evidence"
    } else {
        "latitude.feedback"
    };
    let content_hash = format!("sha256:{:x}", Sha256::digest(statement.as_bytes()));
    let metadata = json!({
        "targetNodeId": target_node_id,
        "feedbackType": feedback_type,
        "sessionId": audit.session_id,
        "turnId": audit.turn_id,
        "toolCallId": audit.tool_call_id,
    });
    sqlx::query(
        "INSERT INTO source_records(\
         id, source_type, captured_at, storage_uri, content_hash, privacy_level, storage_policy, \
         model_access, coverage_status, collector_version, metadata_json, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, 'local_only', \
         'redacted_external_allowed', 'complete', ?, ?, ?)",
    )
    .bind(&source_id)
    .bind(source_type)
    .bind(now)
    .bind(format!(
        "latitude://feedback/{target_node_id}/{feedback_type}"
    ))
    .bind(&content_hash)
    .bind(&target.sensitivity)
    .bind(format!("{processor}@p0"))
    .bind(serde_json::to_string(&metadata)?)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "INSERT INTO evidence_refs(\
         id, source_record_id, actor_role, attribution_status, start_time, resource_id, excerpt, \
         content_hash, redaction_status, processor_name, processor_version, created_at) \
         VALUES (?, ?, 'user', 'verified', ?, ?, ?, ?, 'none', \
         ?, '0.1.0', ?)",
    )
    .bind(&evidence_id)
    .bind(&source_id)
    .bind(now)
    .bind(target_node_id)
    .bind(&statement)
    .bind(&content_hash)
    .bind(processor)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    let event_payload = json!({
        "feedbackType": feedback_type,
        "targetNodeId": target_node_id,
        "evidenceRefId": evidence_id,
        "recordedAt": now,
    });
    insert_node_with_provenance(
        tx,
        NewNode {
            id: &event_id,
            kind: "evidence_event",
            label: if is_outcome {
                "用户行动结果证据"
            } else {
                "用户反馈事件"
            },
            statement: Some(&statement),
            payload: &event_payload,
            scope: &json!({ "targetNodeId": target_node_id }),
            sensitivity: &target.sensitivity,
            expected_outcome: None,
            review_at: None,
            outcome: None,
            status: "active",
            now,
        },
        "source_verified",
        "user",
    )
    .await?;
    sqlx::query(
        "INSERT INTO node_evidence_links(node_id, evidence_ref_id, role, created_at) \
         VALUES (?, ?, 'provenance', ?)",
    )
    .bind(&event_id)
    .bind(&evidence_id)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "INSERT OR IGNORE INTO change_evidence_links(change_set_id, evidence_ref_id, created_at) \
         VALUES (?, ?, ?)",
    )
    .bind(change_set_id)
    .bind(&evidence_id)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    let source = json!({
        "id": source_id,
        "sourceType": source_type,
        "capturedAt": now,
        "contentHash": content_hash,
        "privacyLevel": target.sensitivity,
        "storagePolicy": "local_only",
        "modelAccess": "redacted_external_allowed",
        "coverageStatus": "complete",
        "collectorVersion": format!("{processor}@p0"),
        "metadata": metadata,
        "createdAt": now,
    });
    let evidence = json!({
        "id": evidence_id,
        "sourceRecordId": source_id,
        "actorRole": "user",
        "attributionStatus": "verified",
        "startTime": now,
        "resourceId": target_node_id,
        "excerpt": statement,
        "contentHash": content_hash,
        "redactionStatus": "none",
        "processorName": processor,
        "processorVersion": "0.1.0",
        "createdAt": now,
    });
    let event = fetch_node_tx(tx, &event_id).await?.to_value();
    for (operation_type, target_ref, after) in [
        ("create_source", source_id.as_str(), &source),
        ("create_evidence", evidence_id.as_str(), &evidence),
        ("create_node", event_id.as_str(), &event),
    ] {
        insert_operation(
            tx,
            change_set_id,
            *sequence,
            operation_type,
            target_ref,
            None,
            Some(after),
            Some(&json!({ "operation": "soft_remove", "targetRef": target_ref })),
        )
        .await?;
        *sequence += 1;
    }
    let link = json!({
        "nodeId": event_id,
        "evidenceRefId": evidence_id,
        "role": "provenance",
        "createdAt": now,
    });
    insert_operation(
        tx,
        change_set_id,
        *sequence,
        "link_node_evidence",
        &format!("{event_id}:{evidence_id}:provenance"),
        None,
        Some(&link),
        Some(&json!({
            "operation": "unlink_node_evidence",
            "nodeId": event_id,
            "evidenceRefId": evidence_id,
            "role": "provenance"
        })),
    )
    .await?;
    *sequence += 1;
    Ok((evidence_id, event_id))
}

async fn upsert_star_state_tx(
    tx: &mut Transaction<'_, Sqlite>,
    center_node_id: &str,
    now: &str,
) -> AppResult<(Option<Value>, Value)> {
    let center = fetch_node_tx(tx, center_node_id).await?;
    let current_row = sqlx::query(
        "SELECT center_node_id, version, role, importance, importance_authority, salience, \
         organizing_power, freshness, mass, radius, aura_version, state_status, \
         recompute_required, valid_from, valid_to, recorded_at, updated_at \
         FROM star_states WHERE center_node_id=? AND state_status='active' LIMIT 1",
    )
    .bind(center_node_id)
    .fetch_optional(&mut **tx)
    .await?;
    let before = current_row.map(star_state_row_to_value);
    let next_version = before
        .as_ref()
        .and_then(|value| value.get("version"))
        .and_then(Value::as_i64)
        .unwrap_or(0)
        + 1;
    if before.is_some() {
        sqlx::query(
            "UPDATE star_states SET state_status='superseded', valid_to=?, updated_at=? \
             WHERE center_node_id=? AND state_status='active'",
        )
        .bind(now)
        .bind(now)
        .bind(center_node_id)
        .execute(&mut **tx)
        .await?;
    }
    let evidence_refs: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT evidence_ref_id FROM node_evidence_links WHERE node_id=? \
         ORDER BY evidence_ref_id",
    )
    .bind(center_node_id)
    .fetch_all(&mut **tx)
    .await?;
    let support_edge_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM edges WHERE status IN ('active','disputed','proposed') \
         AND (from_node_id=? OR to_node_id=?) \
         AND relation_type IN ('supports','updates_confirms','updates_contracts','updates_revises', \
         'supersedes','orbits')",
    )
    .bind(center_node_id)
    .bind(center_node_id)
    .fetch_one(&mut **tx)
    .await?;
    let all_edge_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM edges WHERE status IN ('active','disputed','proposed') \
         AND (from_node_id=? OR to_node_id=?)",
    )
    .bind(center_node_id)
    .bind(center_node_id)
    .fetch_one(&mut **tx)
    .await?;
    let payload: Value = serde_json::from_str(&center.payload_json).unwrap_or_else(|_| json!({}));
    let importance = payload
        .get("importance")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "low" | "medium" | "high"))
        .unwrap_or({
            if matches!(center.kind.as_str(), "goal" | "value") {
                "medium"
            } else {
                "low"
            }
        });
    let role = if matches!(
        center.status.as_str(),
        "unsupported" | "rejected" | "superseded" | "expired" | "revoked"
    ) {
        "historical_star"
    } else if evidence_refs.len() + support_edge_count.max(0) as usize >= 3 {
        "active_star"
    } else if !evidence_refs.is_empty() || support_edge_count > 0 {
        "emerging_star"
    } else {
        "proto_star"
    };
    let mass = if evidence_refs.len() + support_edge_count.max(0) as usize >= 4 {
        "dense"
    } else if !evidence_refs.is_empty() || support_edge_count > 0 {
        "supported"
    } else {
        "sparse"
    };
    let organizing_power = if all_edge_count >= 6 {
        "anchor"
    } else if all_edge_count >= 2 {
        "connecting"
    } else {
        "local"
    };
    let scope: Value = serde_json::from_str(&center.scope_json).unwrap_or_else(|_| json!({}));
    let radius = match scope.as_object().map(|object| object.len()).unwrap_or(0) {
        0 => "broad",
        1 => "narrow",
        _ => "medium",
    };
    let salience = if center.status == "disputed" {
        "hot"
    } else if all_edge_count > 0 {
        "active"
    } else {
        "quiet"
    };
    // Importance is computed from node kind/payload and graph support. A user-authored node
    // does not by itself confirm the derived importance assessment.
    let importance_authority = "system_inferred";
    sqlx::query(
        "INSERT INTO star_states(\
         center_node_id, version, role, importance, importance_authority, salience, \
         organizing_power, freshness, mass, radius, aura_version, state_status, \
         recompute_required, valid_from, recorded_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, 'current', ?, ?, 0, 'active', 0, ?, ?, ?)",
    )
    .bind(center_node_id)
    .bind(next_version)
    .bind(role)
    .bind(importance)
    .bind(importance_authority)
    .bind(salience)
    .bind(organizing_power)
    .bind(mass)
    .bind(radius)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    for evidence_ref in &evidence_refs {
        sqlx::query(
            "INSERT INTO star_state_evidence_links(\
             center_node_id, star_version, evidence_ref_id, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(center_node_id)
        .bind(next_version)
        .bind(evidence_ref)
        .bind(now)
        .execute(&mut **tx)
        .await?;
    }
    let after_row = sqlx::query(
        "SELECT center_node_id, version, role, importance, importance_authority, salience, \
         organizing_power, freshness, mass, radius, aura_version, state_status, \
         recompute_required, valid_from, valid_to, recorded_at, updated_at \
         FROM star_states WHERE center_node_id=? AND version=?",
    )
    .bind(center_node_id)
    .bind(next_version)
    .fetch_one(&mut **tx)
    .await?;
    Ok((before, star_state_row_to_value(after_row)))
}

#[allow(clippy::too_many_arguments)]
async fn apply_claim_effect_tx(
    tx: &mut Transaction<'_, Sqlite>,
    change_set_id: &str,
    start_sequence: i64,
    claim_id: &str,
    outcome_id: &str,
    effect: &str,
    revised_statement: Option<&str>,
    revised_scope: Option<&Value>,
    audit: &AuditContext,
    provenance_override: Option<(&str, &str)>,
    enqueue_receipt: bool,
    now: &str,
) -> AppResult<ClaimEffectResult> {
    validate_choice(
        "effect",
        effect,
        &["confirms", "contracts", "revises", "refutes", "unknown"],
    )?;
    let claim_before = fetch_node_tx(tx, claim_id).await?;
    if claim_before.kind != "claim" {
        return Err(AppError::Invalid(
            "claim effect target must be a claim node".into(),
        ));
    }
    let previous_claim = claim_before.to_value();
    let (default_authority, default_origin) = provenance_for_audit(audit, true);
    let (authority, origin) = provenance_override.unwrap_or_else(|| {
        if audit.actor == "user" && effect == "confirms" {
            ("user_confirmed", "user")
        } else {
            (default_authority, default_origin)
        }
    });
    let mut sequence = start_sequence;
    let mut applied_claim = Value::Null;
    let mut effective_claim_id = claim_id.to_string();
    let mut effect_edges = Vec::new();

    match effect {
        "confirms" => {
            let mut payload: Value =
                serde_json::from_str(&claim_before.payload_json).unwrap_or_else(|_| json!({}));
            if let Some(object) = payload.as_object_mut() {
                let current = object
                    .get("confidenceBand")
                    .or_else(|| object.get("confidence"))
                    .and_then(Value::as_str)
                    .unwrap_or("weak");
                object.insert(
                    "confidenceBand".into(),
                    Value::String(strengthen_confidence_band(current).into()),
                );
                object.insert("lastConfirmedAt".into(), Value::String(now.into()));
                object.insert("lastOutcomeId".into(), Value::String(outcome_id.into()));
            }
            sqlx::query(
                "UPDATE nodes SET payload_json=?, status='active', authority=?, origin=?, \
                 valid_to=NULL, updated_at=? WHERE id=?",
            )
            .bind(serde_json::to_string(&payload)?)
            .bind(authority)
            .bind(origin)
            .bind(now)
            .bind(claim_id)
            .execute(&mut **tx)
            .await?;
            applied_claim = fetch_node_tx(tx, claim_id).await?.to_value();
            insert_operation(
                tx,
                change_set_id,
                sequence,
                "update_node",
                claim_id,
                Some(&previous_claim),
                Some(&applied_claim),
                Some(&json!({ "operation": "restore_node", "node": previous_claim })),
            )
            .await?;
            sequence += 1;
            for relation in ["updates_confirms", "supports"] {
                let edge_id = create_edge_with_semantics_tx(
                    tx,
                    outcome_id,
                    claim_id,
                    EdgeSemantics {
                        family: "epistemic",
                        relation_type: relation,
                        direction: "directed",
                        proximity: "direct",
                        strength: "strong",
                        basis: "direct_observation",
                        authority,
                        status: "active",
                        rationale: "A recorded real-world outcome reinforces this claim",
                    },
                    &json!({}),
                    now,
                )
                .await?;
                link_outcome_evidence_to_edge_tx(tx, change_set_id, outcome_id, &edge_id, now)
                    .await?;
                let edge = fetch_edge_tx(tx, &edge_id).await?.to_value();
                insert_operation(
                    tx,
                    change_set_id,
                    sequence,
                    "create_edge",
                    &edge_id,
                    None,
                    Some(&edge),
                    Some(&json!({ "operation": "soft_close_edge", "targetRef": edge_id })),
                )
                .await?;
                sequence += 1;
                effect_edges.push(edge);
            }
        }
        "contracts" | "revises" => {
            let statement = revised_statement
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::Invalid(format!("{effect} requires revisedStatement")))?;
            sqlx::query(
                "UPDATE nodes SET status='superseded', valid_to=?, superseded_at=?, authority=?, \
                 origin=?, updated_at=? WHERE id=?",
            )
            .bind(now)
            .bind(now)
            .bind(authority)
            .bind(origin)
            .bind(now)
            .bind(claim_id)
            .execute(&mut **tx)
            .await?;
            let old_after = fetch_node_tx(tx, claim_id).await?.to_value();
            insert_operation(
                tx,
                change_set_id,
                sequence,
                "update_node",
                claim_id,
                Some(&previous_claim),
                Some(&old_after),
                Some(&json!({ "operation": "restore_node", "node": previous_claim })),
            )
            .await?;
            sequence += 1;

            let new_claim_id = new_id("node");
            let mut payload: Value =
                serde_json::from_str(&claim_before.payload_json).unwrap_or_else(|_| json!({}));
            if let Some(object) = payload.as_object_mut() {
                object.insert("revisionEffect".into(), Value::String(effect.into()));
                object.insert("previousClaimId".into(), Value::String(claim_id.into()));
                object.insert("outcomeId".into(), Value::String(outcome_id.into()));
                if effect == "contracts" {
                    object.insert("qualifier".into(), Value::String("contracted_scope".into()));
                }
            }
            let scope = revised_scope.cloned().unwrap_or_else(|| {
                serde_json::from_str(&claim_before.scope_json).unwrap_or_else(|_| json!({}))
            });
            insert_node_with_provenance(
                tx,
                NewNode {
                    id: &new_claim_id,
                    kind: "claim",
                    label: &claim_before.label,
                    statement: Some(statement),
                    payload: &payload,
                    scope: &scope,
                    sensitivity: &claim_before.sensitivity,
                    expected_outcome: None,
                    review_at: None,
                    outcome: None,
                    status: if effect == "contracts" {
                        "scoped"
                    } else {
                        "active"
                    },
                    now,
                },
                authority,
                origin,
            )
            .await?;
            applied_claim = fetch_node_tx(tx, &new_claim_id).await?.to_value();
            insert_operation(
                tx,
                change_set_id,
                sequence,
                "create_node",
                &new_claim_id,
                None,
                Some(&applied_claim),
                Some(&json!({ "operation": "soft_retract", "targetRef": new_claim_id })),
            )
            .await?;
            sequence += 1;
            let lineage_id = create_edge_with_semantics_tx(
                tx,
                &new_claim_id,
                claim_id,
                EdgeSemantics {
                    family: "lineage",
                    relation_type: "supersedes",
                    direction: "directed",
                    proximity: "direct",
                    strength: "strong",
                    basis: "direct_observation",
                    authority,
                    status: "active",
                    rationale: "Outcome revision preserves the old claim as immutable history",
                },
                &scope,
                now,
            )
            .await?;
            link_outcome_evidence_to_edge_tx(tx, change_set_id, outcome_id, &lineage_id, now)
                .await?;
            let lineage = fetch_edge_tx(tx, &lineage_id).await?.to_value();
            insert_operation(
                tx,
                change_set_id,
                sequence,
                "create_edge",
                &lineage_id,
                None,
                Some(&lineage),
                Some(&json!({ "operation": "soft_close_edge", "targetRef": lineage_id })),
            )
            .await?;
            sequence += 1;
            effect_edges.push(lineage);
            let relation = if effect == "contracts" {
                "updates_contracts"
            } else {
                "updates_revises"
            };
            let update_id = create_edge_with_semantics_tx(
                tx,
                outcome_id,
                &new_claim_id,
                EdgeSemantics {
                    family: "epistemic",
                    relation_type: relation,
                    direction: "directed",
                    proximity: "direct",
                    strength: "strong",
                    basis: "direct_observation",
                    authority,
                    status: "active",
                    rationale: "The new claim version is grounded in this recorded outcome",
                },
                &scope,
                now,
            )
            .await?;
            link_outcome_evidence_to_edge_tx(tx, change_set_id, outcome_id, &update_id, now)
                .await?;
            let update_edge = fetch_edge_tx(tx, &update_id).await?.to_value();
            insert_operation(
                tx,
                change_set_id,
                sequence,
                "create_edge",
                &update_id,
                None,
                Some(&update_edge),
                Some(&json!({ "operation": "soft_close_edge", "targetRef": update_id })),
            )
            .await?;
            sequence += 1;
            effect_edges.push(update_edge);
            effective_claim_id = new_claim_id;
        }
        "refutes" => {
            sqlx::query(
                "UPDATE nodes SET status='unsupported', valid_to=?, authority=?, origin=?, \
                 updated_at=? WHERE id=?",
            )
            .bind(now)
            .bind(authority)
            .bind(origin)
            .bind(now)
            .bind(claim_id)
            .execute(&mut **tx)
            .await?;
            applied_claim = fetch_node_tx(tx, claim_id).await?.to_value();
            insert_operation(
                tx,
                change_set_id,
                sequence,
                "update_node",
                claim_id,
                Some(&previous_claim),
                Some(&applied_claim),
                Some(&json!({ "operation": "restore_node", "node": previous_claim })),
            )
            .await?;
            sequence += 1;
            let edge_id = create_edge_with_semantics_tx(
                tx,
                outcome_id,
                claim_id,
                EdgeSemantics {
                    family: "epistemic",
                    relation_type: "contradicts",
                    direction: "directed",
                    proximity: "direct",
                    strength: "strong",
                    basis: "direct_observation",
                    authority,
                    status: "active",
                    rationale: "The recorded outcome directly refutes the prior claim",
                },
                &json!({}),
                now,
            )
            .await?;
            link_outcome_evidence_to_edge_tx(tx, change_set_id, outcome_id, &edge_id, now).await?;
            let edge = fetch_edge_tx(tx, &edge_id).await?.to_value();
            insert_operation(
                tx,
                change_set_id,
                sequence,
                "create_edge",
                &edge_id,
                None,
                Some(&edge),
                Some(&json!({ "operation": "soft_close_edge", "targetRef": edge_id })),
            )
            .await?;
            sequence += 1;
            effect_edges.push(edge);
        }
        "unknown" => {
            let edge_id = create_edge_with_semantics_tx(
                tx,
                outcome_id,
                claim_id,
                EdgeSemantics {
                    family: "epistemic",
                    relation_type: "provides_evidence_for",
                    direction: "directed",
                    proximity: "direct",
                    strength: "weak",
                    basis: "direct_observation",
                    authority,
                    status: "active",
                    rationale: "Inconclusive outcome is retained without forcing a claim change",
                },
                &json!({}),
                now,
            )
            .await?;
            link_outcome_evidence_to_edge_tx(tx, change_set_id, outcome_id, &edge_id, now).await?;
            let edge = fetch_edge_tx(tx, &edge_id).await?.to_value();
            insert_operation(
                tx,
                change_set_id,
                sequence,
                "create_edge",
                &edge_id,
                None,
                Some(&edge),
                Some(&json!({ "operation": "soft_close_edge", "targetRef": edge_id })),
            )
            .await?;
            sequence += 1;
            effect_edges.push(edge);
        }
        _ => unreachable!("validated effect"),
    }

    let (before_star, star_state) = upsert_star_state_tx(tx, &effective_claim_id, now).await?;
    insert_operation(
        tx,
        change_set_id,
        sequence,
        "upsert_star_state",
        &effective_claim_id,
        before_star.as_ref(),
        Some(&star_state),
        before_star.as_ref(),
    )
    .await?;
    sequence += 1;

    let mut queue = Value::Null;
    if enqueue_receipt {
        let queue_id = new_id("revision");
        let queue_status = if effect == "unknown" {
            "pending"
        } else {
            "applied"
        };
        let resolution = if queue_status == "applied" {
            Some(json!({
                "resolution": effect,
                "effectiveClaimId": effective_claim_id,
                "appliedAt": now,
                "automatic": true,
            }))
        } else {
            None
        };
        sqlx::query(
            "INSERT INTO claim_revision_queue(\
             id, claim_node_id, outcome_node_id, effect, proposed_statement, status, \
             resolution_json, resolution_change_set_id, created_at, resolved_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&queue_id)
        .bind(claim_id)
        .bind(outcome_id)
        .bind(effect)
        .bind(revised_statement)
        .bind(queue_status)
        .bind(resolution.as_ref().map(serde_json::to_string).transpose()?)
        .bind(if queue_status == "applied" {
            Some(change_set_id)
        } else {
            None
        })
        .bind(now)
        .bind(if queue_status == "applied" {
            Some(now)
        } else {
            None
        })
        .execute(&mut **tx)
        .await?;
        queue = json!({
            "id": queue_id,
            "claimNodeId": claim_id,
            "outcomeNodeId": outcome_id,
            "effect": effect,
            "proposedStatement": revised_statement,
            "status": queue_status,
            "resolution": resolution,
            "resolutionChangeSetId": if queue_status == "applied" { Some(change_set_id) } else { None },
            "createdAt": now,
            "resolvedAt": if queue_status == "applied" { Some(now) } else { None },
        });
        insert_operation(
            tx,
            change_set_id,
            sequence,
            "enqueue_claim_revision",
            &queue_id,
            None,
            Some(&queue),
            Some(&json!({ "operation": "remove_claim_revision", "targetRef": queue_id })),
        )
        .await?;
    }
    Ok(ClaimEffectResult {
        value: json!({
            "id": queue.get("id").cloned().unwrap_or(Value::Null),
            "claimId": claim_id,
            "effectiveClaimId": effective_claim_id,
            "effect": effect,
            "status": queue.get("status").cloned().unwrap_or_else(|| Value::String("applied".into())),
            "previousClaim": previous_claim,
            "appliedClaim": applied_claim,
            "effectEdges": effect_edges,
            "starState": star_state,
            "queue": queue,
        }),
    })
}

fn strengthen_confidence_band(value: &str) -> &'static str {
    match value {
        "strong" | "high" => "strong",
        "medium" => "strong",
        _ => "medium",
    }
}

#[cfg(unix)]
async fn secure_private_directory(path: &Path) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = tokio::fs::symlink_metadata(path).await?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AppError::Invalid(format!(
            "private data directory {} must be a non-symlink directory",
            path.display()
        )));
    }
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await?;
    Ok(())
}

#[cfg(not(unix))]
async fn secure_private_directory(_path: &Path) -> AppResult<()> {
    Ok(())
}

#[cfg(unix)]
async fn secure_private_file(path: &Path) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = tokio::fs::symlink_metadata(path).await?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::Invalid(format!(
            "private data file {} must be a regular non-symlink file",
            path.display()
        )));
    }
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await?;
    Ok(())
}

#[cfg(not(unix))]
async fn secure_private_file(_path: &Path) -> AppResult<()> {
    Ok(())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn conversation_source(session_id: Option<&str>) -> (&'static str, &'static str) {
    let session_id = session_id.unwrap_or_default();
    if session_id.starts_with("codex-") {
        ("codex_coding_agent", "Codex 编程助手对话")
    } else if session_id.starts_with("latitude-browser-") {
        ("latitude_ai", "维度 AI 对话")
    } else if session_id.starts_with("latitude-sanitized-demo") {
        ("demo", "演示数据")
    } else if session_id.contains("scheduler") {
        ("latitude_scheduler", "维度后台任务")
    } else {
        ("unknown", "来源待确认的本地对话")
    }
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", Uuid::new_v4())
}

fn validate_non_empty(field: &str, value: &str) -> AppResult<()> {
    if value.trim().is_empty() {
        Err(AppError::Invalid(format!("{field} cannot be empty")))
    } else {
        Ok(())
    }
}

fn validate_unique_non_empty(field: &str, values: &[String]) -> AppResult<()> {
    let mut seen = HashSet::new();
    for value in values {
        validate_non_empty(&format!("{field}[]"), value)?;
        if !seen.insert(value.as_str()) {
            return Err(AppError::Invalid(format!(
                "{field} cannot contain duplicates"
            )));
        }
    }
    Ok(())
}

fn candidate_node_status(state: &str) -> Option<&'static str> {
    match state {
        "proposed" => Some("proposed"),
        "touched" => Some("active"),
        "shaping" => Some("shaping"),
        "concluded" => Some("concluded"),
        "parked" => Some("parked"),
        _ => None,
    }
}

fn validate_choice(field: &str, value: &str, choices: &[&str]) -> AppResult<()> {
    if choices.contains(&value) {
        Ok(())
    } else {
        Err(AppError::Invalid(format!(
            "{field} must be one of: {}",
            choices.join(", ")
        )))
    }
}

fn validate_timestamp(field: &str, value: &str) -> AppResult<()> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| AppError::Invalid(format!("{field} must be an RFC3339 timestamp")))
}

fn validate_json_object(field: &str, value: &Value) -> AppResult<()> {
    if value.is_object() {
        Ok(())
    } else {
        Err(AppError::Invalid(format!("{field} must be a JSON object")))
    }
}

fn layer_for_kind(kind: &str) -> &'static str {
    match kind {
        "evidence_event" => "evidence",
        "observation" => "observation",
        _ => "canonical",
    }
}

fn scope_key(scope: &Value) -> AppResult<String> {
    if scope.as_object().is_some_and(|object| object.is_empty()) {
        return Ok("*".into());
    }
    let encoded = serde_json::to_vec(scope)?;
    let digest = format!("{:x}", Sha256::digest(encoded));
    Ok(format!("scope:{}", &digest[..16]))
}

fn provenance_for_audit(audit: &AuditContext, correction: bool) -> (&'static str, &'static str) {
    match audit.actor.as_str() {
        "user" if correction => ("user_corrected", "user"),
        "user" => ("user_stated", "user"),
        "system" => ("system_inferred", "system"),
        "importer" => ("imported_unverified", "import"),
        _ => ("system_inferred", "model"),
    }
}

async fn insert_node_with_provenance(
    tx: &mut Transaction<'_, Sqlite>,
    node: NewNode<'_>,
    authority: &str,
    origin: &str,
) -> AppResult<()> {
    let payload_json = serde_json::to_string(node.payload)?;
    let scope_json = serde_json::to_string(node.scope)?;
    let scope_key = scope_key(node.scope)?;
    sqlx::query(
        "INSERT INTO nodes(\
         id, kind, layer, label, statement, payload_json, status, authority, origin, scope_json, \
         scope_key, sensitivity, valid_from, recorded_at, created_at, updated_at, expected_outcome, \
         review_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(node.id)
    .bind(node.kind)
    .bind(layer_for_kind(node.kind))
    .bind(node.label)
    .bind(node.statement)
    .bind(payload_json)
    .bind(node.status)
    .bind(authority)
    .bind(origin)
    .bind(scope_json)
    .bind(scope_key)
    .bind(node.sensitivity)
    .bind(node.now)
    .bind(node.now)
    .bind(node.now)
    .bind(node.now)
    .bind(node.expected_outcome)
    .bind(node.review_at)
    .bind(node.outcome)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn fetch_node_tx(tx: &mut Transaction<'_, Sqlite>, id: &str) -> AppResult<NodeRecord> {
    sqlx::query_as::<_, NodeRecord>(
        "SELECT id, schema_version, kind, layer, label, statement, payload_json, status, \
         authority, origin, scope_json, scope_key, sensitivity, valid_from, valid_to, recorded_at, \
         superseded_at, created_at, updated_at, deleted_at, expected_outcome, review_at, outcome \
         FROM nodes WHERE id=?",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("node {id}")))
}

async fn restore_node_tx(tx: &mut Transaction<'_, Sqlite>, value: &Value) -> AppResult<()> {
    let object = value
        .as_object()
        .ok_or_else(|| AppError::Internal("node rollback snapshot is not an object".into()))?;
    let id = json_required_string(object, "id")?;
    sqlx::query(
        "UPDATE nodes SET kind=?, layer=?, label=?, statement=?, payload_json=?, status=?, \
         authority=?, origin=?, scope_json=?, scope_key=?, sensitivity=?, valid_from=?, valid_to=?, \
         recorded_at=?, superseded_at=?, created_at=?, updated_at=?, deleted_at=?, expected_outcome=?, \
         review_at=?, outcome=? WHERE id=?",
    )
    .bind(json_required_string(object, "kind")?)
    .bind(json_required_string(object, "layer")?)
    .bind(json_required_string(object, "label")?)
    .bind(json_optional_string(object, "statement"))
    .bind(serde_json::to_string(object.get("payload").unwrap_or(&json!({})))?)
    .bind(json_required_string(object, "status")?)
    .bind(json_required_string(object, "authority")?)
    .bind(json_required_string(object, "origin")?)
    .bind(serde_json::to_string(object.get("scope").unwrap_or(&json!({})))?)
    .bind(json_required_string(object, "scopeKey")?)
    .bind(json_required_string(object, "sensitivity")?)
    .bind(json_optional_string(object, "validFrom"))
    .bind(json_optional_string(object, "validTo"))
    .bind(json_required_string(object, "recordedAt")?)
    .bind(json_optional_string(object, "supersededAt"))
    .bind(json_required_string(object, "createdAt")?)
    .bind(json_required_string(object, "updatedAt")?)
    .bind(json_optional_string(object, "deletedAt"))
    .bind(json_optional_string(object, "expectedOutcome"))
    .bind(json_optional_string(object, "reviewAt"))
    .bind(json_optional_string(object, "outcome"))
    .bind(id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn json_required_string(object: &Map<String, Value>, key: &str) -> AppResult<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| AppError::Internal(format!("rollback snapshot missing {key}")))
}

fn json_optional_string(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

#[allow(clippy::too_many_arguments)]
async fn create_edge_tx(
    tx: &mut Transaction<'_, Sqlite>,
    from_node_id: &str,
    to_node_id: &str,
    family: &str,
    relation_type: &str,
    rationale: &str,
    scope: &Value,
    now: &str,
) -> AppResult<String> {
    if from_node_id == to_node_id {
        return Err(AppError::Invalid("an edge cannot point to itself".into()));
    }
    let id = new_id("edge");
    sqlx::query(
        "INSERT INTO edges(\
         id, from_node_id, to_node_id, family, relation_type, direction, proximity, strength, basis, \
         authority, status, rationale, scope_json, scope_key, valid_from, recorded_at, created_at, \
         updated_at) VALUES (?, ?, ?, ?, ?, 'directed', 'direct', 'medium', 'contextual', \
         'system_inferred', 'active', ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(from_node_id)
    .bind(to_node_id)
    .bind(family)
    .bind(relation_type)
    .bind(rationale)
    .bind(serde_json::to_string(scope)?)
    .bind(scope_key(scope)?)
    .bind(now)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(id)
}

async fn fetch_edge_tx(tx: &mut Transaction<'_, Sqlite>, id: &str) -> AppResult<EdgeRecord> {
    sqlx::query_as::<_, EdgeRecord>(
        "SELECT id, schema_version, from_node_id, to_node_id, family, relation_type, direction, \
         proximity, strength, basis, authority, status, rationale, scope_json, scope_key, valid_from, \
         valid_to, recorded_at, superseded_at, created_at, updated_at FROM edges WHERE id=?",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("edge {id}")))
}

async fn restore_edge_tx(tx: &mut Transaction<'_, Sqlite>, value: &Value) -> AppResult<()> {
    let object = value
        .as_object()
        .ok_or_else(|| AppError::Internal("edge rollback snapshot is not an object".into()))?;
    let id = json_required_string(object, "id")?;
    sqlx::query(
        "UPDATE edges SET from_node_id=?, to_node_id=?, family=?, relation_type=?, direction=?, \
         proximity=?, strength=?, basis=?, authority=?, status=?, rationale=?, scope_json=?, \
         scope_key=?, valid_from=?, valid_to=?, recorded_at=?, superseded_at=?, created_at=?, \
         updated_at=? WHERE id=?",
    )
    .bind(json_required_string(object, "fromNodeId")?)
    .bind(json_required_string(object, "toNodeId")?)
    .bind(json_required_string(object, "family")?)
    .bind(json_required_string(object, "relationType")?)
    .bind(json_required_string(object, "direction")?)
    .bind(json_required_string(object, "proximity")?)
    .bind(json_required_string(object, "strength")?)
    .bind(json_required_string(object, "basis")?)
    .bind(json_required_string(object, "authority")?)
    .bind(json_required_string(object, "status")?)
    .bind(json_optional_string(object, "rationale"))
    .bind(serde_json::to_string(
        object.get("scope").unwrap_or(&json!({})),
    )?)
    .bind(json_required_string(object, "scopeKey")?)
    .bind(json_optional_string(object, "validFrom"))
    .bind(json_optional_string(object, "validTo"))
    .bind(json_required_string(object, "recordedAt")?)
    .bind(json_optional_string(object, "supersededAt"))
    .bind(json_required_string(object, "createdAt")?)
    .bind(json_required_string(object, "updatedAt")?)
    .bind(id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn create_change_set(
    tx: &mut Transaction<'_, Sqlite>,
    reason_type: &str,
    rationale: &str,
    audit: &AuditContext,
) -> AppResult<String> {
    audit.validate().map_err(AppError::Invalid)?;
    let id = new_id("change");
    let now = now_iso();
    let proposer_actor = match audit.actor.as_str() {
        "user" | "model" | "system" | "importer" => audit.actor.as_str(),
        _ => "model",
    };
    sqlx::query(
        "INSERT INTO change_sets(\
         id, reason_type, proposer_actor, proposer_version, status, authorization_mode, granted_by, \
         granted_at, rationale, reversible, created_at, actor_id, session_id, turn_id, tool_call_id) \
         VALUES (?, ?, ?, 'latitude-domain@0.1.0', 'drafted', ?, 'user-preauthorized-policy', ?, \
         ?, 1, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(reason_type)
    .bind(proposer_actor)
    .bind(&audit.authorization_mode)
    .bind(&now)
    .bind(rationale)
    .bind(&now)
    .bind(&audit.actor)
    .bind(audit.session_id.as_deref())
    .bind(audit.turn_id.as_deref())
    .bind(audit.tool_call_id.as_deref())
    .execute(&mut **tx)
    .await?;
    Ok(id)
}

async fn apply_change_set(
    tx: &mut Transaction<'_, Sqlite>,
    change_set_id: &str,
    now: &str,
) -> AppResult<()> {
    sqlx::query("UPDATE change_sets SET status='applied', applied_at=? WHERE id=?")
        .bind(now)
        .bind(change_set_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn insert_operation(
    tx: &mut Transaction<'_, Sqlite>,
    change_set_id: &str,
    sequence: i64,
    operation_type: &str,
    target_ref: &str,
    before: Option<&Value>,
    after: Option<&Value>,
    inverse: Option<&Value>,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO change_operations(\
         change_set_id, sequence, operation_type, target_ref, before_json, after_json, inverse_json) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(change_set_id)
    .bind(sequence)
    .bind(operation_type)
    .bind(target_ref)
    .bind(before.map(serde_json::to_string).transpose()?)
    .bind(after.map(serde_json::to_string).transpose()?)
    .bind(inverse.map(serde_json::to_string).transpose()?)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn begin_idempotency(
    tx: &mut Transaction<'_, Sqlite>,
    context: Option<&IdempotencyContext>,
) -> AppResult<Option<MutationResponse>> {
    let Some(context) = context else {
        return Ok(None);
    };
    let now = now_iso();
    let inserted = sqlx::query(
        "INSERT INTO idempotency_ledger(\
         request_key, route, request_hash, status, created_at) VALUES (?, ?, ?, 'running', ?) \
         ON CONFLICT(request_key, route) DO NOTHING",
    )
    .bind(&context.key)
    .bind(&context.route)
    .bind(&context.request_hash)
    .bind(&now)
    .execute(&mut **tx)
    .await?;
    if inserted.rows_affected() == 1 {
        return Ok(None);
    }
    let row = sqlx::query(
        "SELECT request_hash, status, response_json FROM idempotency_ledger \
         WHERE request_key=? AND route=?",
    )
    .bind(&context.key)
    .bind(&context.route)
    .fetch_one(&mut **tx)
    .await?;
    let existing_hash: String = row.try_get("request_hash")?;
    if existing_hash != context.request_hash {
        return Err(AppError::Conflict(
            "Idempotency-Key was already used with a different request body".into(),
        ));
    }
    let status: String = row.try_get("status")?;
    if status != "completed" {
        return Err(AppError::Conflict(
            "identical request is still running".into(),
        ));
    }
    let response_json: String = row
        .try_get::<Option<String>, _>("response_json")?
        .ok_or_else(|| AppError::Internal("completed idempotency row has no response".into()))?;
    Ok(Some(serde_json::from_str(&response_json)?))
}

async fn complete_idempotency(
    tx: &mut Transaction<'_, Sqlite>,
    context: Option<&IdempotencyContext>,
    response: &MutationResponse,
    now: &str,
) -> AppResult<()> {
    let Some(context) = context else {
        return Ok(());
    };
    sqlx::query(
        "UPDATE idempotency_ledger SET status='completed', response_json=?, completed_at=? \
         WHERE request_key=? AND route=?",
    )
    .bind(serde_json::to_string(response)?)
    .bind(now)
    .bind(&context.key)
    .bind(&context.route)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn star_state_row_to_value(row: sqlx::sqlite::SqliteRow) -> Value {
    json!({
        "centerNodeId": row.get::<String, _>("center_node_id"),
        "version": row.get::<i64, _>("version"),
        "role": row.get::<String, _>("role"),
        "importance": row.get::<String, _>("importance"),
        "importanceAuthority": row.get::<String, _>("importance_authority"),
        "salience": row.get::<String, _>("salience"),
        "organizingPower": row.get::<String, _>("organizing_power"),
        "freshness": row.get::<String, _>("freshness"),
        "mass": row.get::<String, _>("mass"),
        "radius": row.get::<String, _>("radius"),
        "auraVersion": row.get::<i64, _>("aura_version"),
        "stateStatus": row.get::<String, _>("state_status"),
        "recomputeRequired": row.get::<i64, _>("recompute_required") == 1,
        "validFrom": row.get::<String, _>("valid_from"),
        "validTo": row.get::<Option<String>, _>("valid_to"),
        "recordedAt": row.get::<String, _>("recorded_at"),
        "updatedAt": row.get::<String, _>("updated_at"),
    })
}

fn checksum_value(value: &Value) -> AppResult<String> {
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(value)?)
    ))
}

fn export_content_checksum(data: &Value) -> AppResult<String> {
    let mut content = data.clone();
    if let Some(object) = content.as_object_mut() {
        // Audit lineage grows when a restore itself is logged. The content checksum stays
        // stable across export -> restore -> export, while the full audit rows remain exported.
        object.remove("changeSets");
        object.remove("changeOperations");
        object.remove("changeEvidenceLinks");
    }
    checksum_value(&content)
}

fn weekly_receipt_key(period_start: &str, period_end: &str, sensitivity_ceiling: &str) -> String {
    let digest = format!(
        "{:x}",
        Sha256::digest(format!(
            "weekly:{period_start}:{period_end}:{sensitivity_ceiling}"
        ))
    );
    format!("weekly:{}", &digest[..24])
}

fn validate_export(document: &ExportDocument) -> AppResult<()> {
    if document.format != "latitude.constellation.export@0.1" {
        return Err(AppError::Invalid("unsupported export format".into()));
    }
    if document.schema_version != CURRENT_SCHEMA_VERSION {
        return Err(AppError::Invalid(format!(
            "snapshot schema {} cannot be restored by service schema {}",
            document.schema_version, CURRENT_SCHEMA_VERSION
        )));
    }
    let actual = export_content_checksum(&document.data)?;
    if actual != document.checksum {
        return Err(AppError::Invalid("snapshot checksum mismatch".into()));
    }
    Ok(())
}

async fn export_table_tx(
    tx: &mut Transaction<'_, Sqlite>,
    table: &str,
    columns: &[&str],
) -> AppResult<Value> {
    let pairs = columns
        .iter()
        .map(|column| format!("'{}', {}", column, column))
        .collect::<Vec<_>>()
        .join(", ");
    let order = columns.join(", ");
    let filter = if table == "idempotency_ledger" {
        " WHERE status='completed'"
    } else {
        ""
    };
    let sql = format!(
        "SELECT COALESCE(json_group_array(json_object({pairs})), '[]') \
         FROM (SELECT * FROM {table}{filter} ORDER BY {order})"
    );
    let raw: String = sqlx::query_scalar(&sql).fetch_one(&mut **tx).await?;
    Ok(serde_json::from_str(&raw)?)
}

async fn export_data_tx(tx: &mut Transaction<'_, Sqlite>) -> AppResult<Value> {
    let mut data = Map::new();
    for (json_key, table, columns) in export_tables() {
        data.insert(json_key.into(), export_table_tx(tx, table, columns).await?);
    }
    Ok(Value::Object(data))
}

fn export_tables() -> Vec<(&'static str, &'static str, &'static [&'static str])> {
    restore_table_order()
}

fn restore_table_order() -> Vec<(&'static str, &'static str, &'static [&'static str])> {
    vec![
        (
            "historySettings",
            "history_settings",
            &["id", "revision", "config_json", "status_json"],
        ),
        (
            "historyItems",
            "history_items",
            &[
                "id",
                "evidence_id",
                "source_id",
                "provider",
                "observed_at",
                "app",
                "bundle_id",
                "title",
                "url",
                "coverage",
                "group_id",
                "expired",
            ],
        ),
        (
            "historySummaries",
            "history_summaries",
            &["id", "revision", "content_json", "updated_at"],
        ),
        (
            "historyMemories",
            "history_memories",
            &["id", "statement", "groups_json", "status", "updated_at"],
        ),
        (
            "historyCuration",
            "history_curation",
            &["group_id", "updated_at"],
        ),
        (
            "historyDeletions",
            "history_deletions",
            &[
                "id",
                "from_time",
                "to_time",
                "app",
                "group_id",
                "created_at",
            ],
        ),
        ("sourceRecords", "source_records", SOURCE_RECORD_COLUMNS),
        ("evidenceRefs", "evidence_refs", EVIDENCE_REF_COLUMNS),
        ("nodes", "nodes", NODE_COLUMNS),
        (
            "nodeEvidenceLinks",
            "node_evidence_links",
            NODE_EVIDENCE_COLUMNS,
        ),
        ("edges", "edges", EDGE_COLUMNS),
        (
            "edgeEvidenceLinks",
            "edge_evidence_links",
            EDGE_EVIDENCE_COLUMNS,
        ),
        ("starStates", "star_states", STAR_STATE_COLUMNS),
        (
            "starStateEvidenceLinks",
            "star_state_evidence_links",
            STAR_STATE_EVIDENCE_COLUMNS,
        ),
        ("starAuras", "star_auras", STAR_AURA_COLUMNS),
        ("changeSets", "change_sets", CHANGE_SET_COLUMNS),
        (
            "changeOperations",
            "change_operations",
            CHANGE_OPERATION_COLUMNS,
        ),
        (
            "changeEvidenceLinks",
            "change_evidence_links",
            CHANGE_EVIDENCE_COLUMNS,
        ),
        (
            "claimRevisionQueue",
            "claim_revision_queue",
            CLAIM_REVISION_COLUMNS,
        ),
        ("weeklyReviews", "weekly_reviews", WEEKLY_REVIEW_COLUMNS),
        ("dataResetLog", "data_reset_log", DATA_RESET_LOG_COLUMNS),
        (
            "idempotencyLedger",
            "idempotency_ledger",
            IDEMPOTENCY_LEDGER_COLUMNS,
        ),
    ]
}

async fn restore_table(
    tx: &mut Transaction<'_, Sqlite>,
    table: &str,
    columns: &[&str],
    rows: &Value,
) -> AppResult<()> {
    let rows = rows
        .as_array()
        .ok_or_else(|| AppError::Invalid(format!("snapshot table {table} must be an array")))?;
    for row in rows {
        let object = row.as_object().ok_or_else(|| {
            AppError::Invalid(format!("snapshot row for {table} must be an object"))
        })?;
        let mut builder = QueryBuilder::<Sqlite>::new(format!(
            "INSERT {} INTO {table} (",
            if table == "history_deletions" {
                "OR IGNORE"
            } else {
                ""
            }
        ));
        {
            let mut names = builder.separated(", ");
            for column in columns {
                names.push(*column);
            }
        }
        builder.push(") VALUES (");
        {
            let mut values = builder.separated(", ");
            for column in columns {
                let bound = match object.get(*column) {
                    None | Some(Value::Null) => None,
                    Some(Value::String(value)) => Some(value.clone()),
                    Some(Value::Number(value)) => Some(value.to_string()),
                    Some(Value::Bool(value)) => Some(if *value { "1".into() } else { "0".into() }),
                    Some(value) => Some(serde_json::to_string(value)?),
                };
                values.push_bind(bound);
            }
        }
        builder.push(")");
        builder.build().execute(&mut **tx).await?;
    }
    Ok(())
}

async fn clear_domain_tables(tx: &mut Transaction<'_, Sqlite>) -> AppResult<()> {
    sqlx::query("UPDATE change_sets SET inverse_change_set_id=NULL")
        .execute(&mut **tx)
        .await?;
    for table in [
        "history_items",
        "history_summaries",
        "history_memories",
        "history_curation",
        "history_settings",
        "change_evidence_links",
        "change_operations",
        "weekly_reviews",
        "claim_revision_queue",
        "star_auras",
        "star_state_evidence_links",
        "star_states",
        "edge_evidence_links",
        "edges",
        "node_evidence_links",
        "evidence_refs",
        "source_records",
        "nodes",
        "change_sets",
        "data_reset_log",
        "idempotency_ledger",
    ] {
        let sql = format!("DELETE FROM {table}");
        sqlx::query(&sql).execute(&mut **tx).await?;
    }
    sqlx::query("DELETE FROM node_fts")
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn cleanup_database_sidecars(db_path: &Path) -> Value {
    let mut deleted = Vec::new();
    let mut refused = Vec::new();
    let mut errors = Vec::new();
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", db_path.display()));
        let name = sidecar
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(suffix)
            .to_string();
        match tokio::fs::symlink_metadata(&sidecar).await {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                refused.push(json!({ "name": name, "reason": "symlink_refused" }));
            }
            Ok(metadata) if metadata.is_file() => match tokio::fs::remove_file(&sidecar).await {
                Ok(()) => deleted.push(name),
                Err(error) => errors.push(json!({ "name": name, "error": error.to_string() })),
            },
            Ok(_) => refused.push(json!({ "name": name, "reason": "not_a_regular_file" })),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => errors.push(json!({ "name": name, "error": error.to_string() })),
        }
    }
    let status = if refused.is_empty() && errors.is_empty() {
        "complete"
    } else {
        "partial"
    };
    json!({ "status": status, "deleted": deleted, "refused": refused, "errors": errors })
}

async fn cleanup_owned_backup_artifacts(db_path: &Path, backup_dir: &Path) -> Value {
    let db_filename = db_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("latitude-domain.db");
    let owned_prefix = format!("{db_filename}.");
    let mut deleted = Vec::new();
    let mut refused = Vec::new();
    let mut errors = Vec::new();

    match tokio::fs::symlink_metadata(backup_dir).await {
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return json!({ "status": "complete", "deleted": [], "refused": [], "errors": [] });
        }
        Err(error) => {
            return json!({
                "status": "partial",
                "deleted": [],
                "refused": [],
                "errors": [{ "name": backup_dir.file_name().and_then(|v| v.to_str()), "error": error.to_string() }]
            });
        }
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return json!({
                "status": "partial",
                "deleted": [],
                "refused": [{ "name": backup_dir.file_name().and_then(|v| v.to_str()), "reason": "backup_directory_symlink_refused" }],
                "errors": []
            });
        }
        Ok(metadata) if !metadata.is_dir() => {
            return json!({
                "status": "partial",
                "deleted": [],
                "refused": [{ "name": backup_dir.file_name().and_then(|v| v.to_str()), "reason": "backup_path_is_not_a_directory" }],
                "errors": []
            });
        }
        Ok(_) => {}
    }

    let mut entries = match tokio::fs::read_dir(backup_dir).await {
        Ok(entries) => entries,
        Err(error) => {
            return json!({
                "status": "partial",
                "deleted": [],
                "refused": [],
                "errors": [{ "name": backup_dir.file_name().and_then(|v| v.to_str()), "error": error.to_string() }]
            });
        }
    };
    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(error) => {
                errors.push(json!({ "name": Value::Null, "error": error.to_string() }));
                break;
            }
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let owned = name.starts_with(&owned_prefix)
            && (name.ends_with(".bak") || name.ends_with(".bak-wal") || name.ends_with(".bak-shm"));
        if !owned {
            refused.push(json!({ "name": name, "reason": "unknown_artifact" }));
            continue;
        }
        match tokio::fs::symlink_metadata(entry.path()).await {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                refused.push(json!({ "name": name, "reason": "symlink_refused" }));
            }
            Ok(metadata) if metadata.is_file() => {
                match tokio::fs::remove_file(entry.path()).await {
                    Ok(()) => deleted.push(name),
                    Err(error) => errors.push(json!({ "name": name, "error": error.to_string() })),
                }
            }
            Ok(_) => refused.push(json!({ "name": name, "reason": "not_a_regular_file" })),
            Err(error) => errors.push(json!({ "name": name, "error": error.to_string() })),
        }
    }
    let status = if refused.is_empty() && errors.is_empty() {
        "complete"
    } else {
        "partial"
    };
    json!({ "status": status, "deleted": deleted, "refused": refused, "errors": errors })
}

const SOURCE_RECORD_COLUMNS: &[&str] = &[
    "id",
    "source_type",
    "captured_at",
    "ended_at",
    "storage_uri",
    "content_hash",
    "privacy_level",
    "storage_policy",
    "model_access",
    "coverage_status",
    "suppressed_count",
    "collector_version",
    "metadata_json",
    "created_at",
    "deleted_at",
];
const EVIDENCE_REF_COLUMNS: &[&str] = &[
    "id",
    "schema_version",
    "source_record_id",
    "actor_id",
    "actor_role",
    "attribution_status",
    "segment_id",
    "raw_event_ids_json",
    "start_time",
    "end_time",
    "transcript_span",
    "resource_id",
    "excerpt",
    "content_hash",
    "redaction_status",
    "processor_name",
    "processor_version",
    "created_at",
    "retracted_at",
];
const NODE_COLUMNS: &[&str] = &[
    "id",
    "schema_version",
    "kind",
    "layer",
    "label",
    "statement",
    "payload_json",
    "status",
    "authority",
    "origin",
    "scope_json",
    "scope_key",
    "sensitivity",
    "valid_from",
    "valid_to",
    "recorded_at",
    "superseded_at",
    "created_at",
    "updated_at",
    "deleted_at",
    "expected_outcome",
    "review_at",
    "outcome",
];
const NODE_EVIDENCE_COLUMNS: &[&str] = &["node_id", "evidence_ref_id", "role", "created_at"];
const EDGE_COLUMNS: &[&str] = &[
    "id",
    "schema_version",
    "from_node_id",
    "to_node_id",
    "family",
    "relation_type",
    "direction",
    "proximity",
    "strength",
    "basis",
    "authority",
    "status",
    "rationale",
    "scope_json",
    "scope_key",
    "valid_from",
    "valid_to",
    "recorded_at",
    "superseded_at",
    "created_at",
    "updated_at",
];
const EDGE_EVIDENCE_COLUMNS: &[&str] = &["edge_id", "evidence_ref_id", "role", "created_at"];
const STAR_STATE_COLUMNS: &[&str] = &[
    "center_node_id",
    "version",
    "schema_version",
    "role",
    "importance",
    "importance_authority",
    "salience",
    "organizing_power",
    "freshness",
    "mass",
    "radius",
    "aura_version",
    "state_status",
    "recompute_required",
    "valid_from",
    "valid_to",
    "recorded_at",
    "updated_at",
];
const STAR_STATE_EVIDENCE_COLUMNS: &[&str] = &[
    "center_node_id",
    "star_version",
    "evidence_ref_id",
    "created_at",
];
const STAR_AURA_COLUMNS: &[&str] = &[
    "center_node_id",
    "star_version",
    "aura_version",
    "core_summary",
    "near_summary",
    "middle_summary",
    "boundary_summary",
    "current_shift",
    "representative_nodes_json",
    "generated_by",
    "generated_at",
    "status",
];
// inverse_change_set_id is deliberately omitted: every restored mutation remains auditable,
// while self-referential rollback links are rebuilt by subsequent live rollbacks.
const CHANGE_SET_COLUMNS: &[&str] = &[
    "id",
    "schema_version",
    "reason_type",
    "proposer_actor",
    "proposer_version",
    "status",
    "authorization_mode",
    "granted_by",
    "granted_at",
    "rationale",
    "reversible",
    "created_at",
    "applied_at",
    "actor_id",
    "session_id",
    "turn_id",
    "tool_call_id",
];
const CHANGE_OPERATION_COLUMNS: &[&str] = &[
    "change_set_id",
    "sequence",
    "operation_type",
    "target_ref",
    "before_json",
    "after_json",
    "inverse_json",
];
const CHANGE_EVIDENCE_COLUMNS: &[&str] = &["change_set_id", "evidence_ref_id", "created_at"];
const CLAIM_REVISION_COLUMNS: &[&str] = &[
    "id",
    "claim_node_id",
    "outcome_node_id",
    "effect",
    "proposed_statement",
    "status",
    "resolution_json",
    "resolution_change_set_id",
    "created_at",
    "resolved_at",
];
const WEEKLY_REVIEW_COLUMNS: &[&str] = &[
    "id",
    "node_id",
    "change_set_id",
    "receipt_key",
    "period_start",
    "period_end",
    "due_actions_json",
    "outcomes_json",
    "pending_revisions_json",
    "changed_claims_json",
    "contradictions_json",
    "no_evidence_actions_json",
    "created_at",
];
const DATA_RESET_LOG_COLUMNS: &[&str] = &["id", "reset_at", "backup_path", "receipt_hash"];
const IDEMPOTENCY_LEDGER_COLUMNS: &[&str] = &[
    "request_key",
    "route",
    "request_hash",
    "status",
    "response_json",
    "created_at",
    "completed_at",
];
