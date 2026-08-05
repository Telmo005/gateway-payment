import { db } from '@/db/client';
import { errorLogs } from '@/db/schema';

// Regista um erro de servidor em `error_logs`, além do console. Best-effort:
// uma falha ao gravar nunca deve mascarar o erro original nem derrubar o
// request que o originou — por isso o erro de logging é só logado, não
// relançado.
export async function logError(
  source: string,
  err: unknown,
  details?: Record<string, unknown>
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === 'object' && 'code' in err ? String((err as any).code) : undefined;
  const stack = err instanceof Error ? err.stack : undefined;

  // ProviderError (e outros erros com .details, ex.: httpStatus/body do
  // PaySuite) carrega o contexto real da falha — captura automaticamente se
  // o chamador não passou `details` explícito, senão essa informação perde-se.
  const errDetails =
    err && typeof err === 'object' && 'details' in err
      ? ((err as any).details as unknown)
      : undefined;
  const finalDetails =
    details ?? (errDetails && typeof errDetails === 'object' ? (errDetails as Record<string, unknown>) : undefined);

  console.error(`[${source}]`, err);

  try {
    await db.insert(errorLogs).values({ source, code, message, details: finalDetails, stack });
  } catch (loggingErr) {
    console.error(`[errorLog] falha ao gravar error_log de "${source}":`, loggingErr);
  }
}
