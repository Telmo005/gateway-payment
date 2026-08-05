import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { messages, type Message } from '@/db/messages';

const SOURCE_APP = 'gateway';

// Insere em `messages` (channel='sms'); o celular-gateway envia o SMS real.
export async function sendSms(to: string, message: string): Promise<Message> {
  const [row] = await db
    .insert(messages)
    .values({ channel: 'sms', toNumber: to, body: message, sourceApp: SOURCE_APP })
    .returning();
  return row;
}

// Insere em `messages` (channel='push'); o celular-gateway só mostra a notificação.
export async function sendPush(title: string, body: string): Promise<Message> {
  const [row] = await db
    .insert(messages)
    .values({ channel: 'push', title, body, sourceApp: SOURCE_APP })
    .returning();
  return row;
}

export async function getMessageStatus(id: string): Promise<Message | undefined> {
  const [row] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
  return row;
}
