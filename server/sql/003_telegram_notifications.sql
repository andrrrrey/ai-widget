-- 003_telegram_notifications.sql — Telegram bot link codes and project binding

CREATE TABLE IF NOT EXISTS telegram_link_tokens (
  secret text PRIMARY KEY,
  chat_id text NOT NULL,
  username text NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  used_at timestamptz NULL
);

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS telegram_chat_id text NULL,
  ADD COLUMN IF NOT EXISTS telegram_connected_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS projects_telegram_idx ON projects(telegram_chat_id);
