import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the workspace root so Turbopack doesn't infer it from an ancestor
  // lockfile (this app lives in a pnpm monorepo at <repo>/apps/web).
  turbopack: {
    root: resolve(here, '..', '..'),
  },
  // Dev-only: allow loading /_next dev resources (client JS, HMR) when the
  // page is opened from another device on the LAN (e.g. a phone at the host's
  // IP). Without this, Next dev blocks cross-origin dev requests and the
  // client bundle never hydrates. Harmless in production builds.
  allowedDevOrigins: ['192.168.68.93'],
};

export default nextConfig;
