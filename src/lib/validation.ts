import { z } from 'zod';
import { MIN_AMOUNT, MOBILE_MONEY_METHODS, HOSTED_CHECKOUT_METHODS, type PaymentMethod } from './debitopay';

// Formato internacional (E.164): '+' seguido de 7 a 15 dígitos, ex: +258840000000.
// Usado tanto pelo charges quanto pelo messages/sms — mantém um único padrão
// de telefone em toda a API pública deste gateway.
const phoneRegex = /^\+[1-9]\d{6,14}$/;

const mobileSet = new Set<PaymentMethod>(MOBILE_MONEY_METHODS);
const checkoutSet = new Set<PaymentMethod>(HOSTED_CHECKOUT_METHODS);

// Corpo do POST /v1/charges vindo de um app.
// Debito Pay expõe 5 métodos com dois fluxos distintos:
//  - mobile money (mpesa/emola/mkesh): exige payer_phone; mpesa confirma
//    síncrono, emola/mkesh ficam 'pending' até webhook.
//  - hosted checkout (visa_mastercard/payfast): exige payer_email + return_url
//    para o gateway devolver `checkout_url` e redireccionar o pagador;
//    payfast exige currency ZAR (os restantes, MZN).
export const chargeSchema = z
  .object({
    // A referência própria do app — chave de idempotência do lado dele.
    reference: z.string().min(1).max(80),
    amount: z.number().positive().max(10_000_000),
    currency: z.enum(['MZN', 'ZAR']).default('MZN'),
    method: z.enum(['mpesa', 'emola', 'mkesh', 'visa_mastercard', 'payfast']),
    payer_phone: z
      .string()
      .regex(phoneRegex, 'Número de telefone inválido (use formato internacional, ex: +258840000000)')
      .optional(),
    payer_name: z.string().min(1).max(120),
    payer_email: z.string().email('Email inválido').optional(),
    // Para onde a Debito Pay devolve o pagador depois do Hosted Checkout
    // (visa_mastercard/payfast). Sem página de checkout, os restantes métodos
    // não usam isto.
    return_url: z.string().url('return_url inválido').optional(),
    description: z.string().max(255).optional(),
    // Metadados leves ecoados no fan-out (NÃO metas payloads pesados aqui).
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .superRefine((data, ctx) => {
    const method = data.method as PaymentMethod;

    if (mobileSet.has(method) && !data.payer_phone) {
      ctx.addIssue({ code: 'custom', path: ['payer_phone'], message: `payer_phone é obrigatório para ${method}` });
    }
    if (checkoutSet.has(method)) {
      if (!data.payer_email) {
        ctx.addIssue({ code: 'custom', path: ['payer_email'], message: `payer_email é obrigatório para ${method}` });
      }
      if (!data.return_url) {
        ctx.addIssue({ code: 'custom', path: ['return_url'], message: `return_url é obrigatório para ${method}` });
      }
    }
    if (method === 'payfast' && data.currency !== 'ZAR') {
      ctx.addIssue({ code: 'custom', path: ['currency'], message: 'payfast exige currency ZAR' });
    }
    if (method !== 'payfast' && data.currency === 'ZAR') {
      ctx.addIssue({ code: 'custom', path: ['currency'], message: 'currency ZAR só é suportada com method payfast' });
    }

    const min = MIN_AMOUNT[method];
    if (data.amount < min) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: `valor mínimo para ${method} é ${min} ${data.currency}` });
    }
  });

export type ChargeInput = z.infer<typeof chargeSchema>;

// Formata um montante para armazenamento em `transactions.amount` (numeric(12,2)).
export function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

export const smsSchema = z.object({
  to: z.string().regex(phoneRegex, 'Número de telefone inválido (use formato internacional, ex: +258840000000)'),
  message: z.string().min(1).max(1000)
});

export type SmsInput = z.infer<typeof smsSchema>;

// Corpo do POST /api/internal/messages/push.
export const pushSchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(500)
});

export type PushInput = z.infer<typeof pushSchema>;
