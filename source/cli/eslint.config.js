import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// NOTE on architecture layering: the layer rules (which directory may import
// which) live in .yggdrasil/yg-architecture.yaml as the source of truth and are
// kept legal structurally by where files live. An eslint-plugin-boundaries setup
// was trialled to enforce them in the linter but never worked — its import
// resolver would not map our `.js` specifiers to their `.ts` sources under flat
// config (tried plugin v5/v6, resolver v3/v4, multiple settings), so the rules
// silently passed everything. It was removed rather than left as dead config.

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      // Error (not warn): repo-check does not fail on warnings, so a `warn` here
      // let future `any`-leaks pass CI silently. The codebase is `any`-free today.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // The portal frontend assets (templates/portal/js + vendor) are committed BROWSER
    // code, not Node/TS source: they legitimately use browser globals (document, window)
    // and, for the vendored layout library, are taken as-shipped. They are enforced by the
    // portal frontend aspects (no-node-imports-in-frontend / no-cdn-no-network /
    // no-network-egress / no-secrets-strings / focused-file-size), not by the Node eslint
    // config, whose environment cannot model the browser.
    ignores: [
      'dist/',
      'build/',
      'coverage/',
      'node_modules/',
      '*.config.*',
      '*.min.js',
      'src/templates/portal/js/',
      'src/templates/portal/vendor/',
    ],
  },
);
