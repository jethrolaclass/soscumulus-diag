import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // Cible volontairement récente : le parcours n'est ouvert que depuis un
    // lien SMS, donc sur un téléphone dont le navigateur est à jour. Pas de
    // polyfill à transporter sur un réseau de cave.
    target: 'es2022',
    sourcemap: true,
  },
  server: { port: 5173 },
});
