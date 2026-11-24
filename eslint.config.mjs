// Lint exists for one reason: to catch a name that is used but never defined or imported (a missing import broke the daily crawl in production in
// November 2026 and neither the build nor the tests noticed). It is not a style checker; keep the rule list short and every rule a likely bug.
import globals from 'globals';

export default [
  { ignores: ['.next/**', 'node_modules/**', 'backups/**', 'public/**'] },
  {
    files: ['**/*.{js,mjs,cjs,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-undef': 'error',
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-func-assign': 'error',
      'no-self-assign': 'error',
      'no-unsafe-finally': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
    },
  },
];
