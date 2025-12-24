-- 004_project_telegram_chats.sql — multiple telegram chats per project

CREATE TABLE IF NOT EXISTS project_telegram_chats (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chat_id text NOT NULL,
  chat_type text NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, chat_id)
);

CREATE INDEX IF NOT EXISTS project_telegram_chats_chat_idx ON project_telegram_chats(chat_id);

ALTER TABLE telegram_link_tokens
  ADD COLUMN IF NOT EXISTS chat_type text NULL;
