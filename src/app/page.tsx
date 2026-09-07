const METHODS = [
  {
    icon: '📱',
    tint: 'rgba(52, 224, 161, 0.16)',
    glow: 'rgba(52, 224, 161, 0.25)',
    name: 'M-Pesa',
    sync: true,
    desc: 'Cobrança C2B via USSD push. Confirmação imediata — sem espera por webhook.',
    meta: ['MZN', 'mín. 10 MZN', 'B2C/payout']
  },
  {
    icon: '💚',
    tint: 'rgba(34, 211, 238, 0.14)',
    glow: 'rgba(34, 211, 238, 0.25)',
    name: 'e-Mola',
    sync: false,
    desc: 'Cobrança via Easyhost. Confirmação assíncrona por callback/webhook.',
    meta: ['MZN', 'mín. 50 MZN']
  },
  {
    icon: '🟠',
    tint: 'rgba(124, 92, 255, 0.16)',
    glow: 'rgba(124, 92, 255, 0.25)',
    name: 'mKesh',
    sync: false,
    desc: 'STK Push directo para o número do cliente. Confirmação por webhook.',
    meta: ['MZN', 'mín. 10 MZN']
  },
  {
    icon: '💳',
    tint: 'rgba(124, 92, 255, 0.16)',
    glow: 'rgba(124, 92, 255, 0.25)',
    name: 'Visa & Mastercard',
    sync: false,
    desc: 'Hosted Checkout com 3D Secure automático. Dados do cartão nunca tocam o seu servidor.',
    meta: ['MZN', 'mín. 50 MZN', '3D Secure', 'Recorrência']
  },
  {
    icon: '🇿🇦',
    tint: 'rgba(34, 211, 238, 0.14)',
    glow: 'rgba(34, 211, 238, 0.25)',
    name: 'PayFast',
    sync: false,
    desc: 'Cartão e EFT em Rand sul-africano, via Hosted Checkout. Confirmação por ITN/webhook.',
    meta: ['ZAR', 'mín. 5 ZAR']
  }
] as const;

const FLOW = [
  {
    n: '01',
    title: 'App chama /v1/charges',
    body: 'O seu app envia reference, amount e method para este gateway — nunca fala com a Debito Pay directamente.'
  },
  {
    n: '02',
    title: 'Gateway cria a cobrança',
    body: 'Encaminha para o payment-orchestrator da Debito Pay com merchant_id + wallet_code — as credenciais nunca saem daqui.'
  },
  {
    n: '03',
    title: 'Resultado ou checkout',
    body: 'M-Pesa confirma já na resposta. Os restantes devolvem pending — cartão/PayFast trazem checkout_url para redireccionar.'
  },
  {
    n: '04',
    title: 'Webhook + fan-out assinado',
    body: 'A confirmação chega por webhook (HMAC-SHA256) e é reenviada, já assinada, ao callback_url do seu app.'
  }
] as const;

export default function Home() {
  return (
    <>
      <div className="bg-glow" aria-hidden="true" />
      <div className="page">
        <nav className="nav">
          <div className="brand">
            <span className="brand-mark">⚡</span>
            PayGate
          </div>
          <div className="nav-links">
            <a href="#metodos">Métodos</a>
            <a href="#fluxo">Como funciona</a>
            <a href="#api">API</a>
          </div>
        </nav>

        <section className="hero">
          <div className="eyebrow">
            <span className="eyebrow-dot" />
            Powered by Debito Pay
          </div>
          <h1>
            Um gateway.
            <br />
            <span className="grad">Todos os métodos de pagamento.</span>
          </h1>
          <p>
            PayGate é o ponto único de pagamentos para os seus apps — M-Pesa, e-Mola, mKesh,
            Visa &amp; Mastercard e PayFast (ZAR) por trás de uma única API, com ledger
            centralizado e fan-out assinado para cada app cliente.
          </p>
          <div className="cta-row">
            <a className="btn btn-primary" href="#metodos">
              Ver métodos de pagamento
            </a>
            <a className="btn btn-ghost" href="#api">
              POST /api/v1/charges
            </a>
          </div>
        </section>

        <div className="stats">
          <div className="stat">
            <div className="stat-value">5</div>
            <div className="stat-label">Métodos de pagamento</div>
          </div>
          <div className="stat">
            <div className="stat-value">2</div>
            <div className="stat-label">Moedas — MZN &amp; ZAR</div>
          </div>
          <div className="stat">
            <div className="stat-value">1</div>
            <div className="stat-label">API para todos os apps</div>
          </div>
          <div className="stat">
            <div className="stat-value">HMAC</div>
            <div className="stat-label">Webhooks assinados</div>
          </div>
        </div>

        <section id="metodos">
          <div className="section-head">
            <div className="section-kicker">Métodos de pagamento</div>
            <h2>Tudo o que a Debito Pay suporta</h2>
            <p>
              M-Pesa confirma na hora. Os restantes confirmam por webhook — cartão e PayFast
              devolvem um <code>checkout_url</code> para o Hosted Checkout da Debito Pay.
            </p>
          </div>
          <div className="methods">
            {METHODS.map((m) => (
              <div
                key={m.name}
                className="method-card"
                style={{ ['--tint' as string]: m.tint, ['--glow' as string]: m.glow }}
              >
                <div className="method-top">
                  <div className="method-icon">{m.icon}</div>
                  <span className={`badge ${m.sync ? 'badge-sync' : 'badge-async'}`}>
                    {m.sync ? 'Síncrono' : 'Webhook'}
                  </span>
                </div>
                <h3>{m.name}</h3>
                <p>{m.desc}</p>
                <div className="method-meta">
                  {m.meta.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section id="fluxo">
          <div className="section-head">
            <div className="section-kicker">Como funciona</div>
            <h2>Do seu app ao dinheiro na carteira</h2>
            <p>Um único fluxo, quatro passos — independentemente do método escolhido.</p>
          </div>
          <div className="flow">
            {FLOW.map((f) => (
              <div key={f.n} className="flow-step">
                <div className="flow-num">{f.n}</div>
                <h4>{f.title}</h4>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="api">
          <div className="section-head">
            <div className="section-kicker">Integração</div>
            <h2>Uma chamada para cobrar, uma resposta para saber o resultado</h2>
            <p>Auth por Bearer, JSON simples — ver referência completa em docs/ENDPOINTS.md.</p>
          </div>
          <div className="code-panel">
            <div className="code-block">
              <div className="code-block-head">
                <span>POST /api/v1/charges</span>
                <div className="dots">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
              <pre>
                <span className="c">{'// mobile money — mpesa | emola | mkesh'}</span>
                {'\n'}
                {'{\n'}
                {'  '}
                <span className="n">&quot;reference&quot;</span>: <span className="s">&quot;IHP-123&quot;</span>,{'\n'}
                {'  '}
                <span className="n">&quot;amount&quot;</span>: 150,{'\n'}
                {'  '}
                <span className="n">&quot;method&quot;</span>: <span className="s">&quot;mpesa&quot;</span>,{'\n'}
                {'  '}
                <span className="n">&quot;payer_phone&quot;</span>: <span className="s">&quot;+258840000000&quot;</span>,{'\n'}
                {'  '}
                <span className="n">&quot;payer_name&quot;</span>: <span className="s">&quot;João Silva&quot;</span>
                {'\n}'}
              </pre>
            </div>
            <div className="code-block">
              <div className="code-block-head">
                <span>200 OK</span>
                <div className="dots">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
              <pre>
                <span className="c">{'// mpesa confirma já aqui'}</span>
                {'\n'}
                {'{\n'}
                {'  '}
                <span className="n">&quot;gateway_payment_id&quot;</span>: <span className="s">&quot;uuid&quot;</span>,{'\n'}
                {'  '}
                <span className="n">&quot;status&quot;</span>: <span className="k">&quot;success&quot;</span>,{'\n'}
                {'  '}
                <span className="n">&quot;message&quot;</span>: <span className="s">&quot;Pagamento processado&quot;</span>,{'\n'}
                {'  '}
                <span className="n">&quot;checkout_url&quot;</span>: null{'\n'}
                {'}'}
              </pre>
            </div>
          </div>
        </section>

        <footer className="footer">
          <span>PayGate © 2026 — orquestrador de pagamentos multi-tenant.</span>
          <div className="footer-links">
            <a href="/api/health">Status</a>
            <a href="#api">Documentação</a>
          </div>
        </footer>
      </div>
    </>
  );
}
