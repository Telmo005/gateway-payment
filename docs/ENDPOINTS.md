# Gateway — referência de endpoints

Este serviço (`package.json` name: `gateway`, nome de marca "PayGate") é o
ponto único para:

1. **Pagamentos** — cobranças via Debito Pay (m-Pesa, e-Mola, mKesh,
   Visa/Mastercard, PayFast ZAR). Migrado do PaySuite/MozPayment em 2026-09;
   ver nota na secção 1.
2. **Mensagens** — SMS real e notificações push, via o celular-gateway
   Android já existente (insere linhas em `messages`; o celular processa em
   ~15s e reporta o estado de volta).

Base URL:

| Ambiente | URL |
|---|---|
| Local (dev) | `http://localhost:4000` |
| Produção | `https://<domínio do deploy>` (definir em `PUBLIC_BASE_URL`) |

Variáveis de ambiente do provider de pagamento (só o backend deste gateway
precisa delas): `DEBITOPAY_API_KEY`, `DEBITOPAY_MERCHANT_ID`,
`DEBITOPAY_WEBHOOK_SECRET`, e uma carteira **por método** (o Debito Pay não
partilha carteira entre métodos, mesmo dentro da mesma moeda):
`DEBITOPAY_WALLET_CODE_MPESA`, `_EMOLA`, `_MKESH`, `_VISA_MASTERCARD`,
`_PAYFAST`. `PAYSUITE_*`/`MOZPAYMENT_*` ficam legado, sem uso.

Todas as respostas de erro seguem o mesmo formato:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": { } } }
```

---

## 1. Pagamentos

> **Debito Pay mistura síncrono e assíncrono, conforme o método.** `mpesa`
> confirma já na resposta do `POST` (`status: "success"` ou `"failed"`), como
> antes. `emola`, `mkesh`, `visa_mastercard` e `payfast` nascem
> `status: "pending"` — a confirmação chega pelo webhook. Para
> `visa_mastercard`/`payfast` a resposta também traz `checkout_url`: redirecciona
> o pagador para lá (Hosted Checkout da Debito Pay — os dados do cartão nunca
> tocam este gateway).

### `POST /api/v1/charges`

Auth: `Authorization: Bearer <PAYGATE_API_KEY>` (chave por app, dada no
`npm run app:register`).

```jsonc
// pedido — mobile money (mpesa | emola | mkesh)
{
  "reference": "IHP-123",       // referência própria do app (idempotente)
  "amount": 150,
  "method": "mpesa",            // 'mpesa' | 'emola' | 'mkesh' | 'visa_mastercard' | 'payfast'
  "payer_phone": "+258840000000", // obrigatório para mpesa/emola/mkesh, E.164
  "payer_name": "João Silva",     // obrigatório
  "currency": "MZN",            // opcional, default MZN ('ZAR' só com payfast)
  "description": "Documento",   // opcional
  "metadata": { "tipo": "fatura" }      // opcional, ecoado no fan-out
}

// pedido — cartão / payfast (Hosted Checkout)
{
  "reference": "IHP-124",
  "amount": 500,
  "method": "visa_mastercard",  // ou 'payfast' (exige currency "ZAR")
  "payer_name": "João Silva",
  "payer_email": "joao@example.com", // obrigatório para visa_mastercard/payfast
  "return_url": "https://meuapp.com/checkout/resultado", // obrigatório idem
  "currency": "MZN"
}

// resposta — mpesa (síncrono)
{
  "gateway_payment_id": "uuid",
  "reference": "IHP-123",
  "status": "success",          // ou "failed"
  "message": "Pagamento processado",
  "checkout_url": null
}

// resposta — emola/mkesh/cartão/payfast (assíncrono)
{
  "gateway_payment_id": "uuid",
  "reference": "IHP-124",
  "status": "pending",
  "message": null,
  "checkout_url": "https://debitopay.com/checkout/card?..." // null fora de cartão/payfast
}
```

Valores mínimos por método: `mpesa`/`mkesh` 10 MZN, `emola` 50 MZN,
`visa_mastercard` 50 MZN, `payfast` 10 ZAR — validado antes de chamar a
Debito Pay (`400 VALIDATION_ERROR` se abaixo do mínimo).

Repetir o mesmo `reference` para o mesmo app devolve a transacção já criada
(`idempotent_replay: true`), sem cobrar de novo.

### `GET /api/v1/charges/{gateway_payment_id}`

Auth: `Authorization: Bearer <PAYGATE_API_KEY>`. Consulta de estado —
principal uso: *polling* de uma cobrança ainda `pending` (emola/mkesh/cartão/
payfast) quando o webhook ainda não chegou.

```jsonc
{
  "gateway_payment_id": "uuid",
  "reference": "IHP-123",
  "status": "success",   // 'pending' | 'success' | 'failed'
  "amount": 10,
  "currency": "MZN",
  "method": "mpesa",
  "paid_at": "2026-08-05T...",
  "checkout_url": null,
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
