import { hmacHex, safeEqual } from './crypto';
import { ProviderError } from './errors';

// ============================================================================
// Adaptador PaySuite — porta única para o PaySuite. Token e webhook secret
// vêm do ambiente do gateway; nenhum app os toca.
//
// Notas confirmadas em produção (Invoice Hub Pro, 2026-07):
//  - O header de assinatura real é `x-signature` (a doc diz
//    `X-Webhook-Signature`; ambos são tolerados abaixo, no route handler).
//  - `method` aceita 'mpesa' | 'emola' | 'credit_card'.
//  - Não há sandbox nem recorrência — só cobranças avulsas.
//  - O PaySuite pode entregar um `payment.failed` prematuro antes do
//    `payment.success` real; o estado terminal 'success' nunca é sobreposto
//    (tratado na camada de transacções, não aqui).
// ============================================================================

const BASE_URL = process.env.PAYSUITE_BASE_URL || 'https://paysuite.tech/api/v1';

// `fetch` has no default timeout — if PaySuite itself hangs (as opposed to
// responding with an error), this call would stay open for however long
// the platform's own function timeout allows, tying up the /api/v1/charges
// request the whole time. A consumer app (DueloBet) already times out its
// own call to this gateway after 15s regardless, but that only stops the
// caller from waiting — it does nothing for the request still running here.
const REQUEST_TIMEOUT_MS = 15_000;

export type PaymentMethod = 'mpesa' | 'emola' | 'credit_card';
export type ChargeStatus = 'pending' | 'success' | 'failed';

export interface PaySuiteChargeInput {
  amount: string; // já formatado com 2 casas, ex.: '10.00'
  method: PaymentMethod;
  reference: string;
  description?: string;
  returnUrl?: string;
  callbackUrl: string; // sempre o próprio gateway
}

export interface PaySuiteChargeResult {
  providerPaymentId: string;
  status: ChargeStatus;
  checkoutUrl?: string;
  raw: Record<string, unknown>;
}

export interface PaySuiteEvent {
  type: 'payment.success' | 'payment.failed';
  providerPaymentId: string;
  reference?: string;
  amount?: number;
  transactionId?: string;
  paidAt?: string;
  errorMessage?: string;
  requestId?: string;
  raw: Record<string, unknown>;
}

function mapStatus(status: string | undefined | null): ChargeStatus {
  const s = (status || '').toLowerCase();
  if (s === 'success' || s === 'paid' || s === 'completed') return 'success';
  if (s === 'failed' || s === 'error' || s === 'cancelled' || s === 'canceled' || s === 'expired') {
    return 'failed';
  }
  return 'pending';
}

function token(): string {
  const t = process.env.PAYSUITE_API_TOKEN;
  if (!t) throw new ProviderError('PAYSUITE_API_TOKEN não configurado');
  return t;
}

function webhookSecret(): string {
  const s = process.env.PAYSUITE_WEBHOOK_SECRET;
  if (!s) throw new ProviderError('PAYSUITE_WEBHOOK_SECRET não configurado');
  return s;
}

export async function createCharge(input: PaySuiteChargeInput): Promise<PaySuiteChargeResult> {
  const response = await fetch(`${BASE_URL}/payments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      amount: input.amount,
      method: input.method,
      reference: input.reference,
      description: input.description,
      return_url: input.returnUrl,
      callback_url: input.callbackUrl
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  const json = (await response.json().catch(() => null)) as any;

  if (!response.ok || !json || json.status !== 'success' || !json.data) {
    throw new ProviderError('Falha ao iniciar pagamento no PaySuite', {
      httpStatus: response.status,
      body: json
    });
  }

  return {
    providerPaymentId: json.data.id,
    status: mapStatus(json.data.status),
    checkoutUrl: json.data.checkout_url,
    raw: json
  };
}

export async function getChargeStatus(providerPaymentId: string): Promise<PaySuiteChargeResult> {
  const response = await fetch(`${BASE_URL}/payments/${providerPaymentId}`, {
    headers: { Authorization: `Bearer ${token()}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  const json = (await response.json().catch(() => null)) as any;

  if (!response.ok || !json || !json.data) {
    throw new ProviderError('Falha ao consultar estado no PaySuite', {
      httpStatus: response.status,
      body: json
    });
  }

  // Confirmado em produção (2026-07-11): o GET /payments/{id} NÃO devolve
  // `data.status` (ao contrário do que a resposta de criação sugeriria) — o
  // estado real vem aninhado em `data.transaction.status` (valor visto:
  // 'completed'). Tentamos ambos por segurança, dando prioridade ao aninhado.
  const rawStatus = json.data.transaction?.status ?? json.data.status;

  return {
    providerPaymentId: json.data.id,
    status: mapStatus(rawStatus),
    checkoutUrl: json.data.checkout_url,
    raw: json
  };
}

export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader) return false;
  return safeEqual(hmacHex(webhookSecret(), rawBody), signatureHeader);
}

export function parseWebhookEvent(rawBody: string): PaySuiteEvent {
  const json = JSON.parse(rawBody);
  if (json.event !== 'payment.success' && json.event !== 'payment.failed') {
    throw new ProviderError(`Evento de webhook desconhecido: ${json.event}`, json);
  }
  return {
    type: json.event,
    providerPaymentId: json.data?.id,
    reference: json.data?.reference,
    amount: json.data?.amount != null ? Number(json.data.amount) : undefined,
    transactionId: json.data?.transaction?.id,
    paidAt: json.data?.transaction?.paid_at,
    errorMessage: json.data?.error,
    requestId: json.request_id,
    raw: json
  };
}
