import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/coverage/**',
      'sidecars/**',
      'pnpm-lock.yaml',
      // apps/portal (Next.js) owns its own lint toolchain — see apps/portal/eslint.config.mjs.
      // The root type-checked config would otherwise try to parse it outside its tsconfig project.
      'apps/portal/**',
      // apps/hud-next likewise.
      'apps/hud-next/**',
      // Config + one-off dev scripts/probes that aren't part of any
      // tsconfig project (the type-aware parser can't resolve them).
      '**/vitest.config.ts',
      'apps/daemon/scripts/**',
      'apps/bot-worker/scripts/**',
      '**/ws-probe.mjs',
      // The dev console's browser assets (vanilla HTML/JS/CSS) use browser
      // globals and no build step — not part of the Node/TS lint surface.
      'scripts/dev-console/public/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'eslint.config.mjs',
            'vitest.config.ts',
            '*.config.ts',
            '*.config.mjs',
            'apps/hud/build.config.mjs',
            'test/*.test.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Tests use loosely-typed mocks and stubs (fake DB clients, fetch
    // doubles, empty handlers). The type-safety rules below fire on `any`
    // mock values and add noise without catching real bugs in test code.
    files: ['**/test/**/*.ts', '**/test/**/*.tsx', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-enum-comparison': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-implied-eval': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // Corpus skills query Supabase through the engine's duck-typed
    // SkillDbClient seam (`from()`/`rpc()` return `unknown`) — the engine
    // deliberately takes no @supabase/supabase-js dependency, so the
    // Postgrest builder chain reads as `unsafe` here. This is a genuine
    // SDK seam (see AGENTS.md); the query results are validated at use.
    files: ['**/src/skills/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      // Skill handlers must satisfy the contract's `Promise<SkillResult>`
      // signature, so they're async even when the body has no await.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // CLI commands, entry points, and one-off scripts legitimately print
    // to stdout.
    files: ['**/cli/**/*.ts', '**/scripts/**/*.ts', 'apps/*/src/index.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.config.mjs', '**/build.config.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  prettierConfig,
);
