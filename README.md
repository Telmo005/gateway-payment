# PayGate — orquestrador central de pagamentos PaySuite

Um único serviço que é o **dono exclusivo** da conta PaySuite (1 token de API,
1 webhook secret, 1 webhook URL). Todos os teus apps — Invoice Hub Pro, bShare,
Duelo e futuros — falam com este gateway e nunca com o PaySuite diretamente.

Resolve a limitação "o PaySuite só deixa configurar **um** webhook": esse
webhook passa a ser deste serviço, e o gateway **reencaminha** cada evento para
o app dono do pagamento.

```
  Invoice Hub ─┐
  bShare      ─┼─► PayGate ──► PaySuite (charge)
  Duelo       ─┘   (pay.teudominio.com)
                        ▲
   PaySuite webhook ────┘   (1 só URL)
                        │
                        └─► fan-out assinado por app ─► /callback de cada app
```

## Porque é a melhor prática

- **1 webhook, N apps.** O gateway define sempre `callback_url` = ele próprio.
- **Blast radius isolado.** O token/secret do PaySuite nunca saem do gateway.
  Cada app só conhece o *seu* `callback_secret`.
- **Ledger unificado.** Todas as transacções de todos os apps numa só tabela —
  reconciliação e auditoria centralizadas.
- **Reconciliação + retry centralizados.** Feito uma vez, não em cada app.
- **Trocar de gateway no futuro** = mudar um serviço, não três apps.

---

## Setup (uma vez)

### 1. Base de dados própria (Supabase novo, isolado dos apps)

Cria um projeto Supabase **só para o gateway**. Depois:

```bash
cp .env.example .env
# preenche DATABASE_URL, PAYSUITE_*, PUBLIC_BASE_URL, CRON_SECRET
npm install
npm run db:push          # cria as tabelas (ou cola drizzle/0000_init.sql no SQL Editor)
```

### 2. Deploy (Vercel, projeto separado)

- Faz deploy desta pasta como um **novo** projeto Vercel.
- Domínio recomendado: `pay.teudominio.com`.
- Mete as mesmas env vars no Vercel.
- Os crons em `vercel.json` (reconciliação + retry) ativam-se automaticamente.

### 3. Aponta o PaySuite para o gateway

No dashboard do PaySuite, define o webhook para:

```
https://pay.teudominio.com/api/webhooks/paysuite
```

Este é agora o **único** webhook. O do Invoice Hub deixa de ser usado.

### 4. Regista cada app

```bash
npm run app:register -- --slug=invoice-hub --name="Invoice Hub Pro" \
  --callback="https://invoice-hub-pro.vercel.app/api/payments/webhook/paygate" \
  --prefix=IHP
```

Isto imprime **uma vez** a `PAYGATE_API_KEY` e o `PAYGATE_CALLBACK_SECRET` desse
app. Guarda-os — não são recuperáveis. Repete para `bshare`, `duelo`, etc.

---

## Como cada app integra (mudança pequena)

1. Copia `sdk/paygate-client.ts` para o app (ex.: `src/lib/payments/paygate-client.ts`).
2. Mete no ambiente do app:
   ```
   PAYGATE_BASE_URL=https://pay.teudominio.com
   PAYGATE_API_KEY=pk_...              # do register-app
   PAYGATE_CALLBACK_SECRET=...         # do register-app
   ```
3. **Checkout:** troca a chamada direta ao PaySuite por `paygate.createCharge(...)`
   e guarda `gatewayPaymentId` em `external_id`. Ver `examples/app-checkout.example.ts`.
4. **Webhook:** monta `POST /api/payments/webhook/paygate` que verifica com
   `PAYGATE_CALLBACK_SECRET` e header `x-paygate-signature`. A estrutura é igual
   à do webhook atual. Ver `examples/app-callback-route.example.ts`.

> No Invoice Hub, os segredos `PAYSUITE_*` podem ser **removidos** do app depois
> da migração — passam a viver só no gateway.

---

## API

### `POST /api/v1/charges`  (auth: `Bearer <PAYGATE_API_KEY>`)

```jsonc
// pedido
{ "reference": "IHP-123", "amount": 10, "method": "mpesa",
  "description": "Documento", "return_url": "https://.../success",
  "metadata": { "tipo": "fatura" } }

// resposta
{ "gateway_payment_id": "uuid", "reference": "IHP-123",
  "status": "pending", "checkout_url": "https://paysuite.../checkout/..." }
```

`reference` é idempotente por app — repetir devolve a transacção existente.

### `GET /api/v1/charges/{gateway_payment_id}`  (auth: `Bearer`)

Consulta de estado (fallback/polling).

### `POST /api/webhooks/paysuite`

Webhook único do PaySuite (não chamar manualmente).

### Crons (auth: `Bearer <CRON_SECRET>`)

- `POST /api/internal/reconcile` — poll de transacções pendentes (rede de segurança).
- `POST /api/internal/deliveries/retry` — reenvio de fan-outs falhados.

---

## Webhook que os apps recebem

```jsonc
{
  "type": "payment.success",           // ou "payment.failed"
  "created_at": "2026-07-11T...",
  "data": {
    "gateway_payment_id": "uuid",
    "reference": "IHP-123",            // a referência do PRÓPRIO app
    "amount": 10, "currency": "MZN", "method": "mpesa",
    "status": "success", "paid_at": "2026-07-11T...",
    "metadata": { "tipo": "fatura" }
  }
}
```

Assinado com `X-Paygate-Signature: <hmac_sha256_hex>` sobre o corpo cru, usando
o `callback_secret` do app. Verifica **sempre** antes de processar.

---

## Modelo de dados

- `apps` — tenants registados (api key hash + callback secret + prefixo).
- `transactions` — ledger canónico de todas as cobranças.
- `provider_events` — webhooks crus do PaySuite (idempotência por `request_id`).
- `webhook_deliveries` — fila de reenvio para os apps, com retry + backoff.

## Garantias

- **Idempotência PaySuite→gateway:** por `request_id` (reentrega até 5x).
- **Idempotência criação de cobrança:** por `(app_id, app_reference)`.
- **Sem fan-out duplicado:** UPDATE condicional no `WHERE` (`status` só transita
  uma vez para `success`/`failed`).
- **Entrega garantida ao app:** retry com backoff exponencial (30s → ~1h, 8x).
- **Rede de segurança:** cron de reconciliação faz poll ao PaySuite.
