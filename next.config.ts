import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // API-only: sem UI. Mantém os route handlers sempre em runtime Node
  // (precisamos do módulo 'crypto' e de conexões persistentes ao Postgres).
  serverExternalPackages: ['postgres']
};

export default nextConfig;
