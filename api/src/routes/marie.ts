/**
 * The voice agent's test page, behind a short list of named accounts.
 *
 * Served by the Worker rather than by Pages, on purpose: the Pages project
 * answers on two hostnames — the custom domain and its pages.dev twin — and a
 * rule set on one leaves the other open. A check written here applies whatever
 * hostname the request came in on.
 *
 * The page is not a secret in itself, but it embeds the agent, and every
 * conversation started from it spends credits and opens a real case. It was
 * public once, at an unguessable address, and taken down the same hour.
 *
 * `MARIE_USERS` holds `name:sha256(password)` pairs, comma-separated. Unset
 * means closed: the route answers 404 rather than fall open.
 */

import type { Env } from '../env';
import { logEvent } from '../lib/db';
import { secretMatches } from '../lib/http';
import page from '../../../scripts/marie-test.html';

const REALM = 'SOS Cumulus - test de Marie';

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `Authorization: Basic …` → [user, password], or null when absent or malformed. */
function basicCredentials(req: Request): [string, string] | null {
  const header = req.headers.get('authorization') ?? '';
  if (!header.toLowerCase().startsWith('basic ')) return null;
  try {
    const bytes = Uint8Array.from(atob(header.slice(6).trim()), (c) => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const cut = decoded.indexOf(':');
    return cut < 0 ? null : [decoded.slice(0, cut), decoded.slice(cut + 1)];
  } catch {
    return null;
  }
}

export async function handleMariePage(req: Request, env: Env): Promise<Response> {
  const accounts = new Map(
    (env.MARIE_USERS ?? '')
      .split(',')
      .map((pair) => pair.trim().split(':'))
      .filter((p): p is [string, string] => p.length === 2 && p[0] !== '' && p[1] !== ''),
  );
  if (accounts.size === 0) return new Response('Not found', { status: 404 });

  const given = basicCredentials(req);
  const expected = given ? accounts.get(given[0].toLowerCase()) : undefined;
  // The hash is computed even for an unknown name, so a wrong name and a wrong
  // password take the same time to refuse.
  const hash = await sha256Hex(given?.[1] ?? '');
  if (!given || !expected || !secretMatches(hash, expected)) {
    return new Response('Accès réservé.', {
      status: 401,
      headers: {
        'www-authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

  await logEvent(env, null, 'marie_page_opened', given[0].toLowerCase());
  return new Response(page, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Never cached: an edge copy would be served without asking who is there.
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}
