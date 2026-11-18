CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  preset TEXT,
  display_name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  auth_scheme TEXT NOT NULL,
  auth_header TEXT,
  extra_headers_json TEXT NOT NULL DEFAULT '{}',
  model_list_path TEXT NOT NULL DEFAULT '/models',
  model_list_query_json TEXT NOT NULL DEFAULT '{}',
  allow_insecure_http INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE models_cache (
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  info_json TEXT NOT NULL,
  manual INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model_id)
);

CREATE TABLE model_overrides (
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  PRIMARY KEY (provider_id, model_id)
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  model_id TEXT NOT NULL,
  system_prompt TEXT,
  params_json TEXT NOT NULL DEFAULT '{}',
  extensions_json TEXT NOT NULL DEFAULT '{}',
  active_leaf_id TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX conversations_updated ON conversations(updated_at DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content_json TEXT NOT NULL,          -- array of parts: {type:'text'|'image', ...}
  provider_id TEXT,
  model_id TEXT,
  reasoning_text TEXT,
  finish_reason TEXT,
  usage_json TEXT,
  request_id TEXT,
  error_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_conv ON messages(conversation_id, created_at);
CREATE INDEX messages_parent ON messages(parent_id);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL
);
CREATE INDEX attachments_sha ON attachments(sha256);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  provider_id TEXT,
  model_id TEXT,
  status INTEGER,
  request_id TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  latency_ms INTEGER,
  error_code TEXT
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  body,
  message_id UNINDEXED,
  conversation_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
