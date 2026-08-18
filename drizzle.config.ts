import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './server/database/schema.ts',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DB_PATH || './data/app.db',
  },
})
