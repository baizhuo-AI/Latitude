-- Faithful executable form of the P0 constellation contract. Transaction ownership
-- belongs to the Rust migrator, so this file deliberately contains no BEGIN/COMMIT.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_records (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN (
    'computer_history', 'chat', 'quick_note', 'checkin', 'schedule',
    'feed_feedback', 'audio', 'transcript', 'import', 'web_search'
  )),
  captured_at TEXT,
  ended_at TEXT,
  storage_uri TEXT,
  content_hash TEXT NOT NULL,
  privacy_level TEXT NOT NULL CHECK (privacy_level IN ('low', 'medium', 'high', 'highest')),
  storage_policy TEXT NOT NULL CHECK (storage_policy IN ('local_only', 'encrypted_sync', 'sync_allowed')),
  model_access TEXT NOT NULL CHECK (model_access IN (
    'forbidden', 'local_model_only', 'redacted_external_allowed', 'external_allowed'
  )),
  coverage_status TEXT NOT NULL CHECK (coverage_status IN ('complete', 'partial', 'unknown')),
  suppressed_count INTEGER CHECK (suppressed_count IS NULL OR suppressed_count >= 0),
  collector_version TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS evidence_refs (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT 'constellation.evidence_ref@0.1',
  source_record_id TEXT NOT NULL REFERENCES source_records(id) ON DELETE RESTRICT,
  actor_id TEXT,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('user', 'ai', 'system', 'third_party', 'unknown')),
  attribution_status TEXT NOT NULL CHECK (attribution_status IN ('verified', 'probable', 'unknown')),
  segment_id TEXT,
  raw_event_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(raw_event_ids_json)),
  start_time TEXT,
  end_time TEXT,
  transcript_span TEXT,
  resource_id TEXT,
  excerpt TEXT,
  content_hash TEXT NOT NULL,
  redaction_status TEXT NOT NULL CHECK (redaction_status IN ('none', 'redacted', 'pointer_only')),
  processor_name TEXT NOT NULL,
  processor_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_refs_source ON evidence_refs(source_record_id);
CREATE INDEX IF NOT EXISTS idx_evidence_refs_segment ON evidence_refs(segment_id);
CREATE INDEX IF NOT EXISTS idx_evidence_refs_time ON evidence_refs(start_time, end_time);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT 'constellation.node@0.1',
  kind TEXT NOT NULL CHECK (kind IN (
    'evidence_event', 'observation', 'claim', 'tension', 'decision',
    'experiment', 'action', 'outcome', 'topic', 'goal', 'project',
    'method', 'interest', 'value', 'boundary', 'resource', 'question', 'insight'
  )),
  layer TEXT NOT NULL CHECK (layer IN ('evidence', 'observation', 'canonical')),
  label TEXT NOT NULL,
  statement TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN (
    'proposed', 'active', 'shaping', 'parked', 'concluded', 'disputed',
    'scoped', 'unsupported', 'superseded', 'expired', 'rejected',
    'revoked', 'deleted'
  )),
  authority TEXT NOT NULL CHECK (authority IN (
    'source_verified', 'user_stated', 'user_confirmed', 'user_corrected',
    'system_recorded', 'system_inferred', 'imported_unverified'
  )),
  origin TEXT NOT NULL CHECK (origin IN ('sensor', 'user', 'model', 'system', 'import')),
  scope_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scope_json)),
  scope_key TEXT NOT NULL DEFAULT '*',
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('low', 'medium', 'high', 'highest')),
  valid_from TEXT,
  valid_to TEXT,
  recorded_at TEXT NOT NULL,
  superseded_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (
    (kind = 'evidence_event' AND layer = 'evidence') OR
    (kind = 'observation' AND layer = 'observation') OR
    (kind NOT IN ('evidence_event', 'observation') AND layer = 'canonical')
  )
);

CREATE INDEX IF NOT EXISTS idx_nodes_kind_status ON nodes(kind, status);
CREATE INDEX IF NOT EXISTS idx_nodes_layer_status ON nodes(layer, status);
CREATE INDEX IF NOT EXISTS idx_nodes_validity ON nodes(valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_nodes_sensitivity ON nodes(sensitivity);

CREATE TABLE IF NOT EXISTS node_evidence_links (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  evidence_ref_id TEXT NOT NULL REFERENCES evidence_refs(id) ON DELETE RESTRICT,
  role TEXT NOT NULL DEFAULT 'provenance' CHECK (role IN (
    'provenance', 'support', 'contradiction', 'correction', 'reason', 'origin'
  )),
  created_at TEXT NOT NULL,
  PRIMARY KEY (node_id, evidence_ref_id, role)
);

CREATE INDEX IF NOT EXISTS idx_node_evidence_ref ON node_evidence_links(evidence_ref_id);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT 'constellation.edge@0.1',
  from_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  to_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  family TEXT NOT NULL CHECK (family IN (
    'provenance', 'epistemic', 'behavioral', 'semantic', 'orbital', 'lineage'
  )),
  relation_type TEXT NOT NULL CHECK (relation_type IN (
    'derived_from', 'supports', 'contradicts', 'provides_evidence_for', 'tension_of', 'tests',
    'updates_confirms', 'updates_contracts', 'updates_revises', 'supersedes',
    'influences', 'implemented_as', 'resulted_in', 'serves', 'blocks',
    'about', 'part_of', 'used_for', 'exemplifies', 'conflicts_with',
    'bridges', 'orbits', 'evolved_from', 'split_from', 'merged_from'
  )),
  direction TEXT NOT NULL CHECK (direction IN ('directed', 'symmetric')),
  proximity TEXT NOT NULL CHECK (proximity IN (
    'direct', 'near', 'middle', 'far', 'boundary', 'outside', 'unknown'
  )),
  strength TEXT NOT NULL CHECK (strength IN ('weak', 'medium', 'strong', 'not_applicable')),
  basis TEXT NOT NULL CHECK (basis IN (
    'direct_observation', 'explicit_statement', 'user_confirmation',
    'deterministic_context', 'contextual', 'behavioral_inference',
    'semantic_only', 'derived_metric'
  )),
  authority TEXT NOT NULL CHECK (authority IN (
    'source_verified', 'user_stated', 'user_confirmed', 'user_corrected',
    'system_recorded', 'system_inferred', 'imported_unverified'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'proposed', 'active', 'rejected', 'disputed', 'superseded', 'expired', 'deleted'
  )),
  rationale TEXT,
  scope_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scope_json)),
  scope_key TEXT NOT NULL DEFAULT '*',
  valid_from TEXT,
  valid_to TEXT,
  recorded_at TEXT NOT NULL,
  superseded_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (from_node_id <> to_node_id)
);

CREATE INDEX IF NOT EXISTS idx_edges_from_type ON edges(from_node_id, relation_type, status);
CREATE INDEX IF NOT EXISTS idx_edges_to_type ON edges(to_node_id, relation_type, status);
CREATE INDEX IF NOT EXISTS idx_edges_family_status ON edges(family, status);
CREATE INDEX IF NOT EXISTS idx_edges_proximity ON edges(proximity, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_edge_scope
  ON edges(from_node_id, to_node_id, relation_type, scope_key)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS edge_evidence_links (
  edge_id TEXT NOT NULL REFERENCES edges(id) ON DELETE RESTRICT,
  evidence_ref_id TEXT NOT NULL REFERENCES evidence_refs(id) ON DELETE RESTRICT,
  role TEXT NOT NULL DEFAULT 'reason' CHECK (role IN (
    'reason', 'support', 'contradiction', 'correction', 'origin'
  )),
  created_at TEXT NOT NULL,
  PRIMARY KEY (edge_id, evidence_ref_id, role)
);

CREATE INDEX IF NOT EXISTS idx_edge_evidence_ref ON edge_evidence_links(evidence_ref_id);

CREATE TABLE IF NOT EXISTS star_states (
  center_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  schema_version TEXT NOT NULL DEFAULT 'constellation.star_state@0.1',
  role TEXT NOT NULL CHECK (role IN (
    'proto_star', 'emerging_star', 'active_star', 'dormant_star', 'historical_star'
  )),
  importance TEXT NOT NULL CHECK (importance IN ('low', 'medium', 'high')),
  importance_authority TEXT NOT NULL CHECK (importance_authority IN ('user_confirmed', 'system_inferred')),
  salience TEXT NOT NULL CHECK (salience IN ('quiet', 'active', 'hot')),
  organizing_power TEXT NOT NULL CHECK (organizing_power IN ('local', 'connecting', 'anchor')),
  freshness TEXT NOT NULL CHECK (freshness IN ('current', 'aging', 'stale')),
  mass TEXT NOT NULL CHECK (mass IN ('sparse', 'supported', 'dense')),
  radius TEXT NOT NULL CHECK (radius IN ('narrow', 'medium', 'broad')),
  aura_version INTEGER NOT NULL DEFAULT 0 CHECK (aura_version >= 0),
  state_status TEXT NOT NULL CHECK (state_status IN ('proposed', 'active', 'superseded', 'archived')),
  recompute_required INTEGER NOT NULL DEFAULT 0 CHECK (recompute_required IN (0, 1)),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  recorded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (center_node_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_current_star_state
  ON star_states(center_node_id)
  WHERE state_status = 'active';

CREATE TABLE IF NOT EXISTS star_state_evidence_links (
  center_node_id TEXT NOT NULL,
  star_version INTEGER NOT NULL,
  evidence_ref_id TEXT NOT NULL REFERENCES evidence_refs(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (center_node_id, star_version, evidence_ref_id),
  FOREIGN KEY (center_node_id, star_version)
    REFERENCES star_states(center_node_id, version) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS star_auras (
  center_node_id TEXT NOT NULL,
  star_version INTEGER NOT NULL,
  aura_version INTEGER NOT NULL CHECK (aura_version >= 1),
  core_summary TEXT NOT NULL,
  near_summary TEXT,
  middle_summary TEXT,
  boundary_summary TEXT,
  current_shift TEXT,
  representative_nodes_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(representative_nodes_json)),
  generated_by TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'superseded')),
  PRIMARY KEY (center_node_id, star_version, aura_version),
  FOREIGN KEY (center_node_id, star_version)
    REFERENCES star_states(center_node_id, version) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS change_sets (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL DEFAULT 'constellation.change_set@0.1',
  reason_type TEXT NOT NULL CHECK (reason_type IN (
    'extraction', 'user_confirmation', 'user_correction', 'action_outcome',
    'star_maintenance', 'migration', 'deletion'
  )),
  proposer_actor TEXT NOT NULL CHECK (proposer_actor IN ('user', 'model', 'system', 'importer')),
  proposer_version TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'drafted', 'proposed', 'approved', 'applied', 'rejected', 'rolled_back', 'failed'
  )),
  authorization_mode TEXT NOT NULL CHECK (authorization_mode IN (
    'automatic', 'preauthorized', 'explicit_user', 'direct_user_correction'
  )),
  granted_by TEXT,
  granted_at TEXT,
  rationale TEXT NOT NULL,
  reversible INTEGER NOT NULL CHECK (reversible IN (0, 1)),
  inverse_change_set_id TEXT REFERENCES change_sets(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_change_sets_status ON change_sets(status, created_at);

CREATE TABLE IF NOT EXISTS change_operations (
  change_set_id TEXT NOT NULL REFERENCES change_sets(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  operation_type TEXT NOT NULL CHECK (operation_type IN (
    'create_source', 'create_evidence', 'retract_evidence', 'link_node_evidence',
    'create_node', 'update_node', 'close_node', 'create_edge', 'update_edge',
    'close_edge', 'upsert_star_state', 'create_aura_version', 'delete_source',
    'mark_star_recompute_required', 'enqueue_claim_revision', 'resolve_claim_revision',
    'create_weekly_review', 'remove_weekly_review', 'restore_database', 'delete_all'
  )),
  target_ref TEXT,
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  PRIMARY KEY (change_set_id, sequence)
);

CREATE TABLE IF NOT EXISTS change_evidence_links (
  change_set_id TEXT NOT NULL REFERENCES change_sets(id) ON DELETE RESTRICT,
  evidence_ref_id TEXT NOT NULL REFERENCES evidence_refs(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (change_set_id, evidence_ref_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
  node_id UNINDEXED,
  label,
  statement,
  tokenize = 'unicode61'
);

CREATE VIEW IF NOT EXISTS active_nodes AS
SELECT * FROM nodes
WHERE status IN ('active', 'scoped', 'disputed')
  AND deleted_at IS NULL
  AND (valid_to IS NULL OR valid_to > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE VIEW IF NOT EXISTS active_edges AS
SELECT * FROM edges
WHERE status IN ('active', 'disputed')
  AND (valid_to IS NULL OR valid_to > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE VIEW IF NOT EXISTS current_star_states AS
SELECT ss.* FROM star_states ss
WHERE ss.state_status = 'active'
  AND (ss.valid_to IS NULL OR ss.valid_to > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE VIEW IF NOT EXISTS star_catalog AS
SELECT
  n.id AS star_id, n.kind, n.label, n.statement, n.sensitivity,
  ss.role, ss.importance, ss.salience, ss.organizing_power,
  ss.freshness, ss.mass, ss.radius, ss.aura_version
FROM current_star_states ss
JOIN nodes n ON n.id = ss.center_node_id
WHERE n.deleted_at IS NULL;
