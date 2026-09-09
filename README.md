# PayGate — gateway central de pagamentos (Debito Pay) e notificações

Um único serviço (nome interno do pacote: `gateway`) que é o **dono
exclusivo** das credenciais Debito Pay (API key, merchant id, wallet codes) e
também o ponto único para disparar SMS/push reais via o celular-gateway
Android. Todos os teus apps — Invoice Hub Pro, bShare, Duelo e futuros —
falam com este gateway e nunca com o provider de pagamento diretamente.

> **Migração PaySuite → MozPayment → Debito Pay (2026-09):** o provider
> activo agora é a [Debito Pay](https://debitopay.com/developers/payments-api/)
> (`src/lib/debitopay.ts`), com 5 métodos: `mpesa`, `emola`, `mkesh`,
> `visa_mastercard`, `payfast`. `src/lib/paysuite.ts` e
> `POST /api/webhooks/paysuite` ficam **dormentes** (não apagados — só sem
> tráfego novo), mantidos apenas para eventuais transacções PaySuite antigas
> ainda `pending`. Diferença fundamental vs. o MozPayment que passou por aqui
> brevemente: a Debito Pay volta a ter fluxo **assíncrono** para a maioria dos
> métodos — `POST /api/webhooks/debitopay` e `POST /api/internal/reconcile`
> estão **activos** de novo. Só `mpesa` confirma síncrono na resposta do
> `POST`. Ver secção API abaixo.

> Nota sobre o nome: o pacote (`package.json`) e o `source_app` gravado nas
> mensagens passaram a ser `gateway`. O nome de marca "PayGate" foi mantido
> no contrato público já usado pelos apps integrados (env vars
> `PAYGATE_API_KEY`/`PAYGATE_CALLBACK_SECRET`, header
> `X-Paygate-Signature`) — renomear isso quebraria a integração já feita com
> bShare, Duelo e Invoice Hub Pro.

Um único ponto de integração para todos os apps: eles falam sempre com este
gateway, nunca directamente com a Debito Pay — API key e merchant id nunca
saem daqui.

```
  Invoice Hub ─┐
  bShare      ─┼─► PayGate ──► Debito Pay (mpesa: síncrono | outros: webhook)
  Duelo       ─┘   (pay.teudominio.com)      │
                        │                    └─► POST /api/webhooks/debitopay
                        └─► fan-out assinado por app ─► /callback de cada app
                              (mpesa dispara já na resposta do POST /v1/charges;
                               os restantes, quando o webhook confirmar)
```

## Porque é a melhor prática

- **1 ponto de integração, N apps.** Nenhum app fala com a Debito Pay
  directamente.
- **Blast radius isolado.** A API key/merchant id da Debito Pay nunca saem do
  gateway. Cada app só conhece o *seu* `callback_secret`.
- **Ledger unificado.** Todas as transacções de todos os apps numa só tabela —
  auditoria centralizada.
- **Retry de fan-out centralizado.** Feito uma vez, não em cada app.
- **Trocar de provider no futuro** = mudar um adaptador aqui (já aconteceu
  duas vezes — PaySuite → MozPayment → Debito Pay), não três apps.

---

## Setup (uma vez)

### 1. Base de dados própria (Supabase novo, isolado dos apps)

Cria um projeto Supabase **só para o gateway**. Depois:

```bash
cp .env.example .env
# preenche DATABASE_URL, CRON_SECRET, e as DEBITOPAY_*:
#   DEBITOPAY_API_KEY, DEBITOPAY_MERCHANT_ID,
#   DEBITOPAY_WALLET_CODE_MPESA, _EMOLA, _MKESH, _VISA_MASTERCARD, _PAYFAST
#   DEBITOPAY_WEBHOOK_SECRET
# (PAYSUITE_* fica legado — só necessário se ainda houver transacções
# antigas 'pending' para reconciliar via o webhook dormente)
npm install
npm run db:push          # cria as tabelas (ou cola drizzle/*.sql no SQL Editor)
```

No painel da Debito Pay, configura o webhook (Settings → Webhooks) para
`https://<domínio do deploy>/api/webhooks/debitopay` — é assim que
`emola`/`mkesh`/`visa_mastercard`/`payfast` confirmam. Só `mpesa` dispensa
isto (confirma já na resposta do `POST /v1/charges`).

### 2. Deploy (Vercel, projeto separado)

- Faz deploy desta pasta como um **novo** projeto Vercel.
- Domínio recomendado: `pay.teudominio.com`.
- Mete as mesmas env vars no Vercel.
- Os crons em `vercel.json` estão desactivados (limite do plano Hobby) — se
  precisares de `/api/internal/deliveries/retry`, agenda-o externamente
  (ex.: cron-job.org) chamando com `Authorization: Bearer <CRON_SECRET>`.

### 3. Regista cada app

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
3. **Cobrança:** troca a chamada direta ao provider por `paygate.createCharge(...)`.
   `payerPhone` é **obrigatório** para `mpesa`/`emola`/`mkesh`; `payerEmail` +
   `returnUrl` são **obrigatórios** para `visa_mastercard`/`payfast`. Guarda
   `gatewayPaymentId` em `external_id`. Só `mpesa` já vem `'success'`/`'failed'`
   nesta resposta — os restantes nascem `'pending'`: para cartão/payfast,
   redirecciona o utilizador para `checkoutUrl`; para os demais, espera o
   callback. Ver `examples/app-checkout.example.ts`.
4. **Webhook:** monta `POST /api/payments/webhook/paygate` que verifica com
   `PAYGATE_CALLBACK_SECRET` e header `x-paygate-signature`. A estrutura é igual
   à do webhook atual (isto não mudou com a migração — o fan-out gateway→app
   continua o mesmo, só mudou como o gateway aprende o resultado do
   pagamento). Ver `examples/app-callback-route.example.ts`.

> Nos apps clientes, os segredos `PAYSUITE_*`/`MOZPAYMENT_*`/Debito Pay podem
> ser **removidos** — passam a viver só no gateway.

---

## API

### `POST /api/v1/charges`  (auth: `Bearer <PAYGATE_API_KEY>`)

`method` aceita `'mpesa' | 'emola' | 'mkesh' | 'visa_mastercard' | 'payfast'`.
`mpesa` confirma já na resposta; os restantes nascem `'pending'` (cartão/
payfast trazem `checkout_url` para redireccionar o utilizador).

```jsonc
// pedido — mobile money
{ "reference": "IHP-123", "amount": 150, "method": "mpesa",
  "payer_phone": "+258840000000", "payer_name": "João Silva",
  "description": "Documento", "metadata": { "tipo": "fatura" } }

// resposta (mpesa, síncrono)
{ "gateway_payment_id": "uuid", "reference": "IHP-123",
  "status": "success", "message": "Pagamento processado", "checkout_url": null }

// resposta (falha — ex.: saldo insuficiente, número inválido)
{ "gateway_payment_id": "uuid", "reference": "IHP-123",
  "status": "failed", "message": "Saldo insuficiente", "checkout_url": null }

// pedido — cartão / payfast (Hosted Checkout)
{ "reference": "IHP-124", "amount": 500, "method": "visa_mastercard",
  "payer_name": "João Silva", "payer_email": "joao@example.com",
  "return_url": "https://meuapp.com/checkout/resultado" }

// resposta (pending — redirecciona o utilizador para checkout_url)
{ "gateway_payment_id": "uuid", "reference": "IHP-124",
  "status": "pending", "message": null,
  "checkout_url": "https://debitopay.com/checkout/card?..." }
```

`reference` é idempotente por app — repetir devolve a transacção existente
(mesma resposta, com `idempotent_replay: true`).

### `GET /api/v1/charges/{gateway_payment_id}`  (auth: `Bearer`)

Consulta de estado. Útil sobretudo para *polling* de uma cobrança ainda
`pending` quando o webhook ainda não chegou.

### `POST /api/webhooks/debitopay`

Webhook único da Debito Pay — confirma `emola`/`mkesh`/`visa_mastercard`/
`payfast`. Verificado por HMAC-SHA256 (header `x-webhook-signature`,
`DEBITOPAY_WEBHOOK_SECRET`); configurar no painel Debito Pay em
Settings → Webhooks.

`POST /api/webhooks/paysuite` fica **legado/dormente** — só relevante para
transacções PaySuite antigas ainda `pending`.

### Crons (auth: `Bearer <CRON_SECRET>`)

- `POST /api/internal/reconcile` — poll à Debito Pay para transacções
  `pending` há mais de 5min (rede de segurança contra webhooks perdidos).
- `POST /api/internal/deliveries/retry` — reenvio de fan-outs falhados.
  Continua activo (não depende do provider de pagamento).

### Mensagens — SMS / push (auth: `Bearer <CRON_SECRET>`, uso interno)

Insere linhas na tabela `messages` (partilhada com o celular-gateway Android
já existente, que faz o envio real — não é gerido por este projeto).

```jsonc
// POST /api/internal/messages/sms
{ "to": "+258840000000", "message": "texto do SMS" }
// -> { "id": "uuid", "status": "PENDING" }

// POST /api/internal/messages/push
{ "title": "Título", "body": "texto da notificação" }
// -> { "id": "uuid", "status": "PENDING" }

// GET /api/internal/messages/{id}
// -> { "id", "channel", "status", "sent_at", "delivered_at", "seen_at", "error" }
```

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
- `provider_events` — webhooks crus da Debito Pay (idempotência por
  `request_id` sintético, sha256 do corpo — ver `src/lib/debitopay.ts`).
  Também guarda os webhooks (legados) do PaySuite.
- `webhook_deliveries` — fila de reenvio para os apps, com retry + backoff.
- `error_logs` — log persistente de erros de servidor (ver `src/lib/errorLog.ts`).
- `messages` — **não pertence a este projeto** (fora das migrations, ver
  `src/db/messages.ts`); é a fila do celular-gateway Android (SMS/push).

## Garantias

- **Idempotência criação de cobrança:** por `(app_id, app_reference)` — vale
  para qualquer provider.
- **Sem fan-out duplicado:** UPDATE condicional no `WHERE` (`status` só transita
  uma vez para `success`/`failed`).
- **Entrega garantida ao app:** retry com backoff exponencial (30s → ~1h, 8x),
  isolado por entrega (uma falha não aborta o lote do cron).
- **Notificação push em todo pagamento:** sucesso ou falha, best-effort (ver
  `notifyPayment` em `src/lib/fanout.ts`).
- **Idempotência Debito Pay→gateway:** por `request_id` sintético (sha256 do
  corpo cru — a doc não expõe um id de evento próprio); dedup desfeito se o
  processamento falhar, para a próxima reentrega reprocessar de verdade (ver
  `webhooks/debitopay`). **Rede de segurança:** cron de reconciliação faz poll
  à Debito Pay para `pending` esquecidos.
