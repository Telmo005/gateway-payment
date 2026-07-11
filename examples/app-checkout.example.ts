/**
 * EXEMPLO — como um app inicia uma cobrança via gateway (substitui a chamada
 * direta ao PaySuiteProvider.charge no Invoice Hub).
 */
import { PayGateClient } from '@/lib/payments/paygate-client';
// import { supabaseServer } from '@/lib/supabase-server';

const paygate = new PayGateClient();

export async function iniciarCobrancaExemplo(userId: string) {
  // 1. Cria o registo local ANTES (para teres um id estável como referência).
  //    const pagamentoId = crypto.randomUUID();

  // 2. Chama o gateway. `reference` = a tua chave de idempotência local.
  const charge = await paygate.createCharge({
    reference: 'IHP-EXEMPLO-123', // ex.: pagamentoId
    amount: 10,
    method: 'mpesa',
    description: 'Documento - Invoice Hub Pro',
    returnUrl: `${process.env.NEXT_PUBLIC_APP_URL}/pages/payments/success`,
    // Metadados leves. O payload pesado (HTML do documento) fica no TEU BD.
    metadata: { tipo: 'fatura' }
  });

  // 3. Guarda `charge.gatewayPaymentId` em external_id — é por aqui que o
  //    webhook reenviado te vai encontrar.
  //    await supabase.from('pagamentos').insert({
  //      id: pagamentoId,
  //      user_id: userId,
  //      external_id: charge.gatewayPaymentId,
  //      gateway: 'paygate',
  //      status: 'aguardando_documento',
  //      ...
  //    });

  // 4. Redireciona o utilizador para pagar.
  return charge.checkoutUrl;
}
