import type { Env } from '../env';
import type { PhotoSlot } from '../../../shared/types';

export class ApiHttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

export const badRequest = (message: string, code = 'bad_request') =>
  new ApiHttpError(400, code, message);

export const unauthorized = () =>
  new ApiHttpError(401, 'unauthorized', 'Authentification requise.');

/**
 * An unknown case and an expired one return the same response: telling them
 * apart would let anyone probe for the existence of a token.
 */
export const notFound = () =>
  new ApiHttpError(404, 'not_found', 'Dossier introuvable ou expiré.');

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/* ------------------------------------------------------------------ */
/* CORS                                                                */
/* ------------------------------------------------------------------ */

/** Single explicit origin — never `*` on an API that carries tokens. */
function corsHeaders(env: Env): Record<string, string> {
  return {
    'access-control-allow-origin': env.PUBLIC_WEB_URL,
    'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
    'access-control-allow-headers': 'content-type, x-lead-secret',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

export function preflight(env: Env): Response {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}

export function withCors(env: Env, res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(env))) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export function parseSlot(raw: string | null): PhotoSlot {
  const n = Number(raw);
  if (n !== 1 && n !== 2 && n !== 3) {
    throw badRequest('Emplacement de photo invalide (attendu 1, 2 ou 3).');
  }
  return n as PhotoSlot;
}

/**
 * Constant-time comparison of a shared secret.
 *
 * A missing `expected` — secret never set on the Worker — denies rather than
 * throwing: without this guard an incomplete configuration answered 500 rather
 * than 401, sending you hunting for a bug where only a secret was missing.
 */
export function secretMatches(
  provided: string | null,
  expected: string | undefined,
): boolean {
  if (!provided || !expected || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
