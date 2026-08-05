-- PayGate — adiciona log persistente de erros de servidor.

CREATE TABLE IF NOT EXISTS "error_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source" text NOT NULL,
  "code" text,
  "message" text NOT NULL,
  "details" jsonb,
  "stack" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "error_logs_created_at_idx" ON "error_logs" ("created_at");
CREATE INDEX IF NOT EXISTS "error_logs_source_idx" ON "error_logs" ("source");
