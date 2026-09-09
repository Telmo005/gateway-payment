import { hmacHex, safeEqual, sha256 } from './crypto';
import { ProviderError } from './errors';

// ============================================================================
// Adaptador Debito Pay — substitui o MozPayment (migração iniciada antes de
// terminar, ver README). Merchant id, wallet codes, API key e webhook secret
// vêm do ambiente do gateway; nenhum app os toca.
//
// Diferenças fundamentais vs. MozPayment:
//  - Um único endpoint (`/payment-orchestrator`) para os 5 métodos: mpesa,
//    emola, mkesh, visa_mastercard, payfast.
//  - MISTO: m-Pesa confirma SÍNCRONO (status já vem 'success'/'failed' na
//    resposta do POST). e-Mola e mKesh são ASSÍNCRONOS (`status: 'pending'`,
//    confirmação por webhook). Cartão (Visa/Mastercard) e PayFast devolvem
//    `checkout_url` para redireccionar o pagador ao Hosted Checkout da
//    Debito Pay; a confirmação também chega por webhook.
//  - Por isso, ao contrário do MozPayment, este adaptador expõe
//    `getChargeStatus` (usado pelo /api/internal/reconcile) e o webhook
//    dedicado (`/api/webhooks/debitopay`) volta a estar activo.
// ============================================================================

const BASE_URL = process.env.DEBITOPAY_BASE_URL || 'https://gyqoaningqhurhvdugne.supabase.co/functions/v1';
const REQUEST_TIMEOUT_MS = 15_000;

export type PaymentMethod = 'mpesa' | 'emola' | 'mkesh' | 'visa_mastercard' | 'payfast';
export type ChargeStatus = 'pending' | 'success' | 'failed';

export const MOBILE_MONEY_METHODS: readonly PaymentMethod[] = ['mpesa', 'emola', 'mkesh'];
export const HOSTED_CHECKOUT_METHODS: readonly PaymentMethod[] = ['visa_mastercard', 'payfast'];

// Valores mínimos por transacção, conforme a doc oficial.
export const MIN_AMOUNT: Record<PaymentMethod, number> = {
  mpesa: 10,
  mkesh: 10,
  emola: 50,
  visa_mastercard: 50,
  payfast: 5
};

export interface DebitoPayChargeInput {
  method: PaymentMethod;
  amount: number;
  currency: 'MZN' | 'ZAR';
  reference: string; // vira `source_id` — ajuda a reconciliar do lado da Debito Pay
  payerPhone?: string; // obrigatório para mpesa/emola/mkesh, formato E.164
  payerName?: string;
  payerEmail?: string;
  returnUrl?: string; // obrigatório para visa_mastercard/payfast
}

export interface DebitoPayChargeResult {
  status: ChargeStatus;
  providerPaymentId: string; // `payment_id` — usado para check-status e para casar o webhook
  checkoutUrl?: string; // só visa_mastercard/payfast
  message?: string;
  raw: Record<string, unknown>;
}

function apiKey(): string {
  const k = process.env.DEBITOPAY_API_KEY;
  if (!k) throw new ProviderError('DEBITOPAY_API_KEY não configurado');
  return k;
}

function merchantId(): string {
  const v = process.env.DEBITOPAY_MERCHANT_ID;
  if (!v) throw new ProviderError('DEBITOPAY_MERCHANT_ID não configurado');
  return v;
}

// Uma carteira por MÉTODO, não por moeda — confirmado no painel Debito Pay
// (cada método lá tem o seu próprio wallet_code, mesmo dois em MZN). Enviar
// o wallet_code errado não dá erro nenhum — o dinheiro só aparece na
// carteira errada — por isso não há aqui um fallback "genérico por moeda".
const WALLET_CODE_ENV: Record<PaymentMethod, string> = {
  mpesa: 'DEBITOPAY_WALLET_CODE_MPESA',
  emola: 'DEBITOPAY_WALLET_CODE_EMOLA',
  mkesh: 'DEBITOPAY_WALLET_CODE_MKESH',
  visa_mastercard: 'DEBITOPAY_WALLET_CODE_VISA_MASTERCARD',
  payfast: 'DEBITOPAY_WALLET_CODE_PAYFAST'
};

function walletCode(method: PaymentMethod): string {
  const envVar = WALLET_CODE_ENV[method];
  const v = process.env[envVar];
  if (!v) throw new ProviderError(`${envVar} não configurado`);
  return v;
}

function webhookSecret(): string {
  const s = process.env.DEBITOPAY_WEBHOOK_SECRET;
  if (!s) throw new ProviderError('DEBITOPAY_WEBHOOK_SECRET não configurado');
  return s;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey()}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

function mapStatus(status: string | undefined | null): ChargeStatus {
  const s = (status || '').toLowerCase();
  if (s === 'success') return 'success';
  if (s === 'failed' || s === 'expired') return 'failed';
  return 'pending';
}

async function callOrchestrator(body: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${BASE_URL}/payment-orchestrator`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  const json = (await response.json().catch(() => null)) as any;

  if (!response.ok || !json || json.success === false) {
    throw new ProviderError('Falha ao comunicar com a Debito Pay', {
      httpStatus: response.status,
      body: json
    });
  }

  return json;
}

export async function createCharge(input: DebitoPayChargeInput): Promise<DebitoPayChargeResult> {
  const body: Record<string, unknown> = {
    action: 'process',
    payment_method: input.method,
    merchant_id: merchantId(),
    wallet_code: walletCode(input.method),
    amount: input.amount,
    currency: input.currency,
    source: 'gateway',
    source_id: input.reference
  };

  if (input.payerPhone) {
    body.phone = input.payerPhone;
    body.customer_phone = input.payerPhone;
  }
  if (input.payerName) body.customer_name = input.payerName;
  if (input.payerEmail) body.customer_email = input.payerEmail;
  if (input.returnUrl) body.return_url = input.returnUrl;

  const json = await callOrchestrator(body);

  return {
    status: mapStatus(json.status),
    providerPaymentId: json.payment_id,
    checkoutUrl: json.checkout_url,
    message: json.message ?? json.error,
    raw: json
  };
}

export async function getChargeStatus(providerPaymentId: string): Promise<DebitoPayChargeResult> {
  const json = await callOrchestrator({ action: 'check-status', payment_id: providerPaymentId });
  const payment = json.payment ?? {};

  return {
    status: mapStatus(payment.status),
    providerPaymentId: payment.id ?? providerPaymentId,
    message: json.message,
    raw: json
  };
}

export interface DebitoPayEvent {
  type: 'payment.success' | 'payment.failed' | 'payment.refunded' | 'payment.chargeback';
  providerPaymentId: string;
  reference?: string;
  amount?: number;
  paidAt?: string;
  requestId: string; // sintético (hash do corpo) — a doc não expõe um id de evento próprio
  raw: Record<string, unknown>;
}

const EVENT_MAP: Record<string, DebitoPayEvent['type']> = {
  'payment.completed': 'payment.success',
  'payment.failed': 'payment.failed',
  'payment.refunded': 'payment.refunded',
  'payment.chargeback': 'payment.chargeback'
};

export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader) return false;
  return safeEqual(hmacHex(webhookSecret(), rawBody), signatureHeader);
}

export function parseWebhookEvent(rawBody: string): DebitoPayEvent {
  const json = JSON.parse(rawBody);
  const type = EVENT_MAP[json.event];
  if (!type) {
    throw new ProviderError(`Evento de webhook desconhecido: ${json.event}`, json);
  }
  return {
    type,
    providerPaymentId: json.data?.payment_id,
    reference: json.data?.reference,
    amount: json.data?.amount != null ? Number(json.data.amount) : undefined,
    paidAt: json.data?.paid_at,
    // Sem id de evento na doc — hash do corpo cru serve de chave de idempotência
    // (a mesma reentrega tem o mesmo corpo; eventos distintos, corpos distintos).
    requestId: sha256(rawBody),
    raw: json
  };
}
