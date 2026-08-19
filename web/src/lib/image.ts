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

/** Size of the centre crop analysed for sharpness. */
const SHARPNESS_CROP = 640;

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
  verdict: 'ok' | 'blurry' | 'dark' | 'overexposed';
}

/*
 * Deliberately permissive thresholds: this check is only a pre-filter meant to
 * avoid an upload and an API call for an obviously unusable photo (finger over
 * the lens, unlit basement). The real judge of quality is the model, the only
 * one able to say "sharp but too far to read the label". Do not tighten these
 * values without recalibrating them on real photos: the variance of the
 * Laplacian depends heavily on the sensor.
 */
const THRESHOLDS = {
  sharpness: 90,
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

/**
 * Measure sharpness on a centre crop, never on the whole resized image:
 * shrinking an image blurs it, so measuring after the resize mostly measures
 * the resampling artefact. The subject of interest (label, leak) also sits
 * almost always at the centre of the frame.
 */
function measure(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): LocalQuality {
  const side = Math.min(SHARPNESS_CROP, width, height);
  const sx = Math.floor((width - side) / 2);
  const sy = Math.floor((height - side) / 2);
  const { data } = ctx.getImageData(sx, sy, side, side);

  const gray = new Float32Array(side * side);
  let sum = 0;
  let blown = 0;
  for (let i = 0; i < side * side; i++) {
    const o = i * 4;
    const v = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    gray[i] = v;
    sum += v;
    if (v > 250) blown++;
  }
  const brightness = sum / gray.length;
  const blownOut = blown / gray.length;

  // Variance of the Laplacian (Pech-Pacheco et al.) — the mean absolute value
  // used by the prototype saturates on textured images and does not
  // discriminate focus blur.
  let lapSum = 0;
  let lapSumSq = 0;
  let count = 0;
  for (let y = 1; y < side - 1; y++) {
    for (let x = 1; x < side - 1; x++) {
      const i = y * side + x;
      const lap =
        -4 * gray[i] + gray[i - 1] + gray[i + 1] + gray[i - side] + gray[i + side];
      lapSum += lap;
      lapSumSq += lap * lap;
      count++;
    }
  }
  const mean = lapSum / count;
  const sharpness = lapSumSq / count - mean * mean;

  let verdict: LocalQuality['verdict'] = 'ok';
  if (brightness < THRESHOLDS.brightnessLow) verdict = 'dark';
  else if (blownOut > THRESHOLDS.blownOut) verdict = 'overexposed';
  else if (sharpness < THRESHOLDS.sharpness) verdict = 'blurry';

  return { sharpness, brightness, blownOut, verdict };
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
