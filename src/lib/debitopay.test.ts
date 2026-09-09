import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCharge, getChargeStatus, verifyWebhookSignature, parseWebhookEvent } from './debitopay';
import { hmacHex, sha256 } from './crypto';
import { ProviderError } from './errors';

const ENV_KEYS = [
  'DEBITOPAY_API_KEY',
  'DEBITOPAY_MERCHANT_ID',
  'DEBITOPAY_WEBHOOK_SECRET',
  'DEBITOPAY_WALLET_CODE_MPESA',
  'DEBITOPAY_WALLET_CODE_EMOLA',
  'DEBITOPAY_WALLET_CODE_MKESH',
  'DEBITOPAY_WALLET_CODE_VISA_MASTERCARD',
  'DEBITOPAY_WALLET_CODE_PAYFAST'
] as const;

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  process.env.DEBITOPAY_API_KEY = 'sk_test_123';
  process.env.DEBITOPAY_MERCHANT_ID = 'merchant-uuid';
  process.env.DEBITOPAY_WEBHOOK_SECRET = 'whsec_test';
  process.env.DEBITOPAY_WALLET_CODE_MPESA = '11111';
  process.env.DEBITOPAY_WALLET_CODE_EMOLA = '22222';
  process.env.DEBITOPAY_WALLET_CODE_MKESH = '33333';
  process.env.DEBITOPAY_WALLET_CODE_VISA_MASTERCARD = '44444';
  process.env.DEBITOPAY_WALLET_CODE_PAYFAST = '55555';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  vi.unstubAllGlobals();
});

function mockFetchOnce(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('createCharge — selecção de wallet_code por método (não por moeda)', () => {
  it.each([
    ['mpesa', '11111'],
    ['emola', '22222'],
    ['mkesh', '33333'],
    ['visa_mastercard', '44444'],
    ['payfast', '55555']
  ] as const)('usa a carteira correcta para %s', async (method, expectedWallet) => {
    const fetchMock = mockFetchOnce(200, { success: true, payment_id: 'pay_1', status: 'pending' });

    await createCharge({
      method,
      amount: 100,
      currency: method === 'payfast' ? 'ZAR' : 'MZN',
      reference: 'REF-1'
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.wallet_code).toBe(expectedWallet);
    expect(body.payment_method).toBe(method);
  });

  it('rejeita quando a variável de carteira do método não está configurada', async () => {
    delete process.env.DEBITOPAY_WALLET_CODE_MPESA;
    mockFetchOnce(200, { success: true, payment_id: 'pay_1', status: 'success' });

    await expect(
      createCharge({ method: 'mpesa', amount: 100, currency: 'MZN', reference: 'REF-1' })
    ).rejects.toThrow(ProviderError);
  });
});

describe('createCharge — payload e mapeamento de resposta', () => {
  it('envia Authorization Bearer com a API key', async () => {
    const fetchMock = mockFetchOnce(200, { success: true, payment_id: 'pay_1', status: 'success' });
    await createCharge({ method: 'mpesa', amount: 50, currency: 'MZN', reference: 'REF-1' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer sk_test_123');
  });

  it('inclui phone/customer_name/customer_email/return_url só quando fornecidos', async () => {
    const fetchMock = mockFetchOnce(200, { success: true, payment_id: 'pay_1', status: 'pending' });
    await createCharge({
      method: 'visa_mastercard',
      amount: 500,
      currency: 'MZN',
      reference: 'REF-2',
      payerName: 'João',
      payerEmail: 'joao@example.com',
      returnUrl: 'https://app.example.com/resultado'
    });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.phone).toBeUndefined();
    expect(body.customer_name).toBe('João');
    expect(body.customer_email).toBe('joao@example.com');
    expect(body.return_url).toBe('https://app.example.com/resultado');
  });

  it.each([
    ['success', 'success'],
    ['pending', 'pending'],
    ['failed', 'failed'],
    ['expired', 'failed'],
    [undefined, 'pending']
  ] as const)('mapeia status "%s" da Debito Pay para "%s"', async (raw, expected) => {
    mockFetchOnce(200, { success: true, payment_id: 'pay_1', status: raw });
    const result = await createCharge({ method: 'mpesa', amount: 50, currency: 'MZN', reference: 'REF-1' });
    expect(result.status).toBe(expected);
  });

  it('devolve checkoutUrl quando presente na resposta', async () => {
    mockFetchOnce(200, {
      success: true,
      payment_id: 'pay_1',
      status: 'pending',
      checkout_url: 'https://debitopay.com/checkout/card?x=1'
    });
    const result = await createCharge({ method: 'visa_mastercard', amount: 500, currency: 'MZN', reference: 'REF-1' });
    expect(result.checkoutUrl).toBe('https://debitopay.com/checkout/card?x=1');
  });

  it('lança ProviderError quando a resposta HTTP não é ok', async () => {
    mockFetchOnce(401, { success: false, error: 'INVALID_API_KEY' });
    await expect(
      createCharge({ method: 'mpesa', amount: 50, currency: 'MZN', reference: 'REF-1' })
    ).rejects.toThrow(ProviderError);
  });

  it('lança ProviderError quando success: false mesmo com HTTP 200', async () => {
    mockFetchOnce(200, { success: false, error: 'WALLET_CODE_NOT_FOUND' });
    await expect(
      createCharge({ method: 'mpesa', amount: 50, currency: 'MZN', reference: 'REF-1' })
    ).rejects.toThrow(ProviderError);
  });
});

describe('getChargeStatus', () => {
  it('envia action: check-status com o payment_id', async () => {
    const fetchMock = mockFetchOnce(200, { success: true, payment: { id: 'pay_1', status: 'success' } });
    await getChargeStatus('pay_1');
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ action: 'check-status', payment_id: 'pay_1' });
  });

  it('mapeia o status aninhado em payment.status', async () => {
    mockFetchOnce(200, { success: true, payment: { id: 'pay_1', status: 'success' } });
    const result = await getChargeStatus('pay_1');
    expect(result.status).toBe('success');
    expect(result.providerPaymentId).toBe('pay_1');
  });
});

describe('verifyWebhookSignature', () => {
  it('aceita uma assinatura HMAC-SHA256 válida', () => {
    const rawBody = '{"event":"payment.completed"}';
    const signature = hmacHex('whsec_test', rawBody);
    expect(verifyWebhookSignature(rawBody, signature)).toBe(true);
  });

  it('rejeita uma assinatura inválida', () => {
    expect(verifyWebhookSignature('{}', 'assinatura-errada')).toBe(false);
  });

  it('rejeita quando não há header de assinatura', () => {
    expect(verifyWebhookSignature('{}', null)).toBe(false);
  });
});

describe('parseWebhookEvent', () => {
  it('mapeia payment.completed para payment.success', () => {
    const raw = JSON.stringify({ event: 'payment.completed', data: { payment_id: 'pay_1' } });
    expect(parseWebhookEvent(raw).type).toBe('payment.success');
  });

  it.each(['payment.failed', 'payment.refunded', 'payment.chargeback'] as const)(
    'preserva o tipo %s sem tradução',
    (event) => {
      const raw = JSON.stringify({ event, data: { payment_id: 'pay_1' } });
      expect(parseWebhookEvent(raw).type).toBe(event);
    }
  );

  it('lança ProviderError para um evento desconhecido', () => {
    const raw = JSON.stringify({ event: 'payment.something_else', data: {} });
    expect(() => parseWebhookEvent(raw)).toThrow(ProviderError);
  });

  it('extrai payment_id, reference, amount e paid_at do payload', () => {
    const raw = JSON.stringify({
      event: 'payment.completed',
      data: { payment_id: 'pay_1', reference: 'REF-1', amount: 150, paid_at: '2026-09-09T10:00:00Z' }
    });
    const event = parseWebhookEvent(raw);
    expect(event.providerPaymentId).toBe('pay_1');
    expect(event.reference).toBe('REF-1');
    expect(event.amount).toBe(150);
    expect(event.paidAt).toBe('2026-09-09T10:00:00Z');
  });

  it('gera requestId determinístico (hash do corpo) — mesma entrega, mesmo id', () => {
    const raw = JSON.stringify({ event: 'payment.completed', data: { payment_id: 'pay_1' } });
    expect(parseWebhookEvent(raw).requestId).toBe(sha256(raw));
  });

  it('gera requestId diferente para corpos diferentes', () => {
    const rawA = JSON.stringify({ event: 'payment.completed', data: { payment_id: 'pay_1' } });
    const rawB = JSON.stringify({ event: 'payment.completed', data: { payment_id: 'pay_2' } });
    expect(parseWebhookEvent(rawA).requestId).not.toBe(parseWebhookEvent(rawB).requestId);
  });
});
