import {defineConfig} from 'vitest/config'
import solidPlugin from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    // the tested modules are pure planning/codec/pdf-generation logic - no
    // DOM access, so node's own WebCrypto (crypto.subtle/getRandomValues)
    // covers everything they need, no jsdom
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
