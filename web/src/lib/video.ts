/**
 * Extraction d'images fixes depuis la vidéo du bandeau de commande.
 *
 * Pourquoi filmer puis découper plutôt que photographier : les chauffe-eau
 * électroniques signalent leurs défauts par une *séquence* de clignotements —
 * trois éclats courts puis un long ne décrit pas la même panne qu'un
 * clignotement continu. Une photo unique perd l'information ; une poignée
 * d'images régulièrement espacées la conserve.
 *
 * La vidéo brute n'est jamais envoyée. Dix secondes de capture pèsent 15 à
 * 25 Mo sur un téléphone récent, soit une minute d'attente sur le réseau d'une
 * cave, pour un fichier que le technicien ne consultera pas si les images
 * suffisent. Les images extraites totalisent environ 250 Ko.
 */

/**
 * Cinq images sur dix secondes : assez pour caractériser une séquence de
 * clignotements, sans faire exploser le coût en tokens image (chaque image
 * facturée est une image de plus dans le même appel).
 */
const FRAME_COUNT = 5;

/**
 * Plus petit que pour les photos : il s'agit de lire deux caractères sur un
 * afficheur ou de repérer quel voyant est allumé, pas de déchiffrer une
 * étiquette imprimée en corps 6.
 */
const MAX_EDGE = 1024;
const JPEG_QUALITY = 0.85;

/** Les premières fractions de seconde servent à la mise au point. */
const LEAD_IN_S = 0.4;
const TAIL_S = 0.2;

/** Au-delà, on considère la lecture de métadonnées ou le seek en échec. */
const STEP_TIMEOUT_MS = 6_000;

export interface ExtractedFrames {
  blobs: Blob[];
  /** Pour l'aperçu — à révoquer par l'appelant. */
  previewUrl: string;
  durationS: number;
}

export class VideoError extends Error {
  constructor(
    public code: 'metadata' | 'seek' | 'decode' | 'empty',
    message: string,
  ) {
    super(message);
  }
}

export async function extractFrames(file: File): Promise<ExtractedFrames> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  // `muted` et `playsInline` sont indispensables : sans eux iOS refuse de
  // décoder une vidéo hors interaction utilisateur, et le seek ne rend jamais.
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  try {
    const duration = await loadDuration(video);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new VideoError('decode', 'Canvas indisponible.');

    const usable = Math.max(0, duration - LEAD_IN_S - TAIL_S);
    const blobs: Blob[] = [];

    for (let i = 0; i < FRAME_COUNT; i++) {
      // Répartition régulière : c'est l'espacement constant qui rend la
      // séquence lisible. Ne pas trier ces images par netteté.
      const t = LEAD_IN_S + (usable * i) / Math.max(1, FRAME_COUNT - 1);
      await seek(video, Math.min(t, duration - 0.05));

      if (i === 0) {
        const scale = Math.min(
          1,
          MAX_EDGE / Math.max(video.videoWidth, video.videoHeight),
        );
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      blobs.push(await toJpeg(canvas));
    }

    if (blobs.length === 0) {
      throw new VideoError('empty', 'Aucune image extraite.');
    }

    return {
      blobs,
      previewUrl: URL.createObjectURL(blobs[Math.floor(blobs.length / 2)]),
      durationS: duration,
    };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * Certains conteneurs — notamment ce que produisent des enregistreurs
 * navigateur — annoncent une durée infinie tant qu'on n'a pas cherché la fin
 * du flux. On force alors un seek très lointain pour que le lecteur recalcule.
 */
async function loadDuration(video: HTMLVideoElement): Promise<number> {
  await once(video, 'loadedmetadata', 'metadata');

  if (Number.isFinite(video.duration) && video.duration > 0) {
    return video.duration;
  }

  video.currentTime = 1e6;
  await once(video, 'timeupdate', 'metadata').catch(() => undefined);
  video.currentTime = 0;

  if (!Number.isFinite(video.duration) || video.duration <= 0) {
    throw new VideoError('metadata', 'Durée de la vidéo illisible.');
  }
  return video.duration;
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  video.currentTime = Math.max(0, time);
  return once(video, 'seeked', 'seek');
}

function once(
  el: HTMLVideoElement,
  event: string,
  code: VideoError['code'],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new VideoError(code, `Délai dépassé sur « ${event} ».`));
    }, STEP_TIMEOUT_MS);

    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new VideoError('decode', 'Vidéo non décodable.'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      el.removeEventListener(event, onOk);
      el.removeEventListener('error', onErr);
    };

    el.addEventListener(event, onOk, { once: true });
    el.addEventListener('error', onErr, { once: true });
  });
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new VideoError('decode', 'Encodage échoué.'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}
