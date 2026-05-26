import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    files: ['src/**/*.js', 'test/**/*.js', 'scripts/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2024 },
    },
    rules: {
      ...js.configs.recommended.rules,
      // Only `no-undef` is load-bearing for this PR (it would have caught the
      // #276 dropped-symbol bug). Everything else stays off so the diff stays
      // scoped — tighten in follow-up PRs.
      'no-unused-vars': 'off',
      'no-empty': 'off',
      'no-constant-condition': 'off',
      'no-control-regex': 'off',
      'no-useless-escape': 'off',
      'no-prototype-builtins': 'off',
      'no-cond-assign': 'off',
      'no-inner-declarations': 'off',
      'no-undef': 'error',
    },
  },
  {
    ignores: ['public/**', 'mcp-server/**', 'node_modules/**', 'coverage/**'],
  },
]
