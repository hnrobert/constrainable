// ESLint flat config for TypeScript projects.
// Division of labor: ESLint owns code quality, Prettier owns formatting
// (see .prettierrc in the same directory) — do not add formatting rules here.
// Dev dependencies: bun add -D eslint @eslint/js typescript-eslint
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['.nuxt/', '.output/', 'dist/', 'data/', 'records/', 'shared/proto/', 'node_modules/'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // repo style: scripts and edge glue (ffmpeg pipes, SRS webhooks)
      // deliberately use `any` — kept visible as warnings instead of errors
      '@typescript-eslint/no-explicit-any': 'warn',
      // `_`-prefixed identifiers are intentionally unused (kept for
      // positional/signature parity)
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
)
