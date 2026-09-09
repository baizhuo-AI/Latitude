CREATE TABLE history_settings (
  id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}', status_json TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO history_settings(id) VALUES(1);
CREATE TABLE history_items (
  id TEXT PRIMARY KEY, evidence_id TEXT NOT NULL, source_id TEXT NOT NULL,
  provider TEXT NOT NULL, observed_at TEXT NOT NULL, app TEXT NOT NULL,
  bundle_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT,
  coverage TEXT NOT NULL, group_id TEXT NOT NULL, expired INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX history_time ON history_items(observed_at);
CREATE INDEX history_group ON history_items(group_id);
CREATE TABLE history_summaries (
  id TEXT PRIMARY KEY, revision INTEGER NOT NULL, content_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE history_deletions (
  id TEXT PRIMARY KEY, from_time TEXT NOT NULL, to_time TEXT NOT NULL,
  app TEXT, group_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE history_memories (
  id TEXT PRIMARY KEY, statement TEXT NOT NULL, groups_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'observation', updated_at TEXT NOT NULL
);
CREATE TABLE history_curation (group_id TEXT PRIMARY KEY, updated_at TEXT NOT NULL);
