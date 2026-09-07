import { NextResponse } from 'next/server';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions, providerEvents } from '@/db/schema';
import { verifyWebhookSignature, parseWebhookEvent } from '@/lib/debitopay';
import { enqueueAndDeliver } from '@/lib/fanout';
import { logError } from '@/lib/errorLog';

export const runtime = 'nodejs';

// ============================================================================
// O ÚNICO webhook da Debito Pay. Todos os apps partilham esta URL — confirma
// os métodos assíncronos (emola, mkesh, cartão, payfast); m-Pesa já confirma
// síncrono na resposta do POST /v1/charges e não passa por aqui.
//   Debito Pay -> aqui -> (verifica HMAC) -> encontra a transacção -> fan-out
//
// Segurança: sem sessão de utilizador; a confiança vem inteiramente da
// verificação HMAC-SHA256 (header `x-webhook-signature`) com o webhook
// secret. Responde sempre 200 a eventos válidos (mesmo sem correspondência),
// para a Debito Pay não reentregar eternamente; 401 só para assinatura
// inválida.
// ============================================================================

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-webhook-signature');

  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: 'Assinatura inválida' }, { status: 401 });
  }

  let event;
  try {
    event = parseWebhookEvent(rawBody);
  } catch {
    return NextResponse.json({ error: 'Payload inválido' }, { status: 400 });
  }

  // Idempotência: a doc promete retentativas com backoff até 24h, sem expor
  // um id de evento — `requestId` aqui é sha256(corpo cru) (ver debitopay.ts).
  let dedupInserted = false;
  const inserted = await db
    .insert(providerEvents)
    .values({
      requestId: event.requestId,
      eventType: event.type,
      providerPaymentId: event.providerPaymentId,
      raw: event.raw
    })
    .onConflictDoNothing({ target: providerEvents.requestId })
    .returning();

  if (inserted.length === 0) {
    return NextResponse.json({ received: true, duplicate: true });
  }
  dedupInserted = true;

  try {
    const [tx] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.providerPaymentId, event.providerPaymentId))
      .limit(1);

    if (!tx) {
      // Sem correspondência — ack para parar reentregas.
      return NextResponse.json({ received: true, matched: false });
    }

    // Junta ao providerRaw guardado na criação (que tem o `checkout_url` para
    // cartão/payfast) em vez de o substituir — o corpo do webhook não repete
    // esse campo, e perdê-lo quebraria o GET /v1/charges/{id} depois de confirmado.
    const mergedRaw = { ...(tx.providerRaw as Record<string, unknown> | null), ...event.raw };

    if (event.type === 'payment.success') {
      // Transita só se ainda não estava 'success' — estado terminal.
      const updated = await db
        .update(transactions)
        .set({ status: 'success', paidAt: new Date(), updatedAt: new Date(), providerRaw: mergedRaw })
        .where(and(eq(transactions.id, tx.id), ne(transactions.status, 'success')))
        .returning();

      if (updated[0]) {
        await enqueueAndDeliver(updated[0], 'payment.success');
      }
    } else if (event.type === 'payment.failed') {
      // Só marca falhado se ainda 'pending' — nunca sobrepõe um sucesso já dado.
      const updated = await db
        .update(transactions)
        .set({ status: 'failed', updatedAt: new Date(), providerRaw: mergedRaw })
        .where(and(eq(transactions.id, tx.id), eq(transactions.status, 'pending')))
        .returning();

      if (updated[0]) {
        await enqueueAndDeliver(updated[0], 'payment.failed');
      }
    }
    // payment.refunded / payment.chargeback: apenas registados em
    // provider_events (acima) para auditoria — sem fluxo de reembolso/
    // chargeback modelado no ledger ainda. Ack normalmente.

    return NextResponse.json({ received: true });
  } catch (err) {
    await logError('webhooks.debitopay', err, {
      requestId: event.requestId,
      providerPaymentId: event.providerPaymentId,
      eventType: event.type
    });

    if (dedupInserted) {
      await db
        .delete(providerEvents)
        .where(eq(providerEvents.requestId, event.requestId))
        .catch(() => {});
    }

    // 500 propositado: faz a Debito Pay reentregar este evento mais tarde.
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 });
  }
}
