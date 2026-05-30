import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Daemon serves the static export from apps/hud-next/out/. No Node
  // runtime at serve time; the daemon's existing static-asset path
  // (extended in U5 with @fastify/static for /_next/*) handles the bundle.
  output: 'export',
  // Required for static export — Next's image optimizer needs the
  // serverless image route which isn't compatible with `output: 'export'`.
  images: { unoptimized: true },
  // Surface effect-cleanup bugs early via double-invocation in dev.
  // Production builds are unaffected.
  reactStrictMode: true,
  // Pin the workspace root so Turbopack doesn't infer it from an ancestor
  // lockfile (this app lives in a pnpm monorepo).
  turbopack: {
    root: resolve(here, '..', '..'),
  },
};

export default nextConfig;
