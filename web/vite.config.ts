import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiUrl = env.VITE_API_URL || process.env.VITE_API_URL;

  // Sans cette garde, un build de production sans VITE_API_URL réussit et
  // produit un front qui appelle sa propre origine. Les requêtes répondent 404
  // et le client lit « Ce lien n'est plus valide » — un symptôme qui ne dit
  // rien de la cause. Mieux vaut échouer ici, bruyamment.
  if (command === 'build' && !apiUrl) {
    throw new Error(
      "VITE_API_URL n'est pas défini.\n" +
        "  · en local  : renseignez-le dans web/.env.local\n" +
        "  · sur Pages : Settings → Environment variables, au moment du build\n" +
        '  Valeur attendue : origine du Worker, ex. https://soscumulus-diag-api.<compte>.workers.dev',
    );
  }

  return {
    build: {
      // Cible volontairement récente : le parcours n'est ouvert que depuis un
      // lien SMS, donc sur un téléphone dont le navigateur est à jour. Pas de
      // polyfill à transporter sur un réseau de cave.
      target: 'es2022',
      sourcemap: true,
    },
    server: { port: 5173 },
  };
});
