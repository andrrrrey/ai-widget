-- 001_init.sql — multi-tenant schema

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  assistant_id text NOT NULL,
  openai_api_key text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  allowed_origins text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chats (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('assistant','human')) DEFAULT 'assistant',
  status text NOT NULL CHECK (status IN ('open','closed')) DEFAULT 'open',
  visitor_id text NULL,
  last_seen_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chats_project_updated_idx ON chats(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant','human')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_chat_created_idx ON messages(chat_id, created_at ASC);
