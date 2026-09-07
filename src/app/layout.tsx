import './globals.css';

export const metadata = {
  title: 'PayGate — pagamentos via Debito Pay',
  description: 'Orquestrador central de pagamentos: M-Pesa, e-Mola, mKesh, Visa & Mastercard e PayFast numa única API.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt">
      <body>{children}</body>
    </html>
  );
}
