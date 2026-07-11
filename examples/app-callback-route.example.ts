/**
 * EXEMPLO — handler de callback que CADA app monta para receber os webhooks
 * reenviados pelo gateway. Copia para o app em, ex.:
 *   src/app/api/payments/webhook/paygate/route.ts
 *
 * Compara com o webhook atual do Invoice Hub (src/app/api/payments/webhook/
 * paysuite/route.ts): a estrutura é a MESMA. Só muda:
 *   - o segredo (PAYGATE_CALLBACK_SECRET, próprio do app, em vez do do PaySuite)
 *   - o header de assinatura ('x-paygate-signature')
 *   - a chave de correspondência: usa `gateway_payment_id` (que guardaste em
 *     external_id na criação) em vez do id do PaySuite.
 */
import { NextResponse } from 'next/server';
import { PayGateClient, type PayGateWebhook } from '@/lib/payments/paygate-client';
// import { supabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

const paygate = new PayGateClient();

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-paygate-signature');

  // 1. Verifica a assinatura com o TEU callback secret.
  if (!paygate.verifyWebhook(rawBody, signature)) {
    return NextResponse.json({ error: 'Assinatura inválida' }, { status: 401 });
  }

  const event = JSON.parse(rawBody) as PayGateWebhook;
  const { gateway_payment_id, reference } = event.data;

  // 2. Encontra o teu pagamento local. Guardaste `gateway_payment_id` em
  //    `external_id` no momento do checkout (ver app-checkout snippet).
  //
  // const { data: pagamento } = await supabaseAdmin
  //   .from('pagamentos')
  //   .select('*')
  //   .eq('external_id', gateway_payment_id)
  //   .maybeSingle();
  // if (!pagamento) return NextResponse.json({ received: true }); // ack

  // 3. UPDATE condicional (idempotência) — igual ao que já fazes hoje.
  if (event.type === 'payment.success') {
    // ... marca 'pago', gera o documento / renova a assinatura, etc.
  } else if (event.type === 'payment.failed') {
    // ... marca 'falhado'
  }

  // 4. Responde 200 depressa. O gateway repete se não receber 2xx.
  return NextResponse.json({ received: true });
}
