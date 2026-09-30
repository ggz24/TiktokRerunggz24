import type { NextConfig } from 'next';
import path from 'node:path';

// Set NEXT_PUBLIC_BASE_PATH=/live to serve the app under https://ggz24.com/live
// instead of the domain root. Leave unset for local dev and the sslip.io VM test domain.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || undefined;

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(process.cwd(), '../..'),
  devIndicators: false,
  basePath,
};
export default nextConfig;
