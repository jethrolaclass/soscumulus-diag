import type {
  Answers,
  Diagnostic,
  Dossier,
  PhotoSlot,
} from '../../../shared/types';

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

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

export const getDossier = (token: string) =>
  request<Dossier>(`/api/dossier/${token}`);

export const patchAnswers = (token: string, patch: Partial<Answers>) =>
  request<{ answers: Answers; status: string; urgenceTel?: string }>(
    `/api/dossier/${token}/answers`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    },
  );

export const skipPhoto = (token: string, slot: PhotoSlot) =>
  request<{ slot: PhotoSlot; skipped: true }>(
    `/api/dossier/${token}/photo/${slot}/skip`,
    { method: 'POST' },
  );

export const submit = (token: string) =>
  request<{ status: string; diagnostic: Diagnostic }>(
    `/api/dossier/${token}/submit`,
    { method: 'POST' },
  );

export async function uploadPhoto(
  token: string,
  slot: PhotoSlot,
  blob: Blob,
): Promise<void> {
  await request(`/api/dossier/${token}/photo?slot=${slot}`, {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg' },
    body: blob,
  });
}

/**
 * Attend le verdict du vLLM sur une photo.
 *
 * L'analyse tourne côté serveur après la réponse d'upload, ce qui évite de
 * tenir la connexion ouverte. On interroge donc le dossier jusqu'à ce que
 * l'emplacement quitte l'état `pending`.
 *
 * Le délai maximal est délibéré : au-delà, on rend la main au client plutôt
 * que de le bloquer. Une analyse en retard n'est pas une raison de l'empêcher
 * d'avancer — la photo est stockée et le technicien la verra.
 */
export async function waitForAnalysis(
  token: string,
  slot: PhotoSlot,
  { timeoutMs = 25_000, intervalMs = 1_200 } = {},
): Promise<Dossier | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const dossier = await getDossier(token).catch(() => null);
    if (!dossier) continue;
    if (dossier.photos[slot].analysisStatus !== 'pending') return dossier;
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
