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
  constructor(message: string, public readonly details?: unknown) {
    super(message);
  }
}
