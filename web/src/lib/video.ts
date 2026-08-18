/**
 * Extract still frames from the control-panel video.
 *
 * Why film then slice rather than photograph: electronic water heaters signal
 * faults through a *sequence* of blinks — three short flashes then a long one
 * is not the same fault as a steady blink. A single photo loses that
 * information; a handful of evenly spaced frames keeps it.
 *
 * The frames are what the model reads. The source video is uploaded separately
 * and off the critical path, for human review only.
 */

/**
 * Five frames over ten seconds: enough to characterise a blink sequence
 * without blowing up the image-token cost, since every frame is one more
 * billed image in the same call.
 */
const FRAME_COUNT = 5;

/**
 * Smaller than for photos: the job is reading two characters on a display or
 * spotting which light is on, not deciphering a label printed in 6 point.
 */
const MAX_EDGE = 1024;
const JPEG_QUALITY = 0.85;

/** The first fractions of a second are spent focusing. */
const LEAD_IN_S = 0.4;
const TAIL_S = 0.2;

/** Past this, metadata reading or seeking is considered failed. */
const STEP_TIMEOUT_MS = 6_000;

export interface ExtractedFrames {
  blobs: Blob[];
  /** For the preview — the caller must revoke it. */
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
  // `muted` and `playsInline` are mandatory: without them iOS refuses to
  // decode a video outside a user gesture and the seek never resolves.
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  try {
    const duration = await loadDuration(video);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new VideoError('decode', 'Canvas unavailable.');

    const usable = Math.max(0, duration - LEAD_IN_S - TAIL_S);
    const blobs: Blob[] = [];

    for (let i = 0; i < FRAME_COUNT; i++) {
      // Even spacing: it is the constant interval that makes the sequence
      // readable. Do not sort these frames by sharpness.
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
      throw new VideoError('empty', 'No frame extracted.');
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
 * Some containers — notably those produced by browser recorders — report an
 * infinite duration until the end of the stream has been sought. We force a
 * very distant seek so the player recomputes it.
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
    throw new VideoError('metadata', 'Video duration unreadable.');
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
      reject(new VideoError(code, `Timed out waiting for "${event}".`));
    }, STEP_TIMEOUT_MS);

    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new VideoError('decode', 'Video cannot be decoded.'));
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
      (b) => (b ? resolve(b) : reject(new VideoError('decode', 'Encoding failed.'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}
