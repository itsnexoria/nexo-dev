const globals = require('globals');
module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'renderer/dist/**', 'src/**', 'e2e/**', 'extensions-sample/**'] },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node, window: 'readonly', document: 'readonly' } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }] },
  },
];
