# Gateway — referência de endpoints

Este serviço (`package.json` name: `gateway`, nome de marca "PayGate") é o
ponto único para:

1. **Pagamentos** — cobranças via PaySuite (m-Pesa, e-Mola, cartão).
2. **Mensagens** — SMS real e notificações push, via o celular-gateway
   Android já existente (insere linhas em `messages`; o celular processa em
   ~15s e reporta o estado de volta).

Base URL:

| Ambiente | URL |
|---|---|
| Local (dev) | `http://localhost:4000` |
| Produção | `https://<domínio do deploy>` (definir em `PUBLIC_BASE_URL`) |

Todas as respostas de erro seguem o mesmo formato:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": { } } }
```

---

## 1. Pagamentos

### `POST /api/v1/charges`

Auth: `Authorization: Bearer <PAYGATE_API_KEY>` (chave por app, dada no
`npm run app:register`).

```jsonc
// pedido
{
  "reference": "IHP-123",       // referência própria do app (idempotente)
  "amount": 10,
  "method": "mpesa",            // 'mpesa' | 'emola' | 'credit_card'
  "currency": "MZN",            // opcional, default MZN
  "description": "Documento",   // opcional
  "return_url": "https://.../success", // opcional
  "metadata": { "tipo": "fatura" }      // opcional, ecoado no fan-out
}

// resposta
{
  "gateway_payment_id": "uuid",
  "reference": "IHP-123",
  "status": "pending",
  "checkout_url": "https://paysuite.../checkout/..."
}
```

Repetir o mesmo `reference` para o mesmo app devolve a transacção já criada
(`idempotent_replay: true`), sem cobrar de novo.

### `GET /api/v1/charges/{gateway_payment_id}`

Auth: `Authorization: Bearer <PAYGATE_API_KEY>`. Consulta de estado
(fallback/polling — o normal é receber o webhook, ver abaixo).

```jsonc
{
  "gateway_payment_id": "uuid",
  "reference": "IHP-123",
  "status": "pending",   // 'pending' | 'success' | 'failed'
  "amount": 10,
  "currency": "MZN",
  "method": "mpesa",
  "paid_at": null,
  "metadata": { "tipo": "fatura" }
}
```

### Webhook que o seu app recebe

`POST` para o `callback_url` registado, assinado com o `callback_secret` do
app (header `X-Paygate-Signature`, HMAC-SHA256 sobre o corpo cru — **verificar
sempre** antes de processar):

```jsonc
{
  "type": "payment.success",     // ou "payment.failed"
  "created_at": "2026-08-05T...",
  "data": {
    "gateway_payment_id": "uuid",
    "reference": "IHP-123",
    "amount": 10, "currency": "MZN", "method": "mpesa",
    "status": "success", "paid_at": "2026-08-05T...",
    "metadata": { "tipo": "fatura" }
  }
}
```

---

## 2. Mensagens (SMS e push)

Auth: `Authorization: Bearer <CRON_SECRET>` — **uso interno**, chamado só
pelo próprio backend do gateway (ou por um app de confiança rodando no seu
próprio servidor). Não é uma chave por-app como a de pagamentos.

### `POST /api/internal/messages/sms` — enviar SMS real

```jsonc
// pedido
{ "to": "+258840000000", "message": "texto do SMS" }

// resposta
{ "id": "uuid", "status": "PENDING" }
```

- `to`: formato internacional E.164 (`+` seguido de 7 a 15 dígitos).
  Rejeitado com `400 VALIDATION_ERROR` se não bater com o padrão.
- `message`: 1 a 1000 caracteres.
- O celular-gateway apanha a linha em ~15s e envia o SMS de verdade
  (cobrado pela operadora).

### `POST /api/internal/messages/push` — mostrar notificação

```jsonc
// pedido
{ "title": "Título", "body": "texto da notificação" }

// resposta
{ "id": "uuid", "status": "PENDING" }
```

- `title`: 1 a 120 caracteres.
- `body`: 1 a 500 caracteres.
- Não envia SMS — só aparece como notificação Android no celular-gateway.

### `GET /api/internal/messages/{id}` — consultar estado

```jsonc
{
  "id": "uuid",
  "channel": "sms",          // ou "push"
  "status": "SENT",          // PENDING -> CLAIMED -> SENT/DELIVERED/SEEN/FAILED
  "sent_at": "2026-08-05T...",
  "delivered_at": null,
  "seen_at": null,
  "error": null
}
```

### Notificação automática de pagamentos

Todo pagamento processado por este gateway (sucesso **ou** falha) já dispara
automaticamente um push — não precisa chamar `/messages/push` manualmente
para isso (ver `notifyPayment` em `src/lib/fanout.ts`). Os endpoints de
mensagens acima são para disparos **adicionais**, fora do fluxo de pagamento.

---

## 3. Erros e observabilidade

- Erros de servidor (5xx e falhas inesperadas) ficam gravados na tabela
  `error_logs` (`source`, `code`, `message`, `details`, `stack`,
  `created_at`) — útil para depurar em produção sem depender só dos logs do
  Vercel.
- Erros de validação/autenticação (4xx) **não** são gravados ali — são erros
  esperados do lado de quem chama.

## 4. Ferramentas de teste

Collection do Bruno pronta em `bruno/paygate-messages/` (cobre os 3
endpoints de mensagens). Importar e preencher a variável secreta
`cronSecret` no ambiente `local`.
