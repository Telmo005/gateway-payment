import { NextResponse } from 'next/server';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions, providerEvents } from '@/db/schema';
import { verifyWebhookSignature, parseWebhookEvent } from '@/lib/paysuite';
import { enqueueAndDeliver } from '@/lib/fanout';
import { logError } from '@/lib/errorLog';

export const runtime = 'nodejs';

// ============================================================================
// LEGADO/DORMENTE desde a migração para MozPayment (2026-08, conta PaySuite
// bloqueada). MozPayment é síncrono — não gera webhooks. Isto só continua
// aqui para eventuais transacções PaySuite anteriores à migração ainda
// 'pending'; nenhuma cobrança nova passa por este caminho. Ver README.md.
//
// O ÚNICO webhook do PaySuite. Todos os apps partilham esta URL.
//   PaySuite -> aqui -> (verifica) -> encontra o app dono -> fan-out ao app.
//
// Segurança: sem sessão de utilizador; a confiança vem inteiramente da
// verificação HMAC com o webhook secret do PaySuite. Responde sempre 200 a
// eventos válidos (mesmo sem correspondência) para o PaySuite não reentregar
// eternamente; 401 só para assinatura inválida.
// ============================================================================

export async function POST(request: Request) {
  const rawBody = await request.text();

  // A doc do PaySuite diz 'X-Webhook-Signature', mas produção envia
  // 'X-Signature' (confirmado no Invoice Hub). Toleramos ambos.
  const signature = request.headers.get('x-signature') || request.headers.get('x-webhook-signature');

  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: 'Assinatura inválida' }, { status: 401 });
  }

  let event;
  try {
    event = parseWebhookEvent(rawBody);
  } catch {
    return NextResponse.json({ error: 'Payload inválido' }, { status: 400 });
  }

  // Idempotência: o PaySuite reentrega até 5x. O insert em provider_events
  // com request_id único falha (onConflictDoNothing devolve vazio) se já
  // processámos este evento — nesse caso, ack e sai.
  //
  // O insert de dedup e o processamento abaixo NÃO são atómicos entre si.
  // Se o processamento falhar depois do dedup já ter sido gravado, uma
  // reentrega do PaySuite seria descartada como "duplicate" SEM nunca ter
  // sido processada de verdade — por isso, em caso de erro, desfazemos o
  // dedup explicitamente para permitir reprocessar na próxima reentrega.
  let dedupInserted = false;
  if (event.requestId) {
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
  }

  try {
    // Encontra a transacção (e portanto o app dono) pelo id do PaySuite.
    const [tx] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.providerPaymentId, event.providerPaymentId))
      .limit(1);

    if (!tx) {
      // Sem correspondência — ack para parar reentregas.
      return NextResponse.json({ received: true, matched: false });
    }

    if (event.type === 'payment.success') {
      // UPDATE condicional no próprio WHERE (não numa leitura prévia): só
      // transita para 'success' se ainda NÃO estava 'success'. Aceita vir de
      // 'pending' OU 'failed' (o PaySuite pode mandar um failed prematuro antes
      // do success real). Se `returning()` vier vazio, outro webhook concorrente
      // já processou — não fazemos fan-out duplicado. 'success' é terminal.
      const updated = await db
        .update(transactions)
        .set({ status: 'success', paidAt: new Date(), updatedAt: new Date(), providerRaw: event.raw })
        .where(and(eq(transactions.id, tx.id), ne(transactions.status, 'success')))
        .returning();

      if (updated[0]) {
        await enqueueAndDeliver(updated[0], 'payment.success');
      }
    } else if (event.type === 'payment.failed') {
      // Só marca falhado se ainda 'pending' — nunca sobrepõe um sucesso já dado.
      const updated = await db
        .update(transactions)
        .set({ status: 'failed', updatedAt: new Date(), providerRaw: event.raw })
        .where(and(eq(transactions.id, tx.id), eq(transactions.status, 'pending')))
        .returning();

      if (updated[0]) {
        await enqueueAndDeliver(updated[0], 'payment.failed');
      }
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    await logError('webhooks.paysuite', err, {
      requestId: event.requestId,
      providerPaymentId: event.providerPaymentId,
      eventType: event.type
    });

    if (dedupInserted && event.requestId) {
      await db
        .delete(providerEvents)
        .where(eq(providerEvents.requestId, event.requestId))
        .catch(() => {});
    }

    // 500 propositado: faz o PaySuite reentregar este evento mais tarde.
    return NextResponse.json({ error: 'Erro interno' }, { status: 500 });
  }
}
