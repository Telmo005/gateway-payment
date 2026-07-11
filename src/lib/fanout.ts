import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { apps, webhookDeliveries, transactions, type Transaction, type App } from '@/db/schema';
import { hmacHex } from './crypto';

// ============================================================================
// Fan-out: o gateway reenvia o evento de pagamento para o /callback do app,
// assinado com o `callback_secret` DESSE app. Cada app verifica com o seu
// próprio segredo — o webhook secret do PaySuite nunca sai do gateway.
//
// Estratégia sem Redis/fila externa (fiel ao "começar simples mas correto"):
//  - Tentativa imediata na hora do webhook.
//  - Em falha, a linha `webhook_deliveries` fica com next_retry_at futuro e
//    um cron (/api/internal/deliveries/retry) reprocessa com backoff.
// ============================================================================

const DELIVERY_TIMEOUT_MS = 8000;

// Envelope que o app recebe. `reference` é a referência do PRÓPRIO app, para
// ele reconciliar com o seu registo local sem conhecer ids do PaySuite.
function buildPayload(tx: Transaction, eventType: 'payment.success' | 'payment.failed') {
  return {
    type: eventType,
    created_at: new Date().toISOString(),
    data: {
      gateway_payment_id: tx.id,
      reference: tx.appReference,
      amount: Number(tx.amount),
      currency: tx.currency,
      method: tx.method,
      status: tx.status, // 'success' | 'failed'
      paid_at: tx.paidAt ? tx.paidAt.toISOString() : null,
      metadata: tx.metadata ?? {}
    }
  };
}

// Backoff exponencial com teto: 30s, 1m, 2m, 4m, ... até ~1h.
function nextRetryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** (attempts - 1), 3_600_000);
}

// Cria a linha de entrega e tenta entregar já. Chamada a partir do webhook.
export async function enqueueAndDeliver(
  tx: Transaction,
  eventType: 'payment.success' | 'payment.failed'
): Promise<void> {
  const payload = buildPayload(tx, eventType);

  const [delivery] = await db
    .insert(webhookDeliveries)
    .values({
      transactionId: tx.id,
      appId: tx.appId,
      eventType,
      payload,
      status: 'pending'
    })
    .returning();

  await attemptDelivery(delivery.id);
}

// Tenta entregar UMA linha de webhook_deliveries. Idempotente e segura para o
// cron chamar em paralelo com a tentativa imediata (marca 'delivered' só uma
// vez; um POST duplicado ao app é aceitável — o app deduplica por
// gateway_payment_id).
export async function attemptDelivery(deliveryId: string): Promise<void> {
  const [delivery] = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, deliveryId))
    .limit(1);

  if (!delivery || delivery.status === 'delivered') return;

  const [app] = await db.select().from(apps).where(eq(apps.id, delivery.appId)).limit(1);
  if (!app) return;

  const attempts = delivery.attempts + 1;
  const rawBody = JSON.stringify(delivery.payload);
  const signature = hmacHex(app.callbackSecret, rawBody);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    const res = await fetch(app.callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Paygate-Signature': signature,
        'X-Paygate-Delivery-Id': delivery.id,
        'X-Paygate-Event': delivery.eventType
      },
      body: rawBody,
      signal: controller.signal
    }).finally(() => clearTimeout(timer));

    if (res.ok) {
      await db
        .update(webhookDeliveries)
        .set({
          status: 'delivered',
          attempts,
          lastStatusCode: res.status,
          deliveredAt: new Date()
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      return;
    }

    await scheduleRetry(delivery.id, attempts, delivery.maxAttempts, res.status, `HTTP ${res.status}`);
  } catch (err) {
    await scheduleRetry(
      delivery.id,
      attempts,
      delivery.maxAttempts,
      null,
      err instanceof Error ? err.message : String(err)
    );
  }
}

async function scheduleRetry(
  deliveryId: string,
  attempts: number,
  maxAttempts: number,
  statusCode: number | null,
  error: string
): Promise<void> {
  const exhausted = attempts >= maxAttempts;
  await db
    .update(webhookDeliveries)
    .set({
      status: exhausted ? 'failed' : 'pending',
      attempts,
      lastStatusCode: statusCode ?? undefined,
      lastError: error,
      nextRetryAt: new Date(Date.now() + nextRetryDelayMs(attempts))
    })
    .where(eq(webhookDeliveries.id, deliveryId));
}
