import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions } from '@/db/schema';
import { authenticateApp } from '@/lib/auth';
import { chargeSchema, formatAmount } from '@/lib/validation';
import { generateReference } from '@/lib/references';
import { createCharge } from '@/lib/paysuite';
import { ApiError } from '@/lib/errors';

export const runtime = 'nodejs';

// POST /v1/charges — um app inicia uma cobrança.
// Auth: Authorization: Bearer <chave_do_app>
export async function POST(request: Request) {
  try {
    const app = await authenticateApp(request);

    const body = await request.json().catch(() => null);
    const parsed = chargeSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Corpo inválido', parsed.error.flatten());
    }
    const input = parsed.data;

    // Idempotência: se este app já criou uma cobrança com esta referência,
    // devolve a existente em vez de cobrar de novo no PaySuite.
    const [existing] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.appId, app.id), eq(transactions.appReference, input.reference)))
      .limit(1);

    if (existing) {
      return NextResponse.json({
        gateway_payment_id: existing.id,
        reference: existing.appReference,
        status: existing.status,
        checkout_url: (existing.providerRaw as any)?.data?.checkout_url ?? null,
        idempotent_replay: true
      });
    }

    const gatewayReference = generateReference(app.referencePrefix);

    // O callback_url é SEMPRE este gateway — é isto que resolve o "1 webhook,
    // N apps". Quer o PaySuite respeite o callback por-pagamento, quer use o
    // do dashboard, ambos apontam para cá.
    const charge = await createCharge({
      amount: formatAmount(input.amount),
      method: input.method,
      reference: gatewayReference,
      description: input.description,
      returnUrl: input.return_url,
      callbackUrl: `${process.env.PUBLIC_BASE_URL}/api/webhooks/paysuite`
    });

    const [tx] = await db
      .insert(transactions)
      .values({
        appId: app.id,
        appReference: input.reference,
        reference: gatewayReference,
        providerPaymentId: charge.providerPaymentId,
        amount: formatAmount(input.amount),
        currency: input.currency,
        method: input.method,
        description: input.description,
        status: 'pending',
        returnUrl: input.return_url,
        metadata: input.metadata ?? {},
        providerRaw: charge.raw
      })
      .returning();

    return NextResponse.json({
      gateway_payment_id: tx.id,
      reference: tx.appReference,
      status: tx.status,
      checkout_url: charge.checkoutUrl ?? null
    });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof ApiError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      { status: err.status }
    );
  }
  // ProviderError e imprevistos: não vazar detalhes internos ao app.
  return NextResponse.json(
    { error: { code: 'GATEWAY_ERROR', message: 'Falha ao processar a cobrança' } },
    { status: 502 }
  );
}
