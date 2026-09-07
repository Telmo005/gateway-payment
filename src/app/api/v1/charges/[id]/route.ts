import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions } from '@/db/schema';
import { authenticateApp } from '@/lib/auth';
import { ApiError } from '@/lib/errors';
import { logError } from '@/lib/errorLog';

export const runtime = 'nodejs';

// GET /v1/charges/{gateway_payment_id} — consulta de estado (fallback/polling).
// Um app só pode ver as suas próprias transacções.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const app = await authenticateApp(request);
    const { id } = await params;

    const [tx] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.appId, app.id)))
      .limit(1);

    if (!tx) {
      throw new ApiError(404, 'NOT_FOUND', 'Transacção não encontrada');
    }

    return NextResponse.json({
      gateway_payment_id: tx.id,
      reference: tx.appReference,
      status: tx.status,
      amount: Number(tx.amount),
      currency: tx.currency,
      method: tx.method,
      paid_at: tx.paidAt ? tx.paidAt.toISOString() : null,
      checkout_url: (tx.providerRaw as any)?.checkout_url ?? null,
      metadata: tx.metadata ?? {}
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status });
    }
    await logError('charges.get', err);
    return NextResponse.json({ error: { code: 'GATEWAY_ERROR', message: 'Erro interno' } }, { status: 500 });
  }
}
