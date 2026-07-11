import crypto from 'crypto';

// HMAC-SHA256 em hex do corpo cru. Usado tanto para verificar a assinatura
// que vem do PaySuite como para assinar o que reenviamos aos apps.
export function hmacHex(secret: string, rawBody: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

// Comparação em tempo constante e resistente a diferenças de comprimento
// (timingSafeEqual lança se os buffers têm tamanhos diferentes).
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Gera uma chave de API para um app: `pk_<32 bytes hex>`. Devolve a chave em
// claro (mostrada uma vez), o hash a persistir e um prefixo para display.
export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const raw = crypto.randomBytes(32).toString('hex');
  const key = `pk_${raw}`;
  return {
    key,
    hash: sha256(key),
    prefix: key.slice(0, 12) // ex.: 'pk_1a2b3c4d'
  };
}

export function generateSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}
