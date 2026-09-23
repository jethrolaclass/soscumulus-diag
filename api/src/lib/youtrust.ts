/**
 * Electronic signature through Youtrust (the company formerly named Yousign;
 * the API hosts still carry the old name).
 *
 * Four calls make a signature request: create, upload the PDF, add the signer,
 * activate. The signing link comes back from the last one and we deliver it
 * ourselves by SMS — `delivery_mode: 'none'` — because the client is on their
 * phone with a leaking tank, not at a desk reading email.
 *
 * The sandbox host issues signatures that bind nobody: that is where every demo
 * and every test runs. Switching to production is one variable, and it must
 * never happen while `QUOTE_DEMO` still prints invented amounts.
 */

import type { Env } from '../env';

const SIGNATURE_LINK_TTL_DAYS = 7;

export interface SignerInfo {
  firstName: string;
  lastName: string;
  email: string;
  /** E.164; only needed for SMS OTP, which the demo does not use. */
  phone?: string;
}

/** Where the signature box sits on the PDF, in points from the top-left. */
export interface SignatureBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SignatureRequest {
  requestId: string;
  signerId: string;
  signatureLink: string;
}

async function api<T>(
  env: Env,
  method: string,
  path: string,
  body?: BodyInit,
  contentType?: string,
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${env.YOUTRUST_API_KEY}` };
  if (contentType) headers['content-type'] = contentType;
  const res = await fetch(`${env.YOUTRUST_BASE_URL}${path}`, { method, headers, body });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Youtrust ${method} ${path} → ${res.status} ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function createSignatureRequest(
  env: Env,
  opts: {
    name: string;
    externalId: string;
    pdf: Uint8Array;
    filename: string;
    signer: SignerInfo;
    box: SignatureBox;
  },
): Promise<SignatureRequest> {
  const expires = new Date(Date.now() + SIGNATURE_LINK_TTL_DAYS * 86_400_000);

  const request = await api<{ id: string }>(
    env,
    'POST',
    '/signature_requests',
    JSON.stringify({
      name: opts.name,
      delivery_mode: 'none',
      timezone: 'Europe/Paris',
      expiration_date: expires.toISOString().slice(0, 10),
      external_id: opts.externalId,
      audit_trail_locale: 'fr',
    }),
    'application/json',
  );

  const form = new FormData();
  form.append('file', new Blob([opts.pdf], { type: 'application/pdf' }), opts.filename);
  form.append('nature', 'signable_document');
  const document = await api<{ id: string }>(
    env,
    'POST',
    `/signature_requests/${request.id}/documents`,
    form,
  );

  const signer = await api<{ id: string }>(
    env,
    'POST',
    `/signature_requests/${request.id}/signers`,
    JSON.stringify({
      info: {
        first_name: opts.signer.firstName,
        last_name: opts.signer.lastName,
        email: opts.signer.email,
        phone_number: opts.signer.phone ?? null,
        locale: 'fr',
      },
      signature_level: 'electronic_signature',
      // No one-time code: the link itself only reaches the phone we texted,
      // and an OTP by SMS would be a second text on a plan billed per segment.
      signature_authentication_mode: 'no_otp',
      delivery_mode: 'none',
      fields: [{ document_id: document.id, type: 'signature', ...opts.box }],
    }),
    'application/json',
  );

  const activated = await api<{ signers: Array<{ id: string; signature_link: string | null }> }>(
    env,
    'POST',
    `/signature_requests/${request.id}/activate`,
  );
  const link = activated.signers.find((s) => s.id === signer.id)?.signature_link;
  if (!link) throw new Error('Youtrust: no signature link after activation');

  return { requestId: request.id, signerId: signer.id, signatureLink: link };
}

/** The signed PDF, once every signer is done. */
export async function downloadSigned(env: Env, requestId: string): Promise<Uint8Array> {
  const res = await fetch(
    `${env.YOUTRUST_BASE_URL}/signature_requests/${requestId}/documents/download`,
    { headers: { authorization: `Bearer ${env.YOUTRUST_API_KEY}` } },
  );
  if (!res.ok) throw new Error(`Youtrust download → ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * HMAC-SHA256 of the raw body, hex, prefixed "sha256=", compared in constant
 * time. The raw bytes and nothing else: re-serialising the JSON would change a
 * byte and reject every genuine call.
 */
export async function webhookIsGenuine(
  rawBody: ArrayBuffer,
  header: string | null,
  secret: string | undefined,
): Promise<boolean> {
  if (!header || !secret) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, rawBody));
  const expected = 'sha256=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}
