import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

// Architecture element types — mirrors the allowed relations in yg-architecture.yaml.
// Patterns are repo-relative (under source/cli/). All llm subtypes group as 'llm'
// (same directory); all io subtypes (parser/persistence) group as 'io'.
//
// ENFORCEMENT STATUS: the boundaries rules below accurately document the intended
// layering (and were corrected to add the structure-adapter and command-support
// elements). They do NOT yet block, however: eslint-plugin-boundaries v6 + the
// flat-config import/resolver do not engage TypeScript `.js`→`.ts` import
// resolution in this project, so cross-file imports resolve to nothing and the
// rules silently pass. Activating real enforcement (a planted io→engine import
// must fail eslint) is tracked as a follow-up — see .temp/dogfood-report.md (B1).
const architectureElements = [
  { type: 'entry-point', pattern: 'src/bin.ts', mode: 'file' },
  { type: 'command', pattern: 'src/cli/*' },
  { type: 'engine', pattern: 'src/core/**/*' },
  { type: 'io', pattern: 'src/io/*' },
  { type: 'formatter', pattern: 'src/formatters/*' },
  { type: 'model', pattern: 'src/model/*' },
  { type: 'utility', pattern: 'src/utils/*' },
  { type: 'ast-adapter', pattern: 'src/ast/*' },
  { type: 'structure-adapter', pattern: 'src/structure/*' },
  { type: 'llm', pattern: 'src/llm/*' },
  { type: 'migration', pattern: 'src/migrations/*' },
  { type: 'template', pattern: 'src/templates/**/*' },
];

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
    plugins: { boundaries },
    settings: {
      'boundaries/elements': architectureElements,
      'boundaries/ignore': ['**/*.test.ts', '**/*.spec.ts'],
      // Resolve `.js` import specifiers to their `.ts` sources so the boundaries
      // plugin can classify cross-file imports. Without a resolver the rules are
      // inert (every import is unresolved and silently skipped).
      'import/resolver': {
        typescript: { project: './tsconfig.json' },
      },
    },
    rules: {
      'boundaries/dependencies': ['error', {
        default: 'disallow',
        rules: [
          { from: { type: 'entry-point' }, allow: { to: { type: ['command'] } } },
          { from: { type: 'command' }, allow: { to: { type: ['command-support', 'engine', 'io', 'llm', 'formatter', 'utility', 'ast-adapter', 'structure-adapter', 'template', 'model'] } } },
          { from: { type: 'command-support' }, allow: { to: { type: ['engine', 'io', 'llm', 'formatter', 'utility', 'model'] } } },
          { from: { type: 'engine' }, allow: { to: { type: ['engine', 'io', 'llm', 'utility', 'structure-adapter', 'ast-adapter', 'model'] } } },
          { from: { type: 'io' }, allow: { to: { type: ['io', 'utility', 'model'] } } },
          { from: { type: 'formatter' }, allow: { to: { type: ['utility', 'model'] } } },
          { from: { type: 'model' }, allow: { to: { type: ['model'] } } },
          { from: { type: 'utility' }, allow: { to: { type: ['utility', 'model'] } } },
          { from: { type: 'ast-adapter' }, allow: { to: { type: ['utility', 'llm', 'model'] } } },
          { from: { type: 'structure-adapter' }, allow: { to: { type: ['utility', 'ast-adapter', 'model'] } } },
          { from: { type: 'llm' }, allow: { to: { type: ['llm', 'utility', 'model'] } } },
          { from: { type: 'migration' }, allow: { to: { type: ['engine', 'io', 'utility', 'model'] } } },
          { from: { type: 'template' }, allow: { to: { type: ['utility', 'model'] } } },
        ],
      }],
    },
  },
  {
    ignores: ['dist/', 'build/', 'coverage/', 'node_modules/', '*.config.*', '*.min.js'],
  },
);
