import parser from '@typescript-eslint/parser'
import plugin from '@typescript-eslint/eslint-plugin'

// The shared console is plain browser scripts with no build step: each file
// runs in the window and reaches the others through `window`. The same
// strictness as `src`, with the browser's globals instead of Node's.
const browserGlobals = Object.fromEntries(['window', 'document', 'navigator', 'console', 'crypto', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'URL', 'Intl', 'CSS', 'CustomEvent', 'Element', 'Promise', 'Map', 'Set', 'JSON', 'Math', 'Date',
  'Number', 'String', 'Boolean', 'Object', 'Array', 'Error', 'TypeError', 'RegExp', 'getComputedStyle', 'requestAnimationFrame']
  .map((name) => [name, 'readonly']))

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/target/**', '**/gen/**', '.artifacts/**'] },
  {
    files: ['**/*.ts'],
    languageOptions: { parser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
    plugins: { '@typescript-eslint': plugin },
    rules: {
      ...plugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'max-len': ['error', { code: 120, ignoreStrings: true, ignoreTemplateLiterals: true }],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/api-client.ts', 'src/egress-gateway.ts', 'src/firecracker/api.ts', 'src/ollama-client.ts'],
    rules: {
      'no-restricted-globals': ['error', { name: 'fetch', message: 'Use the pinned executor transport.' }],
    },
  },
  {
    files: ['packages/executor-console/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: browserGlobals },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-cond-assign': 'error',
      'no-constant-condition': 'error',
      'no-fallthrough': 'error',
      'no-unsafe-negation': 'error',
      'no-useless-escape': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: 'error',
      'no-implicit-globals': 'error',
      'max-len': ['error', { code: 120, ignoreStrings: true, ignoreTemplateLiterals: true }],
    },
  },
]
