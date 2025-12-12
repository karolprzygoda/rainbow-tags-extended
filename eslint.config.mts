import * as js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import * as globals from 'globals';
import * as tseslint from 'typescript-eslint';

export default defineConfig([
  // Ignore vendor/build/config artifacts
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/.git/**',
      '**/.vscode/**',
      '**/*.js',
      '**/*.cjs',
      '**/*.d.ts',
      '**/*.mjs',
      '**/*.d.ts',
      '**/*.map',
      '**/*.vsix',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    plugins: { js },
    extends: ['js/recommended'],
    languageOptions: { globals: globals.browser },
  },
  tseslint.configs.recommended,
]);
