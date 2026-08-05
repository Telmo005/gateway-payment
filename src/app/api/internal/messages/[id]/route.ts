import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeCron } from '@/lib/auth';
import { getMessageStatus } from '@/lib/messaging';
import { ApiError } from '@/lib/errors';
import { logError } from '@/lib/errorLog';

export const runtime = 'nodejs';

const idSchema = z.string().uuid();

// GET /api/internal/messages/{id} — consulta o estado de uma mensagem
// (sms ou push) já enviada para a fila.
// Auth: Authorization: Bearer CRON_SECRET.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    authorizeCron(request);
    const { id } = await params;

    if (!idSchema.safeParse(id).success) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Id inválido');
    }

    const row = await getMessageStatus(id);
    if (!row) {
      throw new ApiError(404, 'NOT_FOUND', 'Mensagem não encontrada');
    }

    return NextResponse.json({
      id: row.id,
      channel: row.channel,
      status: row.status,
      sent_at: row.sentAt ? row.sentAt.toISOString() : null,
      delivered_at: row.deliveredAt ? row.deliveredAt.toISOString() : null,
      seen_at: row.seenAt ? row.seenAt.toISOString() : null,
      error: row.error
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status });
    }
    await logError('internal.messages.get', err);
    return NextResponse.json({ error: { code: 'GATEWAY_ERROR', message: 'Erro interno' } }, { status: 500 });
  }
}
