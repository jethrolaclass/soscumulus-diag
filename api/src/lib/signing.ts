/**
 * HMAC-SHA256 signing via WebCrypto — case tokens and image URLs.
 *
 * Photos are never exposed on a public bucket: they are served by a Worker
 * route behind a short-lived signed URL that the Anthropic API fetches itself.
 * The Worker only relays the R2 stream, which costs almost no CPU — unlike a
 * base64 encoding, which would blow the free plan's budget on its own.
 */

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  // WebCrypto rejects a zero-length HMAC key with an opaque error. A missing
  // secret is a configuration mistake: naming it avoids hunting for a signing
  // bug where a `wrangler secret put` is what is missing.
  if (!secret) throw new Error('SIGNING_KEY is missing or empty.');
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

/** Constant-time comparison: `===` on signatures leaks through timing. */
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
/* Case token                                                          */
/* ------------------------------------------------------------------ */

/**
 * Opaque case identifier. Random, never derived from the client reference:
 * `SC-0024` in a URL can be enumerated, which would expose neighbouring cases.
 * The readable reference stays on screen, never in a route.
 */
export function newCaseToken(): string {
  // 16 bytes, i.e. 128 bits — beyond any enumeration, and ten characters
  // shorter than 24 bytes. On a text billed per 160 characters, URL length is
  // not a cosmetic detail.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64url(bytes.buffer);
}

/* ------------------------------------------------------------------ */
/* Signed image URL                                                    */
/* ------------------------------------------------------------------ */

/** Default lifetime: the duration of one vision call, no more. */
const IMAGE_URL_TTL_S = 300;

/**
 * @param ttlSeconds Extend only for the intervention report, whose reader is a
 * technician consulting it later. Never align this duration with anything but
 * the case retention.
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
  // Verification always denies rather than throwing: this route is publicly
  // exposed, and an internal error would tell an attacker about the state of
  // the configuration.
  if (!secret || !exp || !sig) return false;
  const expiry = Number(exp);
  if (!Number.isFinite(expiry) || expiry < Date.now() / 1000) return false;
  try {
    return await verify(secret, `${key}:${expiry}`, sig);
  } catch {
    return false;
  }
}
