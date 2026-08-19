/**
 * Client-side normalisation and quality control of a photo.
 *
 * Three problems solved in a single canvas pass:
 *  - HEIC: iPhones shoot HEIC, which the Claude API does not accept. Safari
 *    decodes it natively into an ImageBitmap, so re-encoding to JPEG fixes the
 *    format with no external dependency.
 *  - EXIF orientation: `imageOrientation: 'from-image'` applies the rotation
 *    before drawing. Without it, a portrait shot arrives lying on its side.
 *  - Weight: 4 MB off the sensor, ~300 KB after. Decisive on a basement
 *    network, and it caps the billed image tokens.
 *
 * Re-encoding also strips EXIF, GPS included: we do not want to carry the
 * coordinates of the client's home.
 */

import type { LocalVerdict } from '../../../shared/types';

/**
 * Target long edge, per photo slot.
 *
 * The nameplate gets more pixels than the rest because it is the only shot
 * where the job is reading characters — and the barcode digits, printed
 * sideways in a few millimetres, are the finest text on the label. Opus 5
 * accepts up to 2576 px on the long edge; below roughly 1500 those digits stop
 * resolving and the model rightly returns null rather than guess.
 *
 * The other two shots are judged on shape and layout, where 1568 is ample and
 * the extra image tokens would buy nothing.
 */
const MAX_EDGE_BY_SLOT: Record<number, number> = { 1: 2576, 2: 1568, 3: 1568 };
const DEFAULT_MAX_EDGE = 1568;
const JPEG_QUALITY = 0.85;

/**
 * Region analysed for quality, capped so the cost does not follow the slot's
 * resolution: on slots 2 and 3 it is the whole resized image, on the nameplate
 * the central 1568 px, which always contains the label.
 */
const ANALYSIS_MAX = 1568;
/** Side of one sharpness tile. */
const SHARPNESS_TILE = 160;
/** Rank read across the tiles — the 90th percentile, not the maximum. */
const SHARPNESS_RANK = 0.9;

export interface NormalizedPhoto {
  blob: Blob;
  width: number;
  height: number;
  /** Object URL for the preview. The caller must revoke it. */
  previewUrl: string;
  quality: LocalQuality;
}

export interface LocalQuality {
  /** Variance of the Laplacian. Higher means sharper. */
  sharpness: number;
  /** Mean luminance, 0-255. */
  brightness: number;
  /** Share of pixels blown to white — reveals glare or a too-close flash. */
  blownOut: number;
  verdict: LocalVerdict;
}

/*
 * Deliberately permissive thresholds: this check is only a pre-filter meant to
 * avoid an upload and an API call for an obviously unusable photo (finger over
 * the lens, unlit basement). The real judge of quality is the model, the only
 * one able to say "sharp but too far to read the label".
 *
 * The two costs are not symmetrical, and the threshold follows that. Letting a
 * blurry photo through costs one upload and one vision call, after which the
 * model gives better advice than we could. Rejecting a good one sends a client
 * standing in a cellar back to redo a photo that was fine — and tells them
 * something false about their own work.
 *
 * Measured on the field photos we hold, at 1568 px, against the same photos
 * blurred at sigma 2 and 4:
 *
 *   sharp        19.7 · 125.5 · 143.3 · 778 · 2159 · 2679
 *   blurred s=2   1.3 ·   2.4 ·   3.3 ·   5.4 ·  6.1 ·  10.1
 *   blurred s=4   0.8 ·   1.0 ·   1.0 ·   1.2 ·  1.4
 *
 * 8 sits below every sharp reading with a factor of two to spare, and still
 * catches the blur a hand actually produces. Recalibrate before touching it.
 */
const THRESHOLDS = {
  sharpness: 8,
  brightnessLow: 35,
  blownOut: 0.35,
} as const;

/**
 * Decode, straighten, resize and re-encode to JPEG.
 * Throws when the browser cannot decode the file.
 */
export async function normalizePhoto(
  file: File,
  slot?: number,
): Promise<NormalizedPhoto> {
  const bitmap = await decode(file);

  const maxEdge = (slot && MAX_EDGE_BY_SLOT[slot]) || DEFAULT_MAX_EDGE;
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas-unavailable');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const quality = measure(ctx, width, height);
  const blob = await toJpeg(canvas);

  return {
    blob,
    width,
    height,
    previewUrl: URL.createObjectURL(blob),
    quality,
  };
}

async function decode(file: File): Promise<ImageBitmap> {
  // `from-image` applies EXIF orientation at decode time. Without this option
  // Chrome and Safari diverge and every other photo arrives sideways.
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Fallback for browsers without createImageBitmap options support.
    return await decodeViaImgElement(file);
  }
}

function decodeViaImgElement(file: File): Promise<ImageBitmap> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = async () => {
      try {
        resolve(await createImageBitmap(img));
      } catch (err) {
        reject(err);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode-failed'));
    };
    img.src = url;
  });
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('encode-failed'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

function measure(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): LocalQuality {
  const rw = Math.min(width, ANALYSIS_MAX);
  const rh = Math.min(height, ANALYSIS_MAX);
  const sx = Math.floor((width - rw) / 2);
  const sy = Math.floor((height - rh) / 2);
  const { data } = ctx.getImageData(sx, sy, rw, rh);

  const gray = new Float32Array(rw * rh);
  let sum = 0;
  let blown = 0;
  for (let i = 0; i < gray.length; i++) {
    const o = i * 4;
    const v = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    gray[i] = v;
    sum += v;
    if (v > 250) blown++;
  }
  const brightness = sum / gray.length;
  const blownOut = blown / gray.length;
  const sharpness = tiledSharpness(gray, rw, rh);

  let verdict: LocalQuality['verdict'] = 'ok';
  if (brightness < THRESHOLDS.brightnessLow) verdict = 'dark';
  else if (blownOut > THRESHOLDS.blownOut) verdict = 'overexposed';
  else if (sharpness < THRESHOLDS.sharpness) verdict = 'blurry';

  return { sharpness, brightness, blownOut, verdict };
}

/**
 * Sharpness read tile by tile across the frame, not once on a centre crop.
 *
 * The variance of the Laplacian measures high-frequency energy, which needs
 * texture to exist at all. A water heater is a large smooth matte-white
 * cylinder: a perfectly focused photo of one carries almost no high frequency,
 * and on a centre crop the reading is indistinguishable from real blur. Every
 * overview photo we hold scored under the old centre-crop threshold —
 * including the very shot shown to the client as the example to copy.
 *
 * A sharp photo has detail *somewhere*, even when its subject is blank: the
 * edge of the tank, a pipe, the corner of the wall, the maker's badge. A blurry
 * one has it nowhere. So the frame is tiled and the tiles ranked; the 90th
 * percentile rather than the maximum, so one speck of dust or a blown highlight
 * cannot pass for detail.
 */
function tiledSharpness(gray: Float32Array, width: number, height: number): number {
  const tiles: number[] = [];
  for (let ty = 0; ty + SHARPNESS_TILE <= height; ty += SHARPNESS_TILE) {
    for (let tx = 0; tx + SHARPNESS_TILE <= width; tx += SHARPNESS_TILE) {
      tiles.push(laplacianVariance(gray, width, tx, ty, SHARPNESS_TILE));
    }
  }
  // An image smaller than one tile is not something a phone camera produces,
  // but a single reading beats returning zero and calling it blurry.
  if (tiles.length === 0) {
    return laplacianVariance(gray, width, 0, 0, Math.min(width, height));
  }
  tiles.sort((a, b) => a - b);
  return tiles[Math.floor(tiles.length * SHARPNESS_RANK)];
}

/**
 * Variance of the Laplacian (Pech-Pacheco et al.) over one square of the
 * frame — the mean absolute value used by the prototype saturates on textured
 * images and does not discriminate focus blur.
 */
function laplacianVariance(
  gray: Float32Array,
  stride: number,
  x0: number,
  y0: number,
  side: number,
): number {
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = y0 + 1; y < y0 + side - 1; y++) {
    for (let x = x0 + 1; x < x0 + side - 1; x++) {
      const i = y * stride + x;
      const lap =
        -4 * gray[i] + gray[i - 1] + gray[i + 1] + gray[i - stride] + gray[i + stride];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

/** Client message for a local rejection. The model produces a finer one. */
export function localGuidance(verdict: LocalQuality['verdict']): string | null {
  switch (verdict) {
    case 'dark':
      return "Un peu sombre — allumez la lumière ou approchez le téléphone, puis réessayez.";
    case 'blurry':
      return "Un peu floue — tenez le téléphone bien immobile une seconde, puis réessayez.";
    case 'overexposed':
      return "Trop de reflet — reculez un peu ou décalez-vous sur le côté, puis réessayez.";
    case 'ok':
      return null;
  }
}
