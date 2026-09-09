import {defineConfig} from 'vite'
import solidPlugin from 'vite-plugin-solid'
import {gitVersion} from './scripts/git-version.mjs'

export default defineConfig({
  plugins: [solidPlugin()],
  base: './',
  server: {
    port: 3100
  },
  build: {
    target: 'esnext'
  },
  // Footer shows this - a compile-time constant sourced from the nearest
  // git tag (see scripts/git-version.mjs), so cutting a release is just
  // pushing a tag. 'dev' only surfaces outside a git checkout entirely
  // (e.g. a downloaded source archive with no .git directory)
  define: {
    __APP_VERSION__: JSON.stringify(gitVersion('dev'))
  }
})
