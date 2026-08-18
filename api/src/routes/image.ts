import type { Env } from '../env';
import { verifyImageUrl } from '../lib/signing';

/**
 * Sert une photo à partir d'une URL signée à durée courte.
 *
 * Consommée par l'API vision, jamais par un navigateur. Le bucket R2 reste
 * privé : c'est cette route, et sa signature, qui contrôlent l'accès. Le corps
 * est renvoyé tel quel depuis le flux R2 — aucune copie en mémoire, donc un
 * coût CPU négligeable quelle que soit la taille du fichier.
 */
export async function handleImage(
  req: Request,
  env: Env,
  key: string,
): Promise<Response> {
  const url = new URL(req.url);
  const ok = await verifyImageUrl(
    env.SIGNING_KEY,
    key,
    url.searchParams.get('exp'),
    url.searchParams.get('sig'),
  );
  if (!ok) return new Response('Forbidden', { status: 403 });

  const object = await env.PHOTOS.get(key);
  if (!object) return new Response('Not found', { status: 404 });

  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType ?? 'image/jpeg',
      'cache-control': 'private, no-store',
      // Ces images ne sont pas destinées à être indexées ni référencées.
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}
