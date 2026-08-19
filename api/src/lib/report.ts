/**
 * Intervention report generation and safety alert.
 *
 * The Worker does not write the document itself: it pushes a payload to a
 * Google Apps Script web app that fills a Google Docs template and exports it.
 * That choice follows the tooling already in place on soscumulus.fr — the site
 * form already goes through Apps Script — and keeps the template editable by a
 * non-developer, which a code-generated PDF would not.
 */

import type {
  DiagnosisCase,
  PhotoSlot,
  SafetyFlag,
} from '../../../shared/types';
import type { Env } from '../env';
import { getPhotoKey, logEvent, panelFrameKey, panelVideoKey } from './db';
import { signedImageUrl } from './signing';

/**
 * Report photo links live as long as the case. Apps Script must embed the
 * images into the document at generation time rather than keep the links: past
 * the purge, the URLs stop answering.
 */
const REPORT_LINK_TTL_S = 7 * 86_400;

/**
 * The secret travels as a query parameter, not a header: Apps Script's
 * `doPost` does not expose custom headers. The link stays HTTPS, so the
 * parameter is not observable in transit — but it may show up in Google's
 * logs, which is why it must be rotated as a secret in its own right and never
 * reused elsewhere.
 */
function webhookUrl(env: Env): string {
  const url = new URL(env.REPORT_WEBHOOK_URL);
  url.searchParams.set('secret', env.REPORT_SECRET);
  return url.toString();
}

export async function pushReport(
  env: Env,
  token: string,
  diagnosisCase: DiagnosisCase,
): Promise<void> {
  if (!env.REPORT_WEBHOOK_URL) return;

  const photos = await Promise.all(
    ([1, 2, 3] as PhotoSlot[]).map(async (slot) => {
      const key = await getPhotoKey(env, token, slot);
      return {
        slot,
        skipped: diagnosisCase.photos[slot].skipped,
        url: key
          ? await signedImageUrl(
              env.SIGNING_KEY,
              env.PUBLIC_API_URL,
              key,
              REPORT_LINK_TTL_S,
            )
          : null,
        analysis: diagnosisCase.photos[slot].analysis,
      };
    }),
  );

  // Panel frames go to the archive too: they are what the model actually read,
  // so they are the only way to re-check a doubtful reading.
  const panelFrames = await Promise.all(
    Array.from({ length: diagnosisCase.panel.frameCount }, async (_, i) => ({
      index: i,
      url: await signedImageUrl(
        env.SIGNING_KEY,
        env.PUBLIC_API_URL,
        panelFrameKey(token, i),
        REPORT_LINK_TTL_S,
      ),
    })),
  );

  // The video upload is deferred: by the time the report is generated it may
  // have arrived, be in flight, or never have started. Ask R2 rather than
  // trusting the state read at submission time.
  const videoKey = panelVideoKey(token);
  const videoUrl = (await env.PHOTOS.head(videoKey))
    ? await signedImageUrl(
        env.SIGNING_KEY,
        env.PUBLIC_API_URL,
        videoKey,
        REPORT_LINK_TTL_S,
      )
    : null;

  try {
    const res = await fetch(webhookUrl(env), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'report',
        ref: diagnosisCase.ref,
        // The client's own link. Apps Script has no other way to find the lead's
        // row again: it is the only value on that row carrying the case token.
        caseUrl: `${env.PUBLIC_WEB_URL}/d/${token}`,
        phone: diagnosisCase.phone,
        city: diagnosisCase.city,
        reportedIssue: diagnosisCase.reportedIssue,
        answers: diagnosisCase.answers,
        diagnosis: diagnosisCase.diagnosis,
        panel: diagnosisCase.panel.analysis,
        panelFrames,
        panelVideoUrl: videoUrl,
        photos,
        createdAt: diagnosisCase.createdAt,
      }),
    });
    // A 200 is not a success. Apps Script answers 200 to everything — its own
    // errors are a JSON body with `ok: false`, and an unreachable or
    // unauthorised deployment answers an HTML page through a redirect. Trusting
    // the status alone logged "report generated" on files that never existed.
    const answer = (await res.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      doc?: string;
    } | null;
    if (!res.ok || !answer?.ok) {
      const detail = answer?.error ?? (answer ? 'réponse inattendue' : 'réponse non JSON');
      throw new Error(`Apps Script ${res.status} — ${detail}`);
    }
    await logEvent(env, token, 'report_generated', `${diagnosisCase.ref} ${answer.doc ?? ''}`);
  } catch (err) {
    // The diagnosis is already stored: the report can be replayed from the
    // event log without the client having to redo anything.
    console.error('report generation failed', err);
    await logEvent(env, token, 'report_failed', String(err).slice(0, 200));
  }
}

/**
 * Hazard declared: water on electrics, tripping breaker, gas smell. Goes out
 * immediately, ahead of any queue.
 */
export async function sendSafetyAlert(
  env: Env,
  ref: string,
  phone: string,
  city: string | null,
  flags: SafetyFlag[],
): Promise<void> {
  if (!env.REPORT_WEBHOOK_URL) return;
  try {
    const res = await fetch(webhookUrl(env), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'safety_alert', ref, phone, city, flags }),
    });
    // Same blindness as the report: Apps Script answers 200 to its own errors.
    // This is the one message in the product that must not fail quietly — a
    // client has declared a hazard and is waiting for a call back.
    const answer = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    if (!res.ok || !answer?.ok) {
      throw new Error(`Apps Script ${res.status} — alerte non confirmée`);
    }
  } catch (err) {
    console.error('safety alert not delivered', err);
  }
}
