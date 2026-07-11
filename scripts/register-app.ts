/**
 * Regista um novo app cliente no gateway e imprime os segredos UMA vez.
 *
 * Uso:
 *   tsx scripts/register-app.ts --slug=invoice-hub --name="Invoice Hub Pro" \
 *     --callback="https://invoice-hub-pro.vercel.app/api/payments/webhook/paygate" \
 *     --prefix=IHP
 *
 * Guarda o output num sítio seguro — a API key e o callback secret NÃO são
 * recuperáveis depois (guardamos só o hash da key).
 *
 * DATABASE_URL é carregado via `tsx --env-file=.env` (ver script npm).
 */
import { db } from '../src/db/client';
import { apps } from '../src/db/schema';
import { generateApiKey, generateSecret } from '../src/lib/crypto';
import { eq } from 'drizzle-orm';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=').slice(1).join('=');
}

async function main() {
  const slug = arg('slug');
  const name = arg('name');
  const callbackUrl = arg('callback');
  const referencePrefix = (arg('prefix') || slug || 'APP').toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (!slug || !name || !callbackUrl) {
    console.error('Faltam argumentos. Precisas de --slug, --name e --callback.');
    process.exit(1);
  }

  const existing = await db.select().from(apps).where(eq(apps.slug, slug)).limit(1);
  if (existing.length > 0) {
    console.error(`Já existe um app com slug "${slug}".`);
    process.exit(1);
  }

  const apiKey = generateApiKey();
  const callbackSecret = generateSecret();

  await db.insert(apps).values({
    slug,
    name,
    apiKeyHash: apiKey.hash,
    apiKeyPrefix: apiKey.prefix,
    callbackUrl,
    callbackSecret,
    referencePrefix
  });

  console.log('\n App registado com sucesso.\n');
  console.log('  slug             :', slug);
  console.log('  reference prefix :', referencePrefix);
  console.log('  callback_url     :', callbackUrl);
  console.log('\n  >>> GUARDA ISTO AGORA (não é recuperável) <<<\n');
  console.log('  PAYGATE_API_KEY        =', apiKey.key);
  console.log('  PAYGATE_CALLBACK_SECRET =', callbackSecret);
  console.log('\n  Mete estas duas variáveis no ambiente do app "' + slug + '".\n');

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
