/**
 * PayGate client SDK — copia este ficheiro para cada app (ex.:
 * src/lib/payments/paygate-client.ts) e usa-o em vez de chamar o PaySuite
 * diretamente. Zero dependências; usa só `fetch` e `crypto` (Node).
 *
 * O app precisa de duas variáveis de ambiente (dadas pelo register-app):
 *   PAYGATE_BASE_URL        = https://pay.teudominio.com
 *   PAYGATE_API_KEY         = pk_...
 *   PAYGATE_CALLBACK_SECRET = <hex>   (para verificar os webhooks reenviados)
 */
import crypto from 'crypto';

// `fetch` has no default timeout — an unreachable/misconfigured
// PAYGATE_BASE_URL, or the gateway itself hanging, would otherwise leave
// this call pending indefinitely instead of failing fast (confirmed in
// production via a consumer app: a deposit request that never returned).
const REQUEST_TIMEOUT_MS = 15_000;

export type PaymentMethod = 'mpesa' | 'emola' | 'mkesh' | 'visa_mastercard' | 'payfast';

export interface CreateChargeInput {
  /** Referência ÚNICA do teu app — chave de idempotência (ex.: o teu pagamento.id). */
  reference: string;
  amount: number;
  method: PaymentMethod;
  /** Obrigatório para mpesa/emola/mkesh, formato internacional (+258...). */
  payerPhone?: string;
  payerName: string;
  /** Obrigatório para visa_mastercard/payfast. */
  payerEmail?: string;
  /** Obrigatório para visa_mastercard/payfast — para onde o pagador volta depois do Hosted Checkout. */
  returnUrl?: string;
  /** 'MZN' (default) ou 'ZAR' — ZAR só com method 'payfast'. */
  currency?: string;
  description?: string;
  /** Metadados leves ecoados no webhook. NÃO metas payloads pesados. */
  metadata?: Record<string, unknown>;
}

export interface CreateChargeResult {
  gatewayPaymentId: string;
  reference: string;
  /** mpesa confirma já aqui ('success'/'failed'). Os restantes nascem
   *  'pending' até o webhook confirmar — usa `checkoutUrl` para redireccionar
   *  o pagador quando for visa_mastercard/payfast. */
  status: 'pending' | 'success' | 'failed';
  /** Motivo, útil sobretudo quando status === 'failed' (ex.: "Saldo insuficiente"). */
  message: string | null;
  /** Só visa_mastercard/payfast — redirecciona o pagador para aqui. */
  checkoutUrl: string | null;
}

export interface PayGateWebhook {
  type: 'payment.success' | 'payment.failed';
  created_at: string;
  data: {
    gateway_payment_id: string;
    reference: string;
    amount: number;
    currency: string;
    method: string;
    status: 'success' | 'failed';
    paid_at: string | null;
    metadata: Record<string, unknown>;
  };
}

export class PayGateClient {
  constructor(
    private readonly baseUrl = process.env.PAYGATE_BASE_URL!,
    private readonly apiKey = process.env.PAYGATE_API_KEY!,
    private readonly callbackSecret = process.env.PAYGATE_CALLBACK_SECRET!
  ) {}

  /**
   * Inicia uma cobrança. mpesa confirma já nesta resposta ('success'/'failed').
   * emola/mkesh/visa_mastercard/payfast nascem 'pending' — para
   * visa_mastercard/payfast, redirecciona o pagador para `checkoutUrl`; para
   * os restantes, espera o teu endpoint de callback ser chamado pelo fan-out.
   */
  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    const res = await fetch(`${this.baseUrl}/api/v1/charges`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        reference: input.reference,
        amount: input.amount,
        method: input.method,
        payer_phone: input.payerPhone,
        payer_name: input.payerName,
        payer_email: input.payerEmail,
        return_url: input.returnUrl,
        currency: input.currency ?? 'MZN',
        description: input.description,
        metadata: input.metadata
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.gateway_payment_id) {
      throw new Error(`PayGate createCharge falhou: ${res.status} ${JSON.stringify(json)}`);
    }

    return {
      gatewayPaymentId: json.gateway_payment_id,
      reference: json.reference,
      status: json.status,
      message: json.message ?? null,
      checkoutUrl: json.checkout_url ?? null
    };
  }

  /** Consulta de estado (fallback/polling). */
  async getCharge(gatewayPaymentId: string) {
    const res = await fetch(`${this.baseUrl}/api/v1/charges/${gatewayPaymentId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`PayGate getCharge falhou: ${res.status}`);
    return json as {
      gateway_payment_id: string;
      reference: string;
      status: 'pending' | 'success' | 'failed';
      amount: number;
      currency: string;
      method: string;
      paid_at: string | null;
      checkout_url: string | null;
      metadata: Record<string, unknown>;
    };
  }

  /**
   * Verifica a assinatura de um webhook reenviado pelo gateway.
   * `rawBody` tem de ser o corpo CRU (string), não o objeto já parseado.
   */
  verifyWebhook(rawBody: string, signatureHeader: string | null): boolean {
    if (!signatureHeader) return false;
    const expected = crypto.createHmac('sha256', this.callbackSecret).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signatureHeader, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}
