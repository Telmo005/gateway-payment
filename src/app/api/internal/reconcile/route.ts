import { NextResponse } from 'next/server';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions } from '@/db/schema';
import { authorizeCron } from '@/lib/auth';
import { getChargeStatus } from '@/lib/debitopay';
import { enqueueAndDeliver } from '@/lib/fanout';
import { ApiError } from '@/lib/errors';
import { logError } from '@/lib/errorLog';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Rede de segurança contra webhooks perdidos (deploy, partição de rede): faz
// poll à Debito Pay para transacções ainda 'pending' há mais de N minutos
// (emola/mkesh/cartão/payfast — m-Pesa nunca fica 'pending'). Se o estado
// real já mudou, atualiza e dispara o fan-out que se perdeu.
//
// Agendar via Vercel Cron (ex.: a cada 5 min) com Authorization: Bearer CRON_SECRET.
const STALE_MINUTES = 5;
const BATCH = 50;

export async function POST(request: Request) {
  try {
    authorizeCron(request);
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const cutoff = new Date(Date.now() - STALE_MINUTES * 60_000);

  const stale = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.status, 'pending'), lt(transactions.createdAt, cutoff)))
    .limit(BATCH);

  let reconciled = 0;
  const results: Array<{ id: string; status: string }> = [];

  for (const tx of stale) {
    if (!tx.providerPaymentId) continue;
    try {
      const remote = await getChargeStatus(tx.providerPaymentId);
      if (remote.status === 'pending') continue;

      const newStatus = remote.status; // 'success' | 'failed'
      const updated = await db
        .update(transactions)
        .set({
          status: newStatus,
          paidAt: newStatus === 'success' ? new Date() : tx.paidAt,
          updatedAt: new Date(),
          providerRaw: remote.raw
        })
        .where(and(eq(transactions.id, tx.id), eq(transactions.status, 'pending')))
        .returning();

      if (updated[0]) {
        await enqueueAndDeliver(
          updated[0],
          newStatus === 'success' ? 'payment.success' : 'payment.failed'
        );
        reconciled++;
        results.push({ id: tx.id, status: newStatus });
      }
    } catch (err) {
      // Falha ao consultar uma transacção não deve abortar o lote todo.
      await logError('internal.reconcile', err, { transactionId: tx.id });
      continue;
    }
  }

  return NextResponse.json({ checked: stale.length, reconciled, results });
}
