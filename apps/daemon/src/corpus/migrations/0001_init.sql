CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body_summary TEXT NOT NULL DEFAULT '',
  entities TEXT NOT NULL DEFAULT '[]',
  authors TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  url TEXT,
  acl TEXT NOT NULL DEFAULT '{}',
  provenance TEXT NOT NULL DEFAULT 'untrusted'
);

CREATE INDEX IF NOT EXISTS idx_docs_source ON docs(source);
CREATE INDEX IF NOT EXISTS idx_docs_updated_at ON docs(updated_at);

CREATE TABLE IF NOT EXISTS doc_chunks (
  chunk_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  domain TEXT NOT NULL CHECK (domain IN ('text', 'code')),
  text TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_doc_chunks_doc_id ON doc_chunks(doc_id);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_doc_chunks USING fts5(
  chunk_id UNINDEXED,
  doc_id UNINDEXED,
  title,
  text,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS cursors (
  source TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  cursor_token TEXT,
  last_full_sync_at INTEGER,
  etag TEXT,
  PRIMARY KEY (source, scope_id)
);

CREATE TABLE IF NOT EXISTS meetings (
  meeting_id TEXT PRIMARY KEY,
  title TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS meeting_utterances (
  utterance_id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  stream_role TEXT NOT NULL,
  text TEXT NOT NULL,
  speaker TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_meeting_utterances_meeting_id ON meeting_utterances(meeting_id);

CREATE TABLE IF NOT EXISTS gaps (
  gap_id TEXT PRIMARY KEY,
  meeting_id TEXT REFERENCES meetings(meeting_id) ON DELETE SET NULL,
  utterance_id TEXT,
  verbatim_question TEXT NOT NULL,
  context_window TEXT NOT NULL DEFAULT '',
  sources_searched TEXT NOT NULL DEFAULT '[]',
  intent TEXT,
  entities TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  dismissed INTEGER NOT NULL DEFAULT 0,
  converted_to TEXT
);

CREATE INDEX IF NOT EXISTS idx_gaps_meeting_id ON gaps(meeting_id);

CREATE TABLE IF NOT EXISTS consent (
  provider_id TEXT PRIMARY KEY,
  granted_at INTEGER NOT NULL,
  granted_by TEXT NOT NULL DEFAULT 'user',
  scope TEXT NOT NULL DEFAULT 'all'
);

CREATE TABLE IF NOT EXISTS telemetry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_telemetry_events_ts ON telemetry_events(ts);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_event_type ON telemetry_events(event_type);
