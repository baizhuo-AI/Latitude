-- Runtime/audit extensions requested by the product contract.
ALTER TABLE nodes ADD COLUMN expected_outcome TEXT;
ALTER TABLE nodes ADD COLUMN review_at TEXT;
ALTER TABLE nodes ADD COLUMN outcome TEXT;

ALTER TABLE change_sets ADD COLUMN actor_id TEXT;
ALTER TABLE change_sets ADD COLUMN session_id TEXT;
ALTER TABLE change_sets ADD COLUMN turn_id TEXT;
ALTER TABLE change_sets ADD COLUMN tool_call_id TEXT;

ALTER TABLE change_operations ADD COLUMN inverse_json TEXT
  CHECK (inverse_json IS NULL OR json_valid(inverse_json));

ALTER TABLE evidence_refs ADD COLUMN retracted_at TEXT;

CREATE TABLE IF NOT EXISTS claim_revision_queue (
  id TEXT PRIMARY KEY,
  claim_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  outcome_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  effect TEXT NOT NULL CHECK (effect IN ('confirms', 'contracts', 'revises', 'unknown')),
  proposed_statement TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'dismissed')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_claim_revision_queue_status
  ON claim_revision_queue(status, created_at);

CREATE TABLE IF NOT EXISTS weekly_reviews (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  change_set_id TEXT NOT NULL REFERENCES change_sets(id) ON DELETE RESTRICT,
  receipt_key TEXT NOT NULL UNIQUE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  due_actions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(due_actions_json)),
  outcomes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(outcomes_json)),
  pending_revisions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(pending_revisions_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS data_reset_log (
  id TEXT PRIMARY KEY,
  reset_at TEXT NOT NULL,
  backup_path TEXT,
  receipt_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_ledger (
  request_key TEXT NOT NULL,
  route TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (request_key, route)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created_at
  ON idempotency_ledger(created_at);

CREATE TRIGGER IF NOT EXISTS node_fts_insert AFTER INSERT ON nodes
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO node_fts(node_id, label, statement)
  VALUES (new.id, new.label, COALESCE(new.statement, ''));
END;

CREATE TRIGGER IF NOT EXISTS node_fts_update AFTER UPDATE ON nodes
BEGIN
  DELETE FROM node_fts WHERE node_id = old.id;
  INSERT INTO node_fts(node_id, label, statement)
  SELECT new.id, new.label, COALESCE(new.statement, '')
  WHERE new.deleted_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS node_fts_delete AFTER DELETE ON nodes
BEGIN
  DELETE FROM node_fts WHERE node_id = old.id;
END;

INSERT INTO node_fts(node_id, label, statement)
SELECT n.id, n.label, COALESCE(n.statement, '')
FROM nodes n
WHERE n.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM node_fts f WHERE f.node_id = n.id);
