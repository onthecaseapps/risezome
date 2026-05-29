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
};

export default nextConfig;
