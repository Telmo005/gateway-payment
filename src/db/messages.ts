import { pgTable, pgEnum, uuid, text, timestamp } from 'drizzle-orm/pg-core';

// ============================================================================
// Tabela `messages` — NÃO pertence a este projeto. É gerida pelo celular-
// gateway Android (SMS real + notificações push), que já vive no mesmo
// Supabase. Este ficheiro só espelha o schema existente para usarmos o `db`
// já partilhado (src/db/client.ts) na leitura/escrita.
//
// Propositadamente FORA de drizzle.config.ts (que só aponta para
// ./src/db/schema.ts) — `db:generate`/`db:push` nunca devem tocar aqui.
// Qualquer alteração ao schema real é feita do lado do celular-gateway.
// ============================================================================

export const messageStatus = pgEnum('message_status', [
  'PENDING',
  'CLAIMED',
  'SENT',
  'DELIVERED',
  'FAILED',
  'SEEN'
]);

export const messages = pgTable('messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  sourceApp: text('source_app'),
  toNumber: text('to_number'),
  body: text('body').notNull(),
  status: messageStatus('status').notNull().default('PENDING'),
  claimedBy: uuid('claimed_by'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  failedAt: timestamp('failed_at', { withTimezone: true }),
  error: text('error'),
  channel: text('channel').notNull().default('sms'),
  title: text('title'),
  seenAt: timestamp('seen_at', { withTimezone: true })
});

export type Message = typeof messages.$inferSelect;
