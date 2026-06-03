import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Per-developer tunnel host(s). use-env.sh derives RISEZOME_DEV_ORIGIN from the
// developer tag (e.g. dev-nathan.risezome.app); accept a comma-separated list
// and merge it with the always-on localhost/LAN defaults so each developer's
// own tunnel hydrates without editing this committed file.
const devOrigins = (process.env.RISEZOME_DEV_ORIGIN ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter((o) => o.length > 0);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the workspace root so Turbopack doesn't infer it from an ancestor
  // lockfile (this app lives in a pnpm monorepo at <repo>/apps/portal).
  turbopack: {
    root: resolve(here, '..', '..'),
  },
  // Dev-only: allow loading /_next dev resources (client JS, HMR) when the
  // page is opened from another device on the LAN (e.g. a phone at the host's
  // IP) or through a cloudflared share tunnel. Without this, Next dev blocks
  // cross-origin dev requests and the client bundle never hydrates (so the
  // live demo animation / waitlist form would render but not run). Harmless
  // in production builds.
  allowedDevOrigins: ['192.168.68.93', ...devOrigins],
};

export default nextConfig;
