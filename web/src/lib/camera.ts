/**
 * In-page camera with a framing guide.
 *
 * A slot that carries no guide keeps the system camera app, which focuses,
 * exposes and denoises better than anything a page can drive. We only take that
 * over where framing *is* the problem: a label shot from a metre away comes
 * back sharp, passes every quality check, and is still useless for reading a
 * barcode printed two millimetres tall; an appliance shot from across the room
 * occupies a fifth of the frame. The guide is what sets the distance.
 *
 * Nothing here is load-bearing: any failure falls back to the system camera.
 */

export interface Guide {
  hint: string;
  shape: 'label' | 'full';
}

/**
 * The torch is real on Android Chrome but absent from the DOM typings, on both
 * the capability and the constraint. Widening the two isolated values beats
 * casting the calls that carry them.
 */
const torchCapability = (track: MediaStreamTrack): boolean =>
  !!(track.getCapabilities?.() as { torch?: boolean } | undefined)?.torch;
const torchConstraint = (on: boolean) =>
  ({ advanced: [{ torch: on }] }) as unknown as MediaTrackConstraints;

export function cameraSupported(): boolean {
  return !!navigator.mediaDevices?.getUserMedia;
}

/**
 * Opens the camera full screen and resolves with the JPEG, or with `null` when
 * the client backs out.
 *
 * Rejects when the camera cannot be opened at all — permission refused, no
 * device, browser refusal. The caller then opens the system camera instead.
 */
export async function captureWithGuide(guide: Guide): Promise<Blob | null> {
  // Permission is asked before anything is drawn: on a refusal the client sees
  // their own screen, not a black rectangle they have to dismiss.
  const stream = await navigator.mediaDevices.getUserMedia({
    // A still is downscaled to 2576 px on this slot, and the barcode digits
    // stop resolving below roughly 1500. Asking for 4K costs nothing — the
    // browser hands back the closest mode the camera actually has.
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 3840 },
      height: { ideal: 2160 },
    },
    audio: false,
  });

  const track = stream.getVideoTracks()[0];
  const hasTorch = track ? torchCapability(track) : false;

  const root = document.createElement('div');
  root.className = 'cam';
  root.innerHTML = `
    <video class="cam-view" playsinline muted autoplay></video>
    <div class="cam-guide ${guide.shape}"></div>
    <p class="cam-hint">${guide.hint}</p>
    <div class="cam-bar">
      <button type="button" class="cam-side" data-cam="cancel">Annuler</button>
      <button type="button" class="cam-shutter" data-cam="shoot" aria-label="Prendre la photo"></button>
      <button type="button" class="cam-side" data-cam="torch" aria-pressed="false">${
        hasTorch ? '💡' : ''
      }</button>
    </div>`;

  const video = root.querySelector('video')!;
  video.srcObject = stream;
  document.body.appendChild(root);

  try {
    await video.play();
  } catch {
    // Autoplay refused: nothing would ever appear, so hand the slot back to the
    // system camera rather than showing a frozen black screen.
    close(root, stream);
    throw new Error('camera-play-refused');
  }

  return new Promise<Blob | null>((resolve) => {
    let torchOn = false;

    const finish = (blob: Blob | null) => {
      document.removeEventListener('keydown', onKey);
      close(root, stream);
      resolve(blob);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(null);
    };
    document.addEventListener('keydown', onKey);

    root.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>('[data-cam]')?.dataset
        .cam;
      if (action === 'cancel') return finish(null);
      if (action === 'torch') {
        torchOn = !torchOn;
        void track.applyConstraints(torchConstraint(torchOn)).catch(() => {
          // Some devices advertise the torch and refuse it. Not worth a message.
        });
        (e.target as HTMLElement).setAttribute('aria-pressed', String(torchOn));
        return;
      }
      if (action !== 'shoot') return;

      root.classList.add('shot-taken');
      void grab(video).then(finish);
    });
  });
}

function grab(video: HTMLVideoElement): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(video, 0, 0);

  // Near-lossless: this JPEG is decoded and re-encoded by the normaliser right
  // after, and two lossy passes on barcode digits is one too many.
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
}

function close(root: HTMLElement, stream: MediaStream): void {
  stream.getTracks().forEach((t) => t.stop());
  root.remove();
}
