import type { Answers, Diagnosis, DiagnosisCase, PhotoSlot } from '../../../shared/types';

/**
 * Production API origin.
 *
 * Held in the repository, not in a Cloudflare dashboard field. That field was
 * a second source of truth and it drifted: it still named the workers.dev
 * hostname after the custom domain replaced it, so every deployed build called
 * a host that no longer served the Worker.
 *
 * `VITE_API_URL` is honoured in development only. A stale value in the build
 * environment can therefore no longer break production.
 */
const PRODUCTION_API = 'https://diag-api.soscumulus.fr';

const BASE = import.meta.env.DEV
  ? ((import.meta.env.VITE_API_URL as string | undefined) ?? '')
  : PRODUCTION_API;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new ApiError(
      res.status,
      body.error ?? 'unknown',
      body.message ?? 'Erreur réseau.',
    );
  }
  return (await res.json()) as T;
}

export const getCase = (token: string) =>
  request<DiagnosisCase>(`/api/case/${token}`);

export const patchAnswers = (token: string, patch: Partial<Answers>) =>
  request<{ answers: Answers; status: string; emergencyPhone?: string }>(
    `/api/case/${token}/answers`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    },
  );

export const skipPhoto = (token: string, slot: PhotoSlot) =>
  request<{ slot: PhotoSlot; skipped: true }>(
    `/api/case/${token}/photo/${slot}/skip`,
    { method: 'POST' },
  );

export const submit = (token: string) =>
  request<{ status: string; diagnosis: Diagnosis }>(`/api/case/${token}/submit`, {
    method: 'POST',
  });

export async function uploadPhoto(
  token: string,
  slot: PhotoSlot,
  blob: Blob,
): Promise<void> {
  await request(`/api/case/${token}/photo?slot=${slot}`, {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg' },
    body: blob,
  });
}

/**
 * Send the control-panel frames, in order.
 *
 * Sequential rather than parallel: the target network is a basement, where
 * five concurrent requests hinder each other more than they help, and order
 * carries meaning here. `onProgress` drives the progress indicator.
 */
export async function uploadPanelFrames(
  token: string,
  blobs: Blob[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  for (let i = 0; i < blobs.length; i++) {
    await request(`/api/case/${token}/panel?i=${i}&n=${blobs.length}`, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg' },
      body: blobs[i],
    });
    onProgress?.(i + 1, blobs.length);
  }
}

/**
 * Send the source video, kept for human review.
 *
 * `XMLHttpRequest` rather than `fetch`: it is the only API exposing upload
 * progress on every targeted mobile browser. For a 20 MB file on a basement
 * network, showing a real percentage rather than a spinner is the difference
 * between waiting and closing the tab.
 *
 * Made abortable so leaving the screen does not keep a pointless upload alive.
 */
export function uploadPanelVideo(
  token: string,
  file: File,
  onProgress?: (ratio: number) => void,
): { done: Promise<void>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<void>((resolve, reject) => {
    xhr.open('POST', `${BASE}/api/case/${token}/panel/video`);
    xhr.setRequestHeader('content-type', file.type || 'video/mp4');

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    });
    xhr.addEventListener('load', () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new ApiError(xhr.status, 'upload_failed', xhr.responseText)),
    );
    xhr.addEventListener('error', () =>
      reject(new ApiError(0, 'network', 'Envoi interrompu.')),
    );
    xhr.addEventListener('abort', () =>
      reject(new ApiError(0, 'aborted', 'Envoi annulé.')),
    );

    xhr.send(file);
  });

  return { done, abort: () => xhr.abort() };
}

export async function waitForPanel(
  token: string,
  { timeoutMs = 30_000, intervalMs = 1_500 } = {},
): Promise<DiagnosisCase | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const found = await getCase(token).catch(() => null);
    if (found && found.panel.analysisStatus !== 'pending') return found;
  }
  return null;
}

/**
 * Wait for the model's verdict on one photo.
 *
 * The analysis runs server-side after the upload response, which avoids
 * holding the connection open. We therefore poll the case until the slot
 * leaves the `pending` state.
 *
 * The timeout is deliberate: past it we hand control back to the client rather
 * than blocking them. A late analysis is no reason to stop them moving on —
 * the photo is stored and the technician will see it.
 */
export async function waitForAnalysis(
  token: string,
  slot: PhotoSlot,
  { timeoutMs = 25_000, intervalMs = 1_200 } = {},
): Promise<DiagnosisCase | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const found = await getCase(token).catch(() => null);
    if (!found) continue;
    if (found.photos[slot].analysisStatus !== 'pending') return found;
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
