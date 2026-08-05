import { z } from 'zod';

// Corpo do POST /v1/charges vindo de um app.
export const chargeSchema = z.object({
  // A referência própria do app — chave de idempotência do lado dele.
  reference: z.string().min(1).max(80),
  amount: z.number().positive().max(10_000_000),
  currency: z.string().length(3).default('MZN'),
  method: z.enum(['mpesa', 'emola', 'credit_card']),
  description: z.string().max(255).optional(),
  // Para onde o PaySuite redireciona o utilizador após pagar.
  return_url: z.string().url().optional(),
  // Metadados leves ecoados no fan-out (NÃO metas payloads pesados aqui).
  metadata: z.record(z.string(), z.unknown()).optional()
});

export type ChargeInput = z.infer<typeof chargeSchema>;

// Formata um número para o formato de montante do PaySuite ('10.00').
export function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

// Corpo do POST /api/internal/messages/sms.
// Formato internacional (E.164): '+' seguido de 7 a 15 dígitos, ex: +258840000000.
const phoneRegex = /^\+[1-9]\d{6,14}$/;

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
