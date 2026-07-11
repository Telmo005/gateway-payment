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
