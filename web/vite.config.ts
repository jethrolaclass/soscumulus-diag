import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // Deliberately recent target: the journey is only ever opened from a text
    // message, so on a phone with an up-to-date browser. No polyfills to carry
    // over a basement network.
    target: 'es2022',
    sourcemap: true,
  },
  server: { port: 5173 },
});
