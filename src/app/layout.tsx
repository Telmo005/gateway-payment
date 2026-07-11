export const metadata = {
  title: 'PayGate',
  description: 'Orquestrador central de pagamentos PaySuite'
};

// Serviço API-only — este layout existe apenas para satisfazer o Next.js.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt">
      <body>{children}</body>
    </html>
  );
}
