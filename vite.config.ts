import {defineConfig} from 'vite'
import solidPlugin from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solidPlugin()],
  base: './',
  server: {
    port: 3100
  },
  build: {
    target: 'esnext'
  }
})
