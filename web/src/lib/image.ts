/**
 * Normalisation et contrôle qualité d'une photo, côté client.
 *
 * Trois problèmes réglés en un seul passage canvas :
 *  - HEIC : les iPhone shootent en HEIC, que l'API Claude n'accepte pas.
 *    Safari sait le décoder nativement vers un ImageBitmap, donc le
 *    ré-encodage JPEG règle le format sans dépendance externe.
 *  - Orientation EXIF : `imageOrientation: 'from-image'` applique la rotation
 *    avant dessin. Sans ça, une photo prise en portrait arrive couchée.
 *  - Poids : 4 Mo au sortir du capteur, ~300 Ko après. Déterminant sur un
 *    réseau de cave, et plafonne les tokens image facturés.
 *
 * Le ré-encodage supprime au passage les EXIF, dont le GPS : on ne veut pas
 * transporter les coordonnées du domicile du client.
 */

/** Grand côté cible. Aligné sur le palier de tokens image de l'API. */
const MAX_EDGE = 1568;
const JPEG_QUALITY = 0.85;

/** Taille du crop central analysé pour la netteté. */
const SHARPNESS_CROP = 640;

export interface NormalizedPhoto {
  blob: Blob;
  width: number;
  height: number;
  /** URL objet pour l'aperçu. À révoquer par l'appelant. */
  previewUrl: string;
  quality: LocalQuality;
}

export interface LocalQuality {
  /** Variance du Laplacien. Plus c'est haut, plus c'est net. */
  sharpness: number;
  /** Luminance moyenne 0-255. */
  brightness: number;
  /** Part de pixels saturés à blanc — révèle un reflet ou un flash trop près. */
  blownOut: number;
  verdict: 'ok' | 'floue' | 'sombre' | 'surexposee';
}

/*
 * Seuils délibérément permissifs : ce contrôle n'est qu'un pré-filtre destiné à
 * éviter un upload et un appel API pour une photo manifestement inutilisable
 * (doigt sur l'objectif, cave non éclairée). Le juge de la qualité réelle est
 * le vLLM, seul capable de dire « nette mais trop loin pour lire l'étiquette ».
 * Ne pas durcir ces valeurs sans les avoir recalibrées sur de vraies photos :
 * la variance du Laplacien dépend fortement du capteur.
 */
const THRESHOLDS = {
  sharpness: 90,
  brightnessLow: 35,
  blownOut: 0.35,
} as const;

/**
 * Décode, redresse, redimensionne et ré-encode en JPEG.
 * Lève si le fichier n'est pas décodable par le navigateur.
 */
export async function normalizePhoto(file: File): Promise<NormalizedPhoto> {
  const bitmap = await decode(file);

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
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
  // `from-image` applique l'orientation EXIF au décodage. Sans cette option,
  // Chrome et Safari divergent et une photo sur deux arrive couchée.
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Repli pour les navigateurs sans support des options de createImageBitmap.
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
 * Mesure la netteté sur un crop central, jamais sur l'image réduite entière :
 * réduire une image la floute, donc mesurer après réduction revient surtout à
 * mesurer l'artefact du redimensionnement. Le sujet utile (étiquette, fuite)
 * est par ailleurs presque toujours au centre du cadre.
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

  // Variance du Laplacien (Pech-Pacheco et al.) — la moyenne des valeurs
  // absolues, utilisée par le prototype, sature sur les images texturées et
  // ne discrimine pas le flou de mise au point.
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
  if (brightness < THRESHOLDS.brightnessLow) verdict = 'sombre';
  else if (blownOut > THRESHOLDS.blownOut) verdict = 'surexposee';
  else if (sharpness < THRESHOLDS.sharpness) verdict = 'floue';

  return { sharpness, brightness, blownOut, verdict };
}

/** Message client pour un rejet local. Le vLLM produira un message plus fin. */
export function localGuidance(verdict: LocalQuality['verdict']): string | null {
  switch (verdict) {
    case 'sombre':
      return "Un peu sombre — allumez la lumière ou approchez le téléphone, puis réessayez.";
    case 'floue':
      return "Un peu floue — tenez le téléphone bien immobile une seconde, puis réessayez.";
    case 'surexposee':
      return "Trop de reflet — reculez un peu ou décalez-vous sur le côté, puis réessayez.";
    case 'ok':
      return null;
  }
}
