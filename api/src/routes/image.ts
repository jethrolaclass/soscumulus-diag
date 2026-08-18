import type { Env } from '../env';
import { verifyImageUrl } from '../lib/signing';

/**
 * Serve a photo from a short-lived signed URL.
 *
 * Consumed by the vision API, never by a browser. The R2 bucket stays private:
 * this route and its signature are what control access. The body is returned
 * as-is from the R2 stream — no in-memory copy, so the CPU cost is negligible
 * whatever the file size.
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
      // These images are not meant to be indexed or referenced.
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}
