import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { apps, type App } from '@/db/schema';
import { sha256 } from './crypto';
import { ApiError } from './errors';

// Autentica um app pela sua chave de API (Bearer). Procura pelo hash — a
// chave em claro nunca é guardada. Rejeita apps inativos.
export async function authenticateApp(request: Request): Promise<App> {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Authorization Bearer em falta');
  }

  const apiKey = match[1].trim();
  const hash = sha256(apiKey);

  const [app] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.apiKeyHash, hash), eq(apps.active, true)))
    .limit(1);

  if (!app) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Chave de API inválida ou app inativo');
  }

  return app;
}

// Guarda para as rotas de cron (reconciliação, retry). Bearer com CRON_SECRET.
export function authorizeCron(request: Request): void {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get('authorization') || '';
  const provided = header.replace(/^Bearer\s+/i, '').trim();
  if (!secret || provided !== secret) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Cron não autorizado');
  }
}
