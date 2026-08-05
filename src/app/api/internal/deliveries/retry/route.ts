import { NextResponse } from 'next/server';
import { and, eq, lte } from 'drizzle-orm';
import { db } from '@/db/client';
import { webhookDeliveries } from '@/db/schema';
import { authorizeCron } from '@/lib/auth';
import { attemptDelivery } from '@/lib/fanout';
import { ApiError } from '@/lib/errors';
import { logError } from '@/lib/errorLog';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Reprocessa entregas de fan-out que falharam e cujo next_retry_at já passou.
// Agendar via Vercel Cron (ex.: a cada minuto) com Authorization: Bearer CRON_SECRET.
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

  const due = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(
      and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextRetryAt, new Date()))
    )
    .limit(BATCH);

  // Cada entrega é isolada: uma falha (ex.: soletra de rede pontual numa só
  // delivery) não pode abortar o lote inteiro e deixar as restantes sem
  // tentativa até ao próximo minuto.
  let failed = 0;
  for (const d of due) {
    try {
      await attemptDelivery(d.id);
    } catch (err) {
      failed++;
      await logError('internal.deliveries.retry', err, { deliveryId: d.id });
    }
  }

  return NextResponse.json({ processed: due.length, failed });
}
