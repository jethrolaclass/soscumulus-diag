/**
 * Signature HMAC-SHA256 via WebCrypto — tokens de dossier et URL d'image.
 *
 * Les photos ne sont jamais exposées sur un bucket public : elles sont servies
 * par une route du Worker derrière une URL signée à durée courte, que l'API
 * Anthropic va chercher elle-même. Le Worker se contente de relayer le flux R2,
 * ce qui ne consomme pratiquement pas de CPU — contrairement à un encodage
 * base64, qui dépasserait à lui seul le quota du plan gratuit.
 */

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function base64url(bytes: ArrayBuffer): string {
  let bin = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sign(secret: string, payload: string): Promise<string> {
  const key = await hmacKey(secret);
  return base64url(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

/** Comparaison à temps constant : `===` sur des signatures fuit par timing. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verify(
  secret: string,
  payload: string,
  signature: string,
): Promise<boolean> {
  return safeEqual(await sign(secret, payload), signature);
}

/* ------------------------------------------------------------------ */
/* Token de dossier                                                    */
/* ------------------------------------------------------------------ */

/**
 * Identifiant opaque de dossier. Aléatoire, jamais dérivé de la référence
 * client : `SC-0024` dans une URL s'énumère, et donnerait accès aux dossiers
 * voisins. La référence lisible reste affichée dans l'interface, pas routée.
 */
export function newDossierToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64url(bytes.buffer);
}

/* ------------------------------------------------------------------ */
/* URL d'image signée                                                  */
/* ------------------------------------------------------------------ */

/** Durée de vie par défaut : le temps d'un appel vision, pas plus. */
const IMAGE_URL_TTL_S = 300;

/**
 * @param ttlSeconds Rallonger uniquement pour la fiche d'intervention, dont le
 * destinataire est un technicien qui la consultera plus tard. Ne jamais aligner
 * cette durée sur autre chose que la rétention du dossier.
 */
export async function signedImageUrl(
  secret: string,
  publicApiUrl: string,
  key: string,
  ttlSeconds: number = IMAGE_URL_TTL_S,
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await sign(secret, `${key}:${exp}`);
  const url = new URL(`/i/${encodeURIComponent(key)}`, publicApiUrl);
  url.searchParams.set('exp', String(exp));
  url.searchParams.set('sig', sig);
  return url.toString();
}

export async function verifyImageUrl(
  secret: string,
  key: string,
  exp: string | null,
  sig: string | null,
): Promise<boolean> {
  if (!exp || !sig) return false;
  const expiry = Number(exp);
  if (!Number.isFinite(expiry) || expiry < Date.now() / 1000) return false;
  return verify(secret, `${key}:${expiry}`, sig);
}
