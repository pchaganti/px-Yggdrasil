import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

// Architecture element types — mirrors §4.4 allowed_relations in yg-architecture.yaml.
// Path patterns are relative to src/. All llm subtypes grouped as 'llm' (same directory).
// All io subtypes (parser-adapter, persistence-adapter) grouped as 'io' (same directory).
const architectureElements = [
  { type: 'entry-point', pattern: 'bin.ts', mode: 'file' },
  { type: 'command', pattern: 'cli/*' },
  { type: 'engine', pattern: 'core/**/*' },
  { type: 'io', pattern: 'io/*' },
  { type: 'formatter', pattern: 'formatters/*' },
  { type: 'model', pattern: 'model/*' },
  { type: 'utility', pattern: 'utils/*' },
  { type: 'ast-adapter', pattern: 'ast/*' },
  { type: 'llm', pattern: 'llm/*' },
  { type: 'migration', pattern: 'migrations/*' },
  { type: 'template', pattern: 'templates/**/*' },
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
    },
    rules: {
      'boundaries/dependencies': ['error', {
        default: 'disallow',
        rules: [
          { from: { type: 'entry-point' }, allow: { to: { type: ['command'] } } },
          { from: { type: 'command' }, allow: { to: { type: ['engine', 'io', 'llm', 'formatter', 'utility', 'ast-adapter', 'template', 'model'] } } },
          { from: { type: 'engine' }, allow: { to: { type: ['engine', 'io', 'llm', 'utility', 'model'] } } },
          { from: { type: 'io' }, allow: { to: { type: ['io', 'utility', 'model'] } } },
          { from: { type: 'formatter' }, allow: { to: { type: ['utility', 'model'] } } },
          { from: { type: 'model' }, allow: { to: { type: ['model'] } } },
          { from: { type: 'utility' }, allow: { to: { type: ['utility', 'model'] } } },
          { from: { type: 'ast-adapter' }, allow: { to: { type: ['utility', 'llm', 'model'] } } },
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
