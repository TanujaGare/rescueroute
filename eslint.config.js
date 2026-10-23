import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'data/', 'evaluation/'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2025, sourceType: 'module', globals: globals.node },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2025, sourceType: 'module', globals: globals.browser },
    rules: {
      // Rendering must go through textContent / createElement to prevent XSS.
      'no-restricted-properties': ['error', { property: 'innerHTML', message: 'Use textContent or el() to avoid XSS.' }],
    },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      curly: ['error', 'multi-line'],
    },
  },
];
