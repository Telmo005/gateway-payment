// Erro tipado para respostas de API consistentes.
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
    // Motivo de negócio devolvido pelo provider em linguagem natural (ex.:
    // "O pagamento foi recusado pelo operador."), seguro para reenviar ao
    // app chamador — ao contrário de códigos internos (WALLET_CODE_NOT_FOUND,
    // INVALID_API_KEY), que nunca devem sair daqui.
    public readonly userMessage?: string
  ) {
    super(message);
  }
}
