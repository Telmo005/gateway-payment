/**
 * EXEMPLO — como um app inicia uma cobrança via gateway (substitui a chamada
 * direta ao provider de pagamento no Invoice Hub).
 *
 * Desde a migração para Debito Pay há dois fluxos:
 *  - mpesa confirma já nesta resposta ('success'/'failed').
 *  - emola/mkesh/visa_mastercard/payfast nascem 'pending' — para cartão/
 *    payfast, redirecciona o utilizador para `charge.checkoutUrl`; para os
 *    restantes, o teu endpoint de callback (webhook do gateway) é chamado
 *    quando confirmar.
 */
import { PayGateClient } from '@/lib/payments/paygate-client';
// import { supabaseServer } from '@/lib/supabase-server';

const paygate = new PayGateClient();

export async function iniciarCobrancaExemplo(userId: string, payerPhone: string, payerName: string) {
  // 1. Cria o registo local ANTES (para teres um id estável como referência).
  //    const pagamentoId = crypto.randomUUID();

  // 2. Chama o gateway. `reference` = a tua chave de idempotência local.
  //    payerPhone/payerName vêm de quem está a pagar (ex.: formulário) —
  //    sem checkout hospedado, o gateway precisa deles já aqui.
  const charge = await paygate.createCharge({
    reference: 'IHP-EXEMPLO-123', // ex.: pagamentoId
    amount: 10,
    method: 'mpesa',
    payerPhone, // formato internacional, ex.: '+258840000000'
    payerName,
    description: 'Documento - Invoice Hub Pro',
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
  //      status: charge.status === 'success' ? 'pago' : charge.status === 'pending' ? 'pendente' : 'falhou',
  //      ...
  //    });

  // 4. mpesa: `charge.status` já é o resultado final ('success' | 'failed').
  //    Se falhou, `charge.message` traz o motivo (ex.: "Saldo insuficiente").
  //    emola/mkesh: 'pending' — espera o callback. cartão/payfast: 'pending'
  //    com `charge.checkoutUrl` preenchido — redirecciona o utilizador para lá.
  return charge;
}
