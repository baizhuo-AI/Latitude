-- P0 semantic closure additions. Transaction ownership belongs to the Rust migrator.

ALTER TABLE claim_revision_queue RENAME TO claim_revision_queue_v2;

CREATE TABLE claim_revision_queue (
  id TEXT PRIMARY KEY,
  claim_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  outcome_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  effect TEXT NOT NULL CHECK (effect IN ('confirms', 'contracts', 'revises', 'refutes', 'unknown')),
  proposed_statement TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'dismissed')),
  resolution_json TEXT CHECK (resolution_json IS NULL OR json_valid(resolution_json)),
  resolution_change_set_id TEXT REFERENCES change_sets(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

INSERT INTO claim_revision_queue(
  id, claim_node_id, outcome_node_id, effect, proposed_statement, status,
  resolution_json, resolution_change_set_id, created_at, resolved_at
)
SELECT
  id, claim_node_id, outcome_node_id, effect, proposed_statement, status,
  NULL, NULL, created_at, resolved_at
FROM claim_revision_queue_v2;

DROP TABLE claim_revision_queue_v2;

CREATE INDEX idx_claim_revision_queue_status
  ON claim_revision_queue(status, created_at);

ALTER TABLE weekly_reviews ADD COLUMN changed_claims_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(changed_claims_json));
ALTER TABLE weekly_reviews ADD COLUMN contradictions_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(contradictions_json));
ALTER TABLE weekly_reviews ADD COLUMN no_evidence_actions_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(no_evidence_actions_json));
