import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Built bundle is served by the JUCE shell's resource provider (no web server),
// so all asset URLs must be relative.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    globals: true,
    environment: 'node',
  },
})
