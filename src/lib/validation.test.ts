import { describe, it, expect } from 'vitest';
import { chargeSchema, formatAmount, smsSchema, pushSchema } from './validation';

const baseMobile = {
  reference: 'REF-1',
  amount: 150,
  method: 'mpesa' as const,
  payer_phone: '+258840000000',
  payer_name: 'João Silva'
};

const baseCheckout = {
  reference: 'REF-2',
  amount: 500,
  method: 'visa_mastercard' as const,
  payer_name: 'João Silva',
  payer_email: 'joao@example.com',
  return_url: 'https://app.example.com/resultado'
};

describe('chargeSchema — mobile money (mpesa/emola/mkesh)', () => {
  it('aceita um pedido válido de mpesa', () => {
    const result = chargeSchema.safeParse(baseMobile);
    expect(result.success).toBe(true);
  });

  it('aplica MZN por omissão', () => {
    const result = chargeSchema.parse(baseMobile);
    expect(result.currency).toBe('MZN');
  });

  it('rejeita mpesa sem payer_phone', () => {
    const { payer_phone, ...rest } = baseMobile;
    const result = chargeSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'payer_phone')).toBe(true);
    }
  });

  it('rejeita payer_phone em formato não-E.164', () => {
    const result = chargeSchema.safeParse({ ...baseMobile, payer_phone: '840000000' });
    expect(result.success).toBe(false);
  });

  it.each([
    ['mpesa', 10],
    ['mkesh', 10],
    ['emola', 50]
  ] as const)('rejeita %s abaixo do valor mínimo (%d MZN)', (method, min) => {
    const result = chargeSchema.safeParse({ ...baseMobile, method, amount: min - 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'amount')).toBe(true);
    }
  });

  it.each([
    ['mpesa', 10],
    ['mkesh', 10],
    ['emola', 50]
  ] as const)('aceita %s exactamente no valor mínimo (%d MZN)', (method, min) => {
    const result = chargeSchema.safeParse({ ...baseMobile, method, amount: min });
    expect(result.success).toBe(true);
  });

  it('não exige payer_email nem return_url para mobile money', () => {
    const result = chargeSchema.safeParse(baseMobile);
    expect(result.success).toBe(true);
  });

  it('rejeita currency ZAR fora de payfast', () => {
    const result = chargeSchema.safeParse({ ...baseMobile, currency: 'ZAR' });
    expect(result.success).toBe(false);
  });
});

describe('chargeSchema — hosted checkout (visa_mastercard/payfast)', () => {
  it('aceita um pedido válido de visa_mastercard', () => {
    const result = chargeSchema.safeParse(baseCheckout);
    expect(result.success).toBe(true);
  });

  it('rejeita visa_mastercard sem payer_email', () => {
    const { payer_email, ...rest } = baseCheckout;
    const result = chargeSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'payer_email')).toBe(true);
    }
  });

  it('rejeita visa_mastercard sem return_url', () => {
    const { return_url, ...rest } = baseCheckout;
    const result = chargeSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'return_url')).toBe(true);
    }
  });

  it('não exige payer_phone para visa_mastercard', () => {
    const result = chargeSchema.safeParse(baseCheckout);
    expect(result.success).toBe(true);
  });

  it('rejeita payfast sem currency ZAR', () => {
    const result = chargeSchema.safeParse({
      ...baseCheckout,
      method: 'payfast',
      amount: 50,
      currency: 'MZN'
    });
    expect(result.success).toBe(false);
  });

  it('aceita payfast com currency ZAR e amount >= 5', () => {
    const result = chargeSchema.safeParse({
      ...baseCheckout,
      method: 'payfast',
      amount: 5,
      currency: 'ZAR'
    });
    expect(result.success).toBe(true);
  });

  it('rejeita payfast abaixo do mínimo de 5 ZAR', () => {
    const result = chargeSchema.safeParse({
      ...baseCheckout,
      method: 'payfast',
      amount: 4.99,
      currency: 'ZAR'
    });
    expect(result.success).toBe(false);
  });

  it('rejeita email inválido', () => {
    const result = chargeSchema.safeParse({ ...baseCheckout, payer_email: 'não-é-email' });
    expect(result.success).toBe(false);
  });

  it('rejeita return_url que não é um URL', () => {
    const result = chargeSchema.safeParse({ ...baseCheckout, return_url: 'não-é-url' });
    expect(result.success).toBe(false);
  });
});

describe('chargeSchema — campos comuns', () => {
  it('rejeita reference vazia', () => {
    const result = chargeSchema.safeParse({ ...baseMobile, reference: '' });
    expect(result.success).toBe(false);
  });

  it('rejeita amount negativo ou zero', () => {
    expect(chargeSchema.safeParse({ ...baseMobile, amount: 0 }).success).toBe(false);
    expect(chargeSchema.safeParse({ ...baseMobile, amount: -10 }).success).toBe(false);
  });

  it('rejeita method desconhecido', () => {
    const result = chargeSchema.safeParse({ ...baseMobile, method: 'bitcoin' });
    expect(result.success).toBe(false);
  });

  it('aceita metadata arbitrária opcional', () => {
    const result = chargeSchema.safeParse({ ...baseMobile, metadata: { pedido_id: '123' } });
    expect(result.success).toBe(true);
  });
});

describe('formatAmount', () => {
  it('formata com 2 casas decimais', () => {
    expect(formatAmount(10)).toBe('10.00');
    expect(formatAmount(10.5)).toBe('10.50');
    expect(formatAmount(10.999)).toBe('11.00');
  });
});

describe('smsSchema', () => {
  it('aceita um número E.164 válido', () => {
    expect(smsSchema.safeParse({ to: '+258840000000', message: 'olá' }).success).toBe(true);
  });

  it('rejeita número sem +', () => {
    expect(smsSchema.safeParse({ to: '258840000000', message: 'olá' }).success).toBe(false);
  });

  it('rejeita mensagem vazia', () => {
    expect(smsSchema.safeParse({ to: '+258840000000', message: '' }).success).toBe(false);
  });
});

describe('pushSchema', () => {
  it('aceita título e corpo válidos', () => {
    expect(pushSchema.safeParse({ title: 'Título', body: 'Corpo' }).success).toBe(true);
  });

  it('rejeita título vazio', () => {
    expect(pushSchema.safeParse({ title: '', body: 'Corpo' }).success).toBe(false);
  });
});
