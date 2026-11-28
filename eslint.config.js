import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules',
      'dist',
      '.wrangler',
      'public',
      'design',
      'site',
      'migrations',
      'worker-configuration.d.ts',
      'playwright-report',
      'test-results',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      // Two TypeScript projects: the Worker (tsconfig.json) and the browser app (tsconfig.web.json).
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.web.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // React's rules of hooks for the web app (hooks only at the top level, complete dependencies).
    files: ['src/web/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
  },
  {
    // The many-people test is a plain Node script (Node's own fetch, WebSocket and timers).
    files: ['e2e/scale/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        fetch: 'readonly',
        WebSocket: 'readonly',
        performance: 'readonly',
        setTimeout: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        document: 'readonly',
      },
    },
  },
  {
    // Tests poke at raw JSON responses; their assertions catch wrong shapes. App code stays strict.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Plain Node scripts: starting the app for end-to-end tests, and deploying.
    files: ['e2e/**/*.mjs', 'scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { process: 'readonly' } },
  },
);
