import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions } from '@/db/schema';
import { authenticateApp } from '@/lib/auth';
import { chargeSchema, formatAmount } from '@/lib/validation';
import { generateReference } from '@/lib/references';
import { createCharge } from '@/lib/debitopay';
import { enqueueAndDeliver } from '@/lib/fanout';
import { ApiError } from '@/lib/errors';
import { logError } from '@/lib/errorLog';

export const runtime = 'nodejs';

// POST /v1/charges — um app inicia uma cobrança.
// Auth: Authorization: Bearer <chave_do_app>
//
// Debito Pay mistura síncrono e assíncrono conforme o método: mpesa confirma
// já nesta resposta (status final, fan-out dispara já aqui); emola/mkesh e os
// métodos de Hosted Checkout (visa_mastercard/payfast) nascem 'pending' — o
// fan-out só dispara quando o webhook (/api/webhooks/debitopay) confirmar.
// Cartão/PayFast devolvem `checkout_url`: o app tem de redireccionar o
// pagador para lá.
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
    // devolve a existente em vez de cobrar de novo.
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
        message: (existing.providerRaw as any)?.message ?? null,
        checkout_url: (existing.providerRaw as any)?.checkout_url ?? null,
        idempotent_replay: true
      });
    }

    const gatewayReference = generateReference(app.referencePrefix);

    // Arredondado UMA vez e reusado no pedido ao provider e no ledger —
    // input.amount é um float sem casas decimais garantidas pelo zod
    // (ex.: 100.005), o que faria o valor cobrado divergir do guardado.
    const amount = Math.round(input.amount * 100) / 100;

    const result = await createCharge({
      method: input.method,
      amount,
      currency: input.currency,
      reference: gatewayReference,
      payerPhone: input.payer_phone,
      payerName: input.payer_name,
      payerEmail: input.payer_email,
      returnUrl: input.return_url
    });

    const [tx] = await db
      .insert(transactions)
      .values({
        appId: app.id,
        appReference: input.reference,
        reference: gatewayReference,
        providerPaymentId: result.providerPaymentId,
        amount: formatAmount(amount),
        currency: input.currency,
        method: input.method,
        description: input.description,
        status: result.status, // 'success' | 'pending' | 'failed'
        paidAt: result.status === 'success' ? new Date() : null,
        returnUrl: input.return_url,
        metadata: input.metadata ?? {},
        providerRaw: result.raw
      })
      .returning();

    // 'pending' (emola/mkesh/cartão/payfast): sem estado final ainda — o
    // fan-out ao app dono só acontece quando o webhook confirmar.
    //
    // A transacção já está persistida com o estado final nesta altura — uma
    // falha aqui (ex.: erro transitório de BD ao enfileirar a entrega) não
    // pode fazer esta rota devolver 502 "falha ao processar" para uma
    // cobrança que já foi processada com sucesso. O cron de retry de
    // entregas (deliveries/retry) não cobre isto porque a linha nem chegou a
    // ser inserida — por isso fica só registado, sem propagar.
    if (tx.status === 'success' || tx.status === 'failed') {
      try {
        await enqueueAndDeliver(tx, tx.status === 'success' ? 'payment.success' : 'payment.failed');
      } catch (err) {
        await logError('charges.create.fanout', err, { transactionId: tx.id });
      }
    }

    return NextResponse.json({
      gateway_payment_id: tx.id,
      reference: tx.appReference,
      status: tx.status,
      message: result.message ?? null,
      checkout_url: result.checkoutUrl ?? null
    });
  } catch (err) {
    return await errorResponse(err);
  }
}

async function errorResponse(err: unknown) {
  if (err instanceof ApiError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      { status: err.status }
    );
  }
  // ProviderError e imprevistos: não vazar detalhes internos ao app.
  await logError('charges.create', err);
  return NextResponse.json(
    { error: { code: 'GATEWAY_ERROR', message: 'Falha ao processar a cobrança' } },
    { status: 502 }
  );
}
