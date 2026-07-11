// O PaySuite exige que a `reference` só tenha letras e números (422 em
// produção: "The Reference field must only contain letters and numbers").
// Sanitizamos defensivamente para nenhum prefixo futuro reintroduzir símbolos.
export function generateReference(appPrefix: string): string {
  const safePrefix = appPrefix.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const timestamp = Date.now().toString();
  const random = Math.random().toString(36).slice(2, 8).replace(/[^a-zA-Z0-9]/g, '');
  return `${safePrefix}${timestamp}${random}`;
}
