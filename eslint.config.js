import parser from '@typescript-eslint/parser'
import plugin from '@typescript-eslint/eslint-plugin'

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
]
