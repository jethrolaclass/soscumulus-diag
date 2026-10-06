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

/** The account name when the request carries valid credentials, else the refusal to send back. */
async function authorise(req: Request, env: Env): Promise<string | Response> {
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
  return given[0].toLowerCase();
}

export async function handleMariePage(req: Request, env: Env): Promise<Response> {
  const user = await authorise(req, env);
  if (user instanceof Response) return user;

  await logEvent(env, null, 'marie_page_opened', user);
  return new Response(page, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Never cached: an edge copy would be served without asking who is there.
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

/**
 * What is left to spend, for whoever is about to test: every conversation
 * burns ElevenLabs credits and every link burns a Brevo one, and a tester who
 * runs dry mid-call gets an error that says nothing about why.
 *
 * Each figure is fetched on its own and comes back null when its provider
 * refuses or is unreachable: one missing balance must not hide the other.
 */
export async function handleMarieCredits(req: Request, env: Env): Promise<Response> {
  const user = await authorise(req, env);
  if (user instanceof Response) return user;

  const [elevenlabs, brevo] = await Promise.all([elevenLabsBalance(env), brevoSmsBalance(env)]);
  return new Response(JSON.stringify({ elevenlabs, brevo }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' },
  });
}

async function elevenLabsBalance(
  env: Env,
): Promise<{ remaining: number; limit: number; resetsAt: string | null } | null> {
  // A key of its own, with the single permission to read the subscription: the
  // one that edits the agent has no business living in the Worker.
  if (!env.ELEVENLABS_READ_KEY) return null;
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': env.ELEVENLABS_READ_KEY },
    });
    if (!res.ok) return null;
    const d = (await res.json()) as {
      character_count?: number;
      character_limit?: number;
      next_character_count_reset_unix?: number | null;
    };
    if (typeof d.character_count !== 'number' || typeof d.character_limit !== 'number') return null;
    return {
      remaining: Math.max(0, d.character_limit - d.character_count),
      limit: d.character_limit,
      resetsAt: d.next_character_count_reset_unix
        ? new Date(d.next_character_count_reset_unix * 1000).toISOString()
        : null,
    };
  } catch {
    return null;
  }
}

async function brevoSmsBalance(env: Env): Promise<{ credits: number } | null> {
  try {
    const res = await fetch('https://api.brevo.com/v3/account', {
      headers: { 'api-key': env.SMS_API_KEY, accept: 'application/json' },
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { plan?: Array<{ type?: string; credits?: number }> };
    const sms = d.plan?.find((p) => p.type === 'sms');
    return typeof sms?.credits === 'number' ? { credits: sms.credits } : null;
  } catch {
    return null;
  }
}
