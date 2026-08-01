import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  build: { target: 'es2022' },
  test: {
    // The Playwright service-worker harness owns sw-tests/ (npm run test:sw).
    exclude: [...configDefaults.exclude, 'sw-tests/**'],
  },
})
