import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { hmacHex } from '@/lib/crypto';

// ----------------------------------------------------------------------------
// Mock fluente para o `db` do drizzle: qualquer chamada de método devolve o
// próprio objecto (para encadear .values().where().limit()...) e o objecto é
// "thenable", resolvendo para o valor configurado no teste. Cobre exactamente
// as chains usadas em route.ts — não é um mock genérico de drizzle.
// ----------------------------------------------------------------------------
function chain(result: unknown) {
  const obj: any = {
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
    catch: (fn: any) => Promise.resolve(result).catch(fn)
  };
  for (const m of ['values', 'onConflictDoNothing', 'returning', 'from', 'where', 'limit', 'set']) {
    obj[m] = vi.fn(() => obj);
  }
  return obj;
}

// Variante para simular uma falha (ex.: erro de ligação à BD) sem construir
// um Promise.reject "solto" em tempo de definição do teste — isso dispararia
// um aviso de unhandled rejection antes de route.ts sequer chamar `await`.
function chainError(error: unknown) {
  const obj: any = {
    then: (_resolve: any, reject: any) => reject(error),
    catch: (fn: any) => Promise.resolve().then(() => fn(error))
  };
  for (const m of ['values', 'onConflictDoNothing', 'returning', 'from', 'where', 'limit', 'set']) {
    obj[m] = vi.fn(() => obj);
  }
  return obj;
}

const dbMock = {
  insert: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  delete: vi.fn()
};

vi.mock('@/db/client', () => ({ db: dbMock }));
vi.mock('@/db/schema', () => ({ transactions: {}, providerEvents: { requestId: 'request_id' } }));

const enqueueAndDeliver = vi.fn();
vi.mock('@/lib/fanout', () => ({ enqueueAndDeliver: (...args: unknown[]) => enqueueAndDeliver(...args) }));

const logError = vi.fn();
vi.mock('@/lib/errorLog', () => ({ logError: (...args: unknown[]) => logError(...args) }));

const WEBHOOK_SECRET = 'whsec_test';

function signedRequest(payload: Record<string, unknown>) {
  const rawBody = JSON.stringify(payload);
  const signature = hmacHex(WEBHOOK_SECRET, rawBody);
  return new Request('https://gateway.example.com/api/webhooks/debitopay', {
    method: 'POST',
    headers: { 'x-webhook-signature': signature, 'content-type': 'application/json' },
    body: rawBody
  });
}

const baseTx = {
  id: 'tx-uuid-1',
  providerPaymentId: 'pay_1',
  status: 'pending',
  providerRaw: { checkout_url: 'https://debitopay.com/checkout/card?x=1' }
};

let POST: (request: Request) => Promise<Response>;

beforeEach(async () => {
  vi.resetModules();
  process.env.DEBITOPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  dbMock.insert.mockReset();
  dbMock.select.mockReset();
  dbMock.update.mockReset();
  dbMock.delete.mockReset();
  enqueueAndDeliver.mockReset();
  logError.mockReset();
  ({ POST } = await import('./route'));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/webhooks/debitopay — segurança', () => {
  it('devolve 401 sem header de assinatura', async () => {
    const rawBody = JSON.stringify({ event: 'payment.completed', data: { payment_id: 'pay_1' } });
    const request = new Request('https://x/api/webhooks/debitopay', { method: 'POST', body: rawBody });
    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it('devolve 401 com assinatura inválida', async () => {
    const rawBody = JSON.stringify({ event: 'payment.completed', data: { payment_id: 'pay_1' } });
    const request = new Request('https://x/api/webhooks/debitopay', {
      method: 'POST',
      headers: { 'x-webhook-signature': 'assinatura-forjada' },
      body: rawBody
    });
    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it('devolve 400 para um evento desconhecido (mesmo com assinatura válida)', async () => {
    const request = signedRequest({ event: 'payment.unknown_thing', data: {} });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});

describe('POST /api/webhooks/debitopay — idempotência e correspondência', () => {
  it('devolve duplicate:true sem tocar em transactions quando o dedup já existe', async () => {
    dbMock.insert.mockReturnValue(chain([])); // onConflictDoNothing → nada inserido
    const request = signedRequest({ event: 'payment.completed', data: { payment_id: 'pay_1' } });

    const response = await POST(request);
    const json = await response.json();

    expect(json).toEqual({ received: true, duplicate: true });
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(enqueueAndDeliver).not.toHaveBeenCalled();
  });

  it('faz ack (matched:false) quando nenhuma transacção corresponde ao payment_id', async () => {
    dbMock.insert.mockReturnValue(chain([{ id: 'evt-1' }]));
    dbMock.select.mockReturnValue(chain([]));
    const request = signedRequest({ event: 'payment.completed', data: { payment_id: 'pay_desconhecido' } });

    const response = await POST(request);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ received: true, matched: false });
    expect(enqueueAndDeliver).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhooks/debitopay — payment.success', () => {
  it('transita pending -> success e dispara o fan-out', async () => {
    dbMock.insert.mockReturnValue(chain([{ id: 'evt-1' }]));
    dbMock.select.mockReturnValue(chain([baseTx]));
    const updatedTx = { ...baseTx, status: 'success' };
    dbMock.update.mockReturnValue(chain([updatedTx]));

    const request = signedRequest({
      event: 'payment.completed',
      data: { payment_id: 'pay_1', paid_at: '2026-09-09T10:00:00.000Z' }
    });
    const response = await POST(request);
    const json = await response.json();

    expect(json).toEqual({ received: true });
    expect(enqueueAndDeliver).toHaveBeenCalledWith(updatedTx, 'payment.success');
  });

  it('junta o providerRaw guardado (checkout_url) ao evento em vez de o substituir', async () => {
    dbMock.insert.mockReturnValue(chain([{ id: 'evt-1' }]));
    dbMock.select.mockReturnValue(chain([baseTx]));
    dbMock.update.mockReturnValue(chain([{ ...baseTx, status: 'success' }]));

    const request = signedRequest({ event: 'payment.completed', data: { payment_id: 'pay_1' } });
    await POST(request);

    const updateChain = dbMock.update.mock.results[0].value;
    const setCallArg = updateChain.set.mock.calls[0][0];
    expect(setCallArg.providerRaw.checkout_url).toBe('https://debitopay.com/checkout/card?x=1');
    expect(setCallArg.providerRaw.event).toBe('payment.completed');
  });

  it('não dispara fan-out quando a transacção já estava success (corrida ganha por outra entrega)', async () => {
    dbMock.insert.mockReturnValue(chain([{ id: 'evt-1' }]));
    dbMock.select.mockReturnValue(chain([{ ...baseTx, status: 'success' }]));
    dbMock.update.mockReturnValue(chain([])); // ne(status,'success') não bateu com nenhuma linha

    const request = signedRequest({ event: 'payment.completed', data: { payment_id: 'pay_1' } });
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(enqueueAndDeliver).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhooks/debitopay — payment.failed', () => {
  it('transita pending -> failed e dispara o fan-out', async () => {
    dbMock.insert.mockReturnValue(chain([{ id: 'evt-1' }]));
    dbMock.select.mockReturnValue(chain([baseTx]));
    const updatedTx = { ...baseTx, status: 'failed' };
    dbMock.update.mockReturnValue(chain([updatedTx]));

    const request = signedRequest({ event: 'payment.failed', data: { payment_id: 'pay_1' } });
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(enqueueAndDeliver).toHaveBeenCalledWith(updatedTx, 'payment.failed');
  });

  it('nunca sobrepõe um sucesso já confirmado com um failed tardio', async () => {
    dbMock.insert.mockReturnValue(chain([{ id: 'evt-1' }]));
    dbMock.select.mockReturnValue(chain([{ ...baseTx, status: 'success' }]));
    dbMock.update.mockReturnValue(chain([])); // eq(status,'pending') não bateu

    const request = signedRequest({ event: 'payment.failed', data: { payment_id: 'pay_1' } });
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(enqueueAndDeliver).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhooks/debitopay — refund/chargeback', () => {
  it.each(['payment.refunded', 'payment.chargeback'])(
    'responde 200 sem chamar update nem fan-out para %s',
    async (event) => {
      dbMock.insert.mockReturnValue(chain([{ id: 'evt-1' }]));
      dbMock.select.mockReturnValue(chain([baseTx]));

      const request = signedRequest({ event, data: { payment_id: 'pay_1' } });
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(dbMock.update).not.toHaveBeenCalled();
      expect(enqueueAndDeliver).not.toHaveBeenCalled();
    }
  );
});

describe('POST /api/webhooks/debitopay — falha a meio do processamento', () => {
  it('devolve 500 e desfaz o dedup para permitir reentrega', async () => {
    dbMock.insert.mockReturnValue(chain([{ id: 'evt-1' }]));
    dbMock.select.mockReturnValue(chain(Promise.reject(new Error('db indisponível'))));
    dbMock.delete.mockReturnValue(chain(undefined));

    const request = signedRequest({ event: 'payment.completed', data: { payment_id: 'pay_1' } });
    const response = await POST(request);

    expect(response.status).toBe(500);
    expect(dbMock.delete).toHaveBeenCalled();
    expect(logError).toHaveBeenCalled();
  });
});
