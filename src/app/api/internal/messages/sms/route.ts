import { NextResponse } from 'next/server';
import { authorizeCron } from '@/lib/auth';
import { smsSchema } from '@/lib/validation';
import { sendSms } from '@/lib/messaging';
import { ApiError } from '@/lib/errors';
import { logError } from '@/lib/errorLog';

export const runtime = 'nodejs';

// POST /api/internal/messages/sms — insere uma linha em `messages`
// (channel='sms') para o celular-gateway Android enviar um SMS real.
// Auth: Authorization: Bearer CRON_SECRET (uso interno, mesmo padrão dos
// restantes endpoints /api/internal/*).
export async function POST(request: Request) {
  try {
    authorizeCron(request);

    const body = await request.json().catch(() => null);
    const parsed = smsSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Corpo inválido', parsed.error.flatten());
    }

    const row = await sendSms(parsed.data.to, parsed.data.message);

    return NextResponse.json({ id: row.id, status: row.status });
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message, details: err.details } },
        { status: err.status }
      );
    }
    await logError('internal.messages.sms', err);
    return NextResponse.json({ error: { code: 'GATEWAY_ERROR', message: 'Erro interno' } }, { status: 500 });
  }
}
