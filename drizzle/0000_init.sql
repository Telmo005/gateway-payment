-- PayGate — schema inicial. Podes correr isto diretamente no SQL Editor do
-- Supabase, ou usar `npm run db:push` (drizzle-kit) que gera o equivalente.

CREATE TABLE IF NOT EXISTS "apps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "api_key_hash" text NOT NULL,
  "api_key_prefix" text NOT NULL,
  "callback_url" text NOT NULL,
  "callback_secret" text NOT NULL,
  "reference_prefix" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "apps_slug_uq" ON "apps" ("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "apps_api_key_hash_uq" ON "apps" ("api_key_hash");

CREATE TABLE IF NOT EXISTS "transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "app_id" uuid NOT NULL REFERENCES "apps"("id"),
  "app_reference" text NOT NULL,
  "reference" text NOT NULL,
  "provider_payment_id" text,
  "amount" numeric(12,2) NOT NULL,
  "currency" text NOT NULL DEFAULT 'MZN',
  "method" text NOT NULL,
  "description" text,
  "status" text NOT NULL DEFAULT 'pending',
  "return_url" text,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "provider_raw" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "paid_at" timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS "tx_app_reference_uq" ON "transactions" ("app_id", "app_reference");
CREATE UNIQUE INDEX IF NOT EXISTS "tx_provider_payment_id_uq" ON "transactions" ("provider_payment_id");
CREATE INDEX IF NOT EXISTS "tx_status_idx" ON "transactions" ("status");
CREATE INDEX IF NOT EXISTS "tx_app_idx" ON "transactions" ("app_id");

CREATE TABLE IF NOT EXISTS "provider_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "request_id" text,
  "event_type" text NOT NULL,
  "provider_payment_id" text,
  "transaction_id" uuid REFERENCES "transactions"("id"),
  "raw" jsonb NOT NULL,
  "received_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "provider_events_request_id_uq" ON "provider_events" ("request_id");

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "transaction_id" uuid NOT NULL REFERENCES "transactions"("id"),
  "app_id" uuid NOT NULL REFERENCES "apps"("id"),
  "event_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 8,
  "next_retry_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "last_status_code" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "delivered_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "deliveries_pending_idx" ON "webhook_deliveries" ("status", "next_retry_at");
CREATE INDEX IF NOT EXISTS "deliveries_tx_idx" ON "webhook_deliveries" ("transaction_id");
