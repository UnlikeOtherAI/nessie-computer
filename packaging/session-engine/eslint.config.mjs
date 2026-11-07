import parser from '@typescript-eslint/parser'
import plugin from '@typescript-eslint/eslint-plugin'

// Same strict first-party rules as the executor. Pinned third-party source stays
// in the verified capsule, rather than becoming oversized first-party files.
export default [{
  files: ['**/*.mjs', '**/*.ts'],
  ignores: ['node_modules/**', '.artifacts/**'],
  languageOptions: { parser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
  plugins: { '@typescript-eslint': plugin },
  rules: {
    ...plugin.configs.recommended.rules,
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'max-len': ['error', { code: 120, ignoreStrings: true, ignoreTemplateLiterals: true }],
  },
}]
