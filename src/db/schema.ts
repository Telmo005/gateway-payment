import {
  pgTable,
  uuid,
  text,
  numeric,
  integer,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index
} from 'drizzle-orm/pg-core';

// ============================================================================
// PayGate — orquestrador central de pagamentos PaySuite (multi-tenant).
//
// Uma conta PaySuite = 1 token de API + 1 webhook secret + 1 webhook URL.
// Este serviço é o dono EXCLUSIVO dessa relação. Cada app (Invoice Hub,
// bShare, Duelo, ...) é um tenant registado na tabela `apps` e nunca vê os
// segredos do PaySuite — só o seu próprio `callback_secret`.
// ============================================================================

// Cada app cliente registado. Segredos do app vivem aqui, isolados por linha.
export const apps = pgTable(
  'apps',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Identificador legível e estável, ex.: 'invoice-hub', 'bshare', 'duelo'.
    slug: text('slug').notNull(),
    name: text('name').notNull(),

    // Autenticação app -> gateway. A chave em claro é mostrada UMA vez ao
    // registar; guardamos só o hash SHA-256. `apiKeyPrefix` serve para
    // identificar/rodar chaves em logs sem expor o segredo.
    apiKeyHash: text('api_key_hash').notNull(),
    apiKeyPrefix: text('api_key_prefix').notNull(),

    // Fan-out gateway -> app. O gateway assina o corpo do webhook reenviado
    // com este segredo (HMAC-SHA256). Só este app e o gateway o conhecem.
    callbackUrl: text('callback_url').notNull(),
    callbackSecret: text('callback_secret').notNull(),

    // Prefixo aplicado às referências enviadas ao PaySuite, ex.: 'IHP', 'DUE'.
    // Ajuda a identificar a origem no dashboard do PaySuite.
    referencePrefix: text('reference_prefix').notNull(),

    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex('apps_slug_uq').on(t.slug),
    uniqueIndex('apps_api_key_hash_uq').on(t.apiKeyHash)
  ]
);

// Registo canónico de cada cobrança, de todos os apps. Este é o ledger.
export const transactions = pgTable(
  'transactions',
  {
    // Este id é o `gateway_payment_id` devolvido ao app.
    id: uuid('id').defaultRandom().primaryKey(),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id),

    // A referência que o PRÓPRIO app enviou (a sua chave de idempotência).
    appReference: text('app_reference').notNull(),

    // Referência gerada pelo gateway e enviada ao PaySuite (única global).
    reference: text('reference').notNull(),

    // Id do pagamento no PaySuite. Nulo entre criar a linha e o PaySuite
    // responder (não deveria acontecer, mas a coluna tolera-o).
    providerPaymentId: text('provider_payment_id'),

    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('MZN'),
    method: text('method').notNull(), // 'mpesa' | 'emola' | 'credit_card'
    description: text('description'),

    // 'pending' | 'success' | 'failed'
    status: text('status').notNull().default('pending'),

    returnUrl: text('return_url'),
    // Metadados leves do app (ecoados de volta no fan-out). Payloads pesados
    // (ex.: HTML de documento) devem ficar no BD do próprio app, não aqui.
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    providerRaw: jsonb('provider_raw').$type<Record<string, unknown>>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true })
  },
  (t) => [
    // Idempotência da criação de cobrança: o mesmo app não cria duas
    // transacções com a mesma referência.
    uniqueIndex('tx_app_reference_uq').on(t.appId, t.appReference),
    uniqueIndex('tx_provider_payment_id_uq').on(t.providerPaymentId),
    index('tx_status_idx').on(t.status),
    index('tx_app_idx').on(t.appId)
  ]
);

// Cada webhook cru recebido do PaySuite. `requestId` é a chave de
// idempotência — o PaySuite reentrega até 5x, e não podemos processar 2x.
export const providerEvents = pgTable(
  'provider_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    requestId: text('request_id'),
    eventType: text('event_type').notNull(),
    providerPaymentId: text('provider_payment_id'),
    transactionId: uuid('transaction_id').references(() => transactions.id),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex('provider_events_request_id_uq').on(t.requestId)]
);

// Fila de reenvio do gateway para o /callback de cada app. Um webhook do app
// que falhe é reprocessado por um cron com backoff.
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id),
    eventType: text('event_type').notNull(), // 'payment.success' | 'payment.failed'
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),

    // 'pending' | 'delivered' | 'failed'
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    lastStatusCode: integer('last_status_code'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true })
  },
  (t) => [
    index('deliveries_pending_idx').on(t.status, t.nextRetryAt),
    index('deliveries_tx_idx').on(t.transactionId)
  ]
);

// Log persistente de erros de servidor (não-4xx-de-cliente). Best-effort —
// nunca deve derrubar o request que o originou (ver src/lib/errorLog.ts).
export const errorLogs = pgTable(
  'error_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    source: text('source').notNull(), // ex.: 'webhooks.paysuite', 'charges.create'
    code: text('code'),
    message: text('message').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>(),
    stack: text('stack'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index('error_logs_created_at_idx').on(t.createdAt), index('error_logs_source_idx').on(t.source)]
);

export type App = typeof apps.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type ErrorLog = typeof errorLogs.$inferSelect;
