# Prompt pronto — integrar outra app ao Gateway (SMS / push)

Como usar: copie **só a secção da funcionalidade que quer** (SMS, push, ou
as duas) lá em baixo, preencha os `[placeholders]`, e cole para a IA que
está a trabalhar no repositório da outra app. Não precisa colar tudo se só
quer uma das duas funcionalidades — elas são independentes.

Preencha antes de colar:

- `[BASE_URL]` → URL deste gateway (ex.: `https://gateway.teudominio.com`)
- `[CRON_SECRET]` → o valor de `CRON_SECRET` deste projeto (guardar como
  variável de ambiente na outra app, nunca hardcoded)
- `[EVENTO]` → o evento da outra app que deve disparar o envio (ex.: "quando
  um utilizador se regista", "quando um documento é assinado")

---

## A. Integração de SMS

```
Preciso que esta app envie SMS reais através de um gateway central já
existente (outro projeto, não mexer nele). O gateway expõe:

POST [BASE_URL]/api/internal/messages/sms
Headers:
  Authorization: Bearer [CRON_SECRET]
  Content-Type: application/json
Body:
  { "to": "+258840000000", "message": "texto do SMS" }
Resposta:
  { "id": "uuid", "status": "PENDING" }

- "to" tem de estar em formato internacional E.164 (+258... para Moçambique).
- O envio real acontece do lado do gateway em até ~15s; esta chamada só
  enfileira. Se quiser confirmar entrega depois, consulte:
  GET [BASE_URL]/api/internal/messages/{id}
  (mesmo header de auth) — devolve { status, sent_at, delivered_at, error }.
- Guarde [CRON_SECRET] como variável de ambiente do lado do servidor desta
  app (nunca no cliente/frontend, nunca em código versionado).
- Trate falhas de rede/HTTP da chamada como não-bloqueantes para o fluxo
  principal do utilizador — o SMS é um efeito colateral, não deve derrubar
  a operação principal se a chamada ao gateway falhar.

Quero que isto seja disparado [EVENTO]. Implemente uma função reutilizável
(ex.: sendSms(to, message)) e chame-a nesse ponto do fluxo, seguindo os
padrões já existentes neste projeto para chamadas a serviços externos.
```

---

## B. Integração de notificação push

```
Preciso que esta app dispare notificações push (no celular-gateway do dono
do sistema) através de um gateway central já existente (outro projeto, não
mexer nele). O gateway expõe:

POST [BASE_URL]/api/internal/messages/push
Headers:
  Authorization: Bearer [CRON_SECRET]
  Content-Type: application/json
Body:
  { "title": "Título curto", "body": "texto da notificação" }
Resposta:
  { "id": "uuid", "status": "PENDING" }

- Isto NÃO envia SMS — só mostra uma notificação Android no celular-gateway.
- "title" até 120 caracteres, "body" até 500 caracteres.
- A notificação aparece do lado do gateway em até ~15s; esta chamada só
  enfileira. Se quiser confirmar que foi vista, consulte:
  GET [BASE_URL]/api/internal/messages/{id}
  (mesmo header de auth) — devolve { status, seen_at, error }.
- Guarde [CRON_SECRET] como variável de ambiente do lado do servidor desta
  app (nunca no cliente/frontend, nunca em código versionado).
- Trate falhas de rede/HTTP da chamada como não-bloqueantes para o fluxo
  principal do utilizador — a notificação é um efeito colateral, não deve
  derrubar a operação principal se a chamada ao gateway falhar.

Quero que isto seja disparado [EVENTO]. Implemente uma função reutilizável
(ex.: sendPush(title, body)) e chame-a nesse ponto do fluxo, seguindo os
padrões já existentes neste projeto para chamadas a serviços externos.
```

---

## Notas gerais (aplicam-se às duas)

- `[CRON_SECRET]` autoriza qualquer chamada aos endpoints internos deste
  gateway — trate como segredo de produção, não como uma API key pública
  por-app. Se um dia forem muitas apps a usar isto, vale considerar chaves
  separadas por app; por enquanto é uso interno de confiança.
- Referência completa dos endpoints (incluindo os de pagamento) em
  `docs/ENDPOINTS.md` deste repositório.
