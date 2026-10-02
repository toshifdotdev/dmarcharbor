import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Generated files, not ours to fix. next-env.d.ts is rewritten by Next on
    // every build and uses triple-slash references that this config rejects.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-undef': 'off',
    },
  },
  {
    // Build and generation scripts. They are Node programs, not browser code, so
    // they need the Node globals rather than the ones a browser would supply.
    // Linting them is worth it: the brand geometry is generated from a script,
    // and a typo in that script would otherwise only surface as a wrong logo.
    files: ['**/*.{mjs,js,cjs}', 'scripts/**/*.{ts,mjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
