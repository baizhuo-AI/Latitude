use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

fn default_actor() -> String {
    "model".to_string()
}

fn default_authorization_mode() -> String {
    "automatic".to_string()
}

fn default_kind() -> String {
    "claim".to_string()
}

fn default_sensitivity() -> String {
    // Medium is private-by-default. `low` is an explicit opt-in boundary for unattended
    // curation/export-to-model contexts; browser-driven local reads can still request highest.
    "medium".to_string()
}

fn default_limit() -> u32 {
    100
}

fn default_evidence_sampling_mode() -> String {
    "recent".to_string()
}

fn default_events_per_source() -> u32 {
    1
}

fn default_max_candidates() -> u32 {
    8
}

fn default_complete_coverage() -> String {
    "complete".to_string()
}

fn default_true() -> bool {
    true
}

fn default_max_nodes() -> u32 {
    48
}

fn default_max_edges() -> u32 {
    96
}

fn default_max_depth() -> u32 {
    3
}

fn default_sensitivity_ceiling() -> String {
    "highest".to_string()
}

fn default_json_object() -> Value {
    json!({})
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditContext {
    #[serde(default = "default_actor")]
    pub actor: String,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub tool_call_id: Option<String>,
    #[serde(default = "default_authorization_mode")]
    pub authorization_mode: String,
}

impl Default for AuditContext {
    fn default() -> Self {
        Self {
            actor: default_actor(),
            session_id: None,
            turn_id: None,
            tool_call_id: None,
            authorization_mode: default_authorization_mode(),
        }
    }
}

impl AuditContext {
    pub fn validate(&self) -> Result<(), String> {
        if self.actor.trim().is_empty() {
            return Err("audit.actor cannot be empty".into());
        }
        if !matches!(
            self.authorization_mode.as_str(),
            "automatic" | "preauthorized"
        ) {
            return Err("authorizationMode must be automatic or preauthorized".into());
        }
        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextRequest {
    #[serde(default)]
    pub exclude_history: bool,
    pub query: Option<String>,
    #[serde(default)]
    pub offset: u32,
    #[serde(default)]
    pub kinds: Vec<String>,
    /// Exact subtypes allowed for evidence_event nodes. Other node kinds are
    /// unaffected, so a projection can request semantic nodes plus activities
    /// without admitting raw Computer History events.
    #[serde(default)]
    pub evidence_types: Vec<String>,
    #[serde(default)]
    pub include_retracted: bool,
    #[serde(default = "default_limit")]
    pub limit: u32,
    #[serde(default = "default_sensitivity_ceiling")]
    pub sensitivity_ceiling: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RememberRequest {
    pub client_request_id: Option<String>,
    pub label: String,
    pub statement: Option<String>,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default = "default_json_object")]
    pub payload: Value,
    #[serde(default = "default_json_object")]
    pub scope: Value,
    #[serde(default = "default_sensitivity")]
    pub sensitivity: String,
    #[serde(default, alias = "evidenceRefIds")]
    pub evidence_refs: Vec<String>,
    pub expected_outcome: Option<String>,
    pub review_at: Option<String>,
    pub outcome: Option<String>,
    #[serde(default)]
    pub audit: AuditContext,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRequest {
    pub client_request_id: Option<String>,
    pub id: String,
    pub label: Option<String>,
    pub statement: Option<String>,
    pub payload: Option<Value>,
    pub status: Option<String>,
    pub expected_outcome: Option<String>,
    pub review_at: Option<String>,
    pub outcome: Option<String>,
    #[serde(default)]
    pub audit: AuditContext,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetractRequest {
    pub client_request_id: Option<String>,
    pub id: String,
    pub reason: String,
    #[serde(default)]
    pub audit: AuditContext,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackRequest {
    pub client_request_id: Option<String>,
    #[serde(default)]
    pub change_set_id: String,
    pub reason: Option<String>,
    #[serde(default)]
    pub audit: AuditContext,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum ChangeRequest {
    Remember(RememberRequest),
    Update(UpdateRequest),
    Retract(RetractRequest),
    Rollback(RollbackRequest),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRequest {
    pub client_request_id: Option<String>,
    pub label: String,
    pub statement: Option<String>,
    pub expected_outcome: String,
    pub trigger: String,
    pub observation_window: Value,
    pub review_at: String,
    #[serde(default = "default_json_object")]
    pub payload: Value,
    #[serde(default = "default_json_object")]
    pub scope: Value,
    #[serde(default = "default_sensitivity")]
    pub sensitivity: String,
    pub claim_id: Option<String>,
    #[serde(default)]
    pub audit: AuditContext,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateCreateRequest {
    pub client_request_id: Option<String>,
    pub label: String,
    pub statement: String,
    #[serde(default)]
    pub source_node_ids: Vec<String>,
    #[serde(default, alias = "evidenceRefIds")]
    pub evidence_refs: Vec<String>,
    #[serde(default = "default_json_object")]
    pub payload: Value,
    #[serde(default = "default_json_object")]
    pub scope: Value,
    #[serde(default = "default_sensitivity")]
    pub sensitivity: String,
    #[serde(default)]
    pub audit: AuditContext,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateCommandRequest {
    pub client_request_id: Option<String>,
    pub command: String,
    pub note: Option<String>,
    #[serde(default, alias = "evidenceRefIds")]
    pub evidence_refs: Vec<String>,
    #[serde(default)]
    pub audit: AuditContext,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutcomeRequest {
    pub client_request_id: Option<String>,
    pub action_id: String,
    pub label: Option<String>,
    pub outcome: String,
    pub observed_at: Option<String>,
    pub effect: Option<String>,
    pub claim_id: Option<String>,
    pub revised_statement: Option<String>,
    pub revised_scope: Option<Value>,
    #[serde(default, alias = "evidenceRefIds")]
    pub evidence_refs: Vec<String>,
    #[serde(default = "default_json_object")]
    pub payload: Value,
    #[serde(default)]
    pub audit: AuditContext,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebEvidenceRequest {
    pub client_request_id: Option<String>,
    pub query: String,
    /// Host-owned explanation captured at ranking time. This is presentation
    /// provenance only; it never grants prompt, tool, or mutation authority to
    /// the untrusted web content.
    pub why_now: String,
    pub url: String,
    pub title: String,
    pub snippet: String,
    pub published_at: Option<String>,
    pub retrieved_at: String,
    pub content_hash: String,
    pub provider: Option<String>,
    #[serde(default = "default_sensitivity")]
    pub sensitivity: String,
    #[serde(default)]
    pub audit: AuditContext,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageEvidenceRequest {
    pub client_request_id: Option<String>,
    pub message_id: Option<String>,
    pub content: String,
    pub occurred_at: Option<String>,
    /// Defaults to `message`. `activity` marks a user-authored record of
    /// something that already happened, so projections can keep it separate
    /// from ordinary chat without inventing semantics from the text.
    pub evidence_type: Option<String>,
    #[serde(default = "default_sensitivity")]
    pub sensitivity: String,
    #[serde(default)]
    pub audit: AuditContext,
}

/// One local Computer History segment. Raw events remain in the evidence layer;
/// semantic knowledge is created separately and cites the returned EvidenceRefs.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerHistoryEvidenceRequest {
    pub client_request_id: Option<String>,
    pub segment_id: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub storage_uri: String,
    pub content_hash: String,
    #[serde(default = "default_complete_coverage")]
    pub coverage_status: String,
    pub collector_version: Option<String>,
    #[serde(default = "default_json_object")]
    pub metadata: Value,
    pub events: Vec<Value>,
    #[serde(default)]
    pub audit: AuditContext,
}

/// Query the raw evidence layer independently from the derived knowledge graph.
/// `nodeIds` provides the reverse path from a distilled node to its source text.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceQueryRequest {
    #[serde(default)]
    pub exclude_history: bool,
    pub query: Option<String>,
    #[serde(default)]
    pub offset: u32,
    #[serde(default)]
    pub evidence_ref_ids: Vec<String>,
    #[serde(default)]
    pub source_types: Vec<String>,
    #[serde(default)]
    pub node_ids: Vec<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    #[serde(default)]
    pub include_retracted: bool,
    /// `recent` returns event-level recency. `source_balanced` samples the most
    /// informative events across source records so broad activity questions do
    /// not spend their whole budget on one ten-minute Computer History segment.
    #[serde(default = "default_evidence_sampling_mode")]
    pub sampling_mode: String,
    #[serde(default = "default_events_per_source")]
    pub events_per_source: u32,
    #[serde(default = "default_limit")]
    pub limit: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceReadRequest {
    #[serde(default)]
    pub exclude_history: bool,
    pub evidence_ref_id: String,
    #[serde(default)]
    pub offset: usize,
    pub length: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocateQueryPolicy {
    #[serde(default = "default_max_candidates")]
    pub max_candidates: u32,
    #[serde(default = "default_true")]
    pub allow_semantic_only: bool,
}

impl Default for LocateQueryPolicy {
    fn default() -> Self {
        Self {
            max_candidates: default_max_candidates(),
            allow_semantic_only: true,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocateEventRequest {
    pub client_request_id: Option<String>,
    pub event_node_id: String,
    #[serde(default, alias = "evidenceRefIds")]
    pub evidence_refs: Vec<String>,
    #[serde(default = "default_json_object")]
    pub project_context: Value,
    #[serde(default)]
    pub query_policy: LocateQueryPolicy,
    #[serde(default = "default_sensitivity_ceiling")]
    pub sensitivity_ceiling: String,
    pub audit: Option<AuditContext>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyLocationRequest {
    pub client_request_id: Option<String>,
    pub event_node_id: String,
    pub star_center_node_id: String,
    pub relation_type: String,
    #[serde(default, alias = "evidenceRefIds")]
    pub evidence_refs: Vec<String>,
    pub basis: String,
    pub proximity: Option<String>,
    pub strength: Option<String>,
    pub rationale: String,
    #[serde(default)]
    pub audit: AuditContext,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipRequest {
    pub client_request_id: Option<String>,
    pub from_node_id: String,
    pub to_node_id: String,
    pub relation_type: String,
    #[serde(default, alias = "evidenceRefIds")]
    pub evidence_refs: Vec<String>,
    pub basis: String,
    pub proximity: Option<String>,
    pub strength: Option<String>,
    pub rationale: String,
    #[serde(default = "default_json_object")]
    pub scope: Value,
    #[serde(default)]
    pub audit: AuditContext,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpistemicPolicy {
    #[serde(default = "default_true")]
    pub canonical_only: bool,
    #[serde(default)]
    pub include_observations: bool,
}

impl Default for EpistemicPolicy {
    fn default() -> Self {
        Self {
            canonical_only: true,
            include_observations: false,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SensitivityPolicy {
    #[serde(default = "default_sensitivity_ceiling")]
    pub ceiling: String,
}

impl Default for SensitivityPolicy {
    fn default() -> Self {
        Self {
            ceiling: default_sensitivity_ceiling(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBudget {
    #[serde(default = "default_max_nodes")]
    pub max_nodes: u32,
    #[serde(default = "default_max_edges")]
    pub max_edges: u32,
    #[serde(default = "default_max_depth")]
    pub max_depth: u32,
}

impl Default for ContextBudget {
    fn default() -> Self {
        Self {
            max_nodes: default_max_nodes(),
            max_edges: default_max_edges(),
            max_depth: default_max_depth(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileContextRequest {
    pub client_request_id: Option<String>,
    pub seed_node_ids: Vec<String>,
    #[serde(default)]
    pub needs: Vec<String>,
    #[serde(default = "default_json_object")]
    pub time_scope: Value,
    #[serde(default)]
    pub epistemic_policy: EpistemicPolicy,
    #[serde(default)]
    pub sensitivity_policy: SensitivityPolicy,
    #[serde(default)]
    pub budget: ContextBudget,
    pub audit: Option<AuditContext>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutcomeFeedback {
    pub action_id: String,
    pub outcome: String,
    pub observed_at: Option<String>,
    pub effect: Option<String>,
    pub claim_id: Option<String>,
    pub revised_statement: Option<String>,
    pub revised_scope: Option<Value>,
    #[serde(default, alias = "evidenceRefIds")]
    pub evidence_refs: Vec<String>,
    #[serde(default = "default_json_object")]
    pub payload: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyFeedbackRequest {
    pub client_request_id: Option<String>,
    pub feedback_type: String,
    pub target_node_id: String,
    #[serde(default, alias = "evidenceRefIds")]
    pub evidence_refs: Vec<String>,
    pub corrected_statement: Option<String>,
    pub corrected_scope: Option<Value>,
    pub outcome: Option<OutcomeFeedback>,
    #[serde(default)]
    pub audit: AuditContext,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveRevisionRequest {
    pub client_request_id: Option<String>,
    pub resolution: String,
    pub revised_statement: Option<String>,
    pub revised_scope: Option<Value>,
    #[serde(default)]
    pub audit: AuditContext,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyReviewRequest {
    pub client_request_id: Option<String>,
    pub period_start: Option<String>,
    pub period_end: Option<String>,
    #[serde(default = "default_sensitivity_ceiling")]
    pub sensitivity_ceiling: String,
    #[serde(default)]
    pub audit: AuditContext,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDocument {
    pub format: String,
    pub schema_version: String,
    pub exported_at: String,
    pub checksum: String,
    pub data: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareDangerousRequest {
    pub operation: String,
    pub snapshot: Option<ExportDocument>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDangerousRequest {
    pub token: String,
    pub confirmation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResponse {
    pub ok: bool,
    pub change_set_id: String,
    pub value: Value,
}
