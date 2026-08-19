import './styles.css';
import type {
  Answers,
  Diagnosis,
  DiagnosisCase,
  PhotoAnalysis,
  PhotoSlot,
  SafetyFlag,
} from '../../shared/types';
import { BLOCKING_SAFETY_FLAGS, isAnalyzedSlot } from '../../shared/types';
import type { LocalVerdict } from '../../shared/types';
import * as api from './lib/api';
import { cameraSupported, captureWithGuide } from './lib/camera';
import { localGuidance, normalizePhoto } from './lib/image';
import { extractFrames } from './lib/video';
import {
  CONTEXT_QUESTIONS,
  PANEL_SCREEN,
  PHOTO_SCREENS,
  PROBLEM_QUESTIONS,
  SAFETY_QUESTION,
  SCREEN_META,
  type Question,
  type ScreenId,
} from './questions';

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

interface CaptureUi {
  previewUrl: string | null;
  /** Message shown under the preview. */
  verdict: { tone: 'ok' | 'ko' | 'wait'; text: string } | null;
  busy: boolean;
  /** The client may keep a rejected photo: we never block them. */
  keepOffered: boolean;
  /**
   * The reading held in state describes the photo currently on screen.
   *
   * False from the moment a new capture replaces the preview until its own
   * analysis comes back. Without it the previous reading stays under the new
   * photo for the whole upload and vision round trip — a client comparing the
   * two would be checking last shot's figures against this shot's label.
   */
  analysisMatchesShot: boolean;
  /**
   * What the local check measured on the photo on screen.
   *
   * Kept because it is the only thing we can honestly say about a slot the
   * model never sees: sharp, or accepted despite a reservation. It also has to
   * survive the "keep it anyway" path, where the upload happens later.
   */
  localVerdict: LocalVerdict;
}

const state = {
  token: '',
  data: null as DiagnosisCase | null,
  screen: 's0' as ScreenId,
  answers: {} as Answers,
  photoUi: {
    1: emptyCaptureUi(),
    2: emptyCaptureUi(),
    3: emptyCaptureUi(),
  } as Record<PhotoSlot, CaptureUi>,
  diagnosis: null as Diagnosis | null,
  submitting: false,
  /** Photo rejected by the local pre-filter, kept if the client insists. */
  pendingBlob: null as Blob | null,
  panelUi: emptyCaptureUi(),
  panelSkipped: false,
  /** Source-video upload, carried out in the background. */
  video: {
    active: false,
    ratio: 0,
    lastPct: -1,
    failed: false,
    abort: null as (() => void) | null,
  },
};

function emptyCaptureUi(): CaptureUi {
  return {
    previewUrl: null,
    verdict: null,
    busy: false,
    keepOffered: false,
    analysisMatchesShot: true,
    localVerdict: 'ok',
  };
}

const app = document.getElementById('app')!;

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

async function boot(): Promise<void> {
  const token = location.pathname.split('/').filter(Boolean).pop() ?? '';
  if (!token || token === 'd') return renderFatal('Lien incomplet.');

  state.token = token;
  try {
    state.data = await api.getCase(token);
  } catch {
    return renderFatal(
      "Ce lien n'est plus valide. Contactez-nous et nous vous en enverrons un nouveau.",
    );
  }

  state.answers = state.data.answers ?? {};
  state.diagnosis = state.data.diagnosis;

  // Resuming mid-journey: the client may have closed the tab and reopened the
  // text later. Put them back where they stopped rather than at the start.
  if (state.data.status === 'safety_stop') state.screen = 's-stop';
  else if (state.data.status === 'submitted') state.screen = 's6';
  else state.screen = resumeScreen(state.data);

  // Resuming: the verdict is rebuilt from the case, not lost with the page.
  // On a slot the model never sees, the browser's own reading is what is left,
  // which is exactly why it travels with the upload.
  for (const slot of [1, 2, 3] as PhotoSlot[]) {
    const p = state.data.photos[slot];
    if (!p.uploaded) continue;
    if (p.analysis) {
      state.photoUi[slot].verdict = verdictFor(p.analysis.usable, p.analysis.guidance);
    } else if (p.localVerdict) {
      state.photoUi[slot].localVerdict = p.localVerdict;
      state.photoUi[slot].verdict = localVerdictMessage(p.localVerdict);
    }
  }

  render();
}

function resumeScreen(d: DiagnosisCase): ScreenId {
  if (!d.answers.safety?.length) return 's0';
  for (const slot of [1, 2, 3] as PhotoSlot[]) {
    const p = d.photos[slot];
    if (!p.uploaded && !p.skipped) return `s${slot}` as ScreenId;
  }
  if (!d.answers.waterLocation || !d.answers.hotWater || !d.answers.hasPanel) {
    return 's4';
  }
  if (d.answers.hasPanel === 'yes' && !d.panel.captured) return 's4b';
  return 's5';
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function render(): void {
  const d = state.data;
  const meta = SCREEN_META[state.screen];

  app.innerHTML = `
    <header class="top">
      <div class="brand">
        <div class="name">SOS Cumulus <span>+</span></div>
        <div class="id">DOSSIER ${d?.ref ?? ''}</div>
      </div>
      <div class="strip" aria-label="Vos trois photos">${slotStrip()}</div>
      <div class="progress" aria-hidden="true"><i style="width:${meta.pct}%"></i></div>
      <div class="step-label"><span>${meta.label}</span><span>≈ 2 minutes</span></div>
    </header>
    ${backgroundUploadBar()}
    <main class="body">${screenBody()}</main>
    ${actionsBar()}
  `;

  bind();
  app.querySelector('.body')?.scrollTo({ top: 0 });
}

/**
 * Visible on every screen while the upload lasts: the video keeps going while
 * the client answers the last questions, and they must be able to see it
 * without navigating back.
 */
function backgroundUploadBar(): string {
  const v = state.video;
  if (v.failed) {
    return `<div class="bgupload">La vidéo n'a pas pu être envoyée — sans conséquence, vos images ont bien été reçues.</div>`;
  }
  if (!v.active) return '';
  return `
    <div class="bgupload" role="status">
      <span>Envoi de la vidéo</span>
      <span class="bar"><i style="width:${Math.round(v.ratio * 100)}%"></i></span>
      <span>${Math.round(v.ratio * 100)} %</span>
    </div>`;
}

function slotStrip(): string {
  return ([1, 2, 3] as PhotoSlot[])
    .map((slot) => {
      const p = state.data?.photos[slot];
      const ui = state.photoUi[slot];
      const active = state.screen === `s${slot}`;
      const done = p?.uploaded || p?.skipped;
      const cls = ['slot', done ? 'done' : '', active ? 'active' : ''].join(' ');
      const label = ['1 · Plaque', '2 · Ensemble', '3 · Fuite'][slot - 1];
      // Same rule as the screen itself: the local preview dies with the page,
      // so past a reload the thumbnail comes back from the API.
      const thumb =
        ui.previewUrl ??
        (p?.uploaded ? api.photoUrl(state.token, slot, p.attempts) : null);
      const inner = thumb
        ? `<img src="${thumb}" alt="">`
        : p?.skipped
          ? '—'
          : label;
      return `<div class="${cls}">${inner}</div>`;
    })
    .join('');
}

function screenBody(): string {
  switch (state.screen) {
    case 's0':
      return welcomeScreen();
    case 's-stop':
      return safetyStopScreen();
    case 's1':
    case 's2':
    case 's3':
      return photoScreen(Number(state.screen[1]) as PhotoSlot);
    case 's4':
      return questionScreen('Le problème', 'Trois questions rapides', PROBLEM_QUESTIONS);
    case 's4b':
      return panelScreen();
    case 's5':
      return questionScreen('Vous et votre logement', 'Presque terminé', CONTEXT_QUESTIONS);
    case 's6':
      return doneScreen();
  }
}

/* ---------- Welcome ---------- */

function welcomeScreen(): string {
  const d = state.data!;
  // The website form already collected phone, city and issue: we show them
  // back to reassure, we never ask again.
  const known = [
    d.phone ? `<span>📞 ${escapeHtml(d.phone)}</span>` : '',
    d.city ? `<span>📍 ${escapeHtml(d.city)}</span>` : '',
  ].join('');

  return `
    <p class="eyebrow">SOS Diag Express</p>
    <h1>Votre diagnostic, sans attendre une visite.</h1>
    <p class="lead">3 photos, quelques questions, et notre technicien vous rappelle avec un diagnostic clair.</p>
    <div class="known">${known}</div>
    ${d.reportedIssue ? `<p class="hint">Votre demande : « ${escapeHtml(d.reportedIssue)} »</p>` : ''}
    <div class="card">${questionBlock(SAFETY_QUESTION)}</div>
    <div class="trust"><span class="lock">🔒</span>Vos photos ne servent qu'à votre diagnostic et à votre dossier d'intervention, conservé 2 ans.</div>
  `;
}

function safetyStopScreen(): string {
  return `
    <div class="stop">
      <p class="eyebrow" style="color:var(--ko)">Sécurité d'abord</p>
      <h2>On vous appelle tout de suite.</h2>
      <p>Votre situation demande un humain, pas un formulaire. En attendant notre appel :</p>
      <ol>
        <li>Coupez le disjoncteur du chauffe-eau (ou le général).</li>
        <li>Fermez le robinet d'arrivée d'eau sous l'appareil, ou l'arrivée générale.</li>
        <li>Ne touchez pas aux fils. Éloignez ce qui est électrique de l'eau.</li>
      </ol>
      <a class="call" href="tel:${escapeHtml(state.data!.emergencyPhone)}">📞 Nous appeler maintenant</a>
    </div>
    <p class="hint" style="margin-top:12px">Un technicien SOS Cumulus a été alerté et vous rappelle au numéro indiqué.</p>
  `;
}

/* ---------- Photos ---------- */

function photoScreen(slot: PhotoSlot): string {
  const cfg = PHOTO_SCREENS[slot];
  const ui = state.photoUi[slot];
  const p = state.data!.photos[slot];

  // The local object URL dies with the page; past a reload the photo comes back
  // from the API. Either way the example steps aside once the client has their
  // own shot — comparing is useful, but their photo is what they came to see.
  const shot = ui.previewUrl ?? (p.uploaded ? api.photoUrl(state.token, slot, p.attempts) : null);

  // The readback promises "retake and we will read it again" — the promise
  // needs a button, not just a sentence, and it belongs directly under the
  // sentence that makes it rather than adrift below the card.
  const retake =
    shot && !ui.busy
      ? `<div class="retake"><button class="skip" data-retake="${slot}">Reprendre la photo</button></div>`
      : '';
  const readback =
    slot === 1 && ui.analysisMatchesShot ? nameplateReadback(p.analysis, retake) : '';

  return `
    <p class="eyebrow">${cfg.eyebrow}</p>
    <h1>${cfg.title}</h1>
    <p class="lead">${cfg.lead}</p>
    ${
      shot
        ? `<div class="shot">
             <img src="${shot}" alt="Votre photo">
             ${verdictOverlay(ui)}
           </div>`
        : `<figure class="example">
             <img src="${cfg.example.src}" alt="Exemple de photo attendue"
                  style="object-position:${cfg.example.focus}" loading="eager">
             <span class="tag">✓ Comme ça</span>
             <figcaption>${escapeHtml(cfg.example.caption)}</figcaption>
           </figure>
           ${verdictHtml(ui)}`
    }
    ${readback || retake}
    ${ui.keepOffered ? `<button class="skip" data-keep="${slot}">Garder cette photo quand même</button>` : ''}
    ${p.skipped || shot ? '' : `<div class="retake"><button class="skip" data-skip="${slot}">${cfg.skipLabel}</button></div>`}
    <input class="sr" type="file" accept="image/*" capture="environment" id="file-${slot}">
  `;
}

/**
 * What the model actually read off the nameplate, shown back to the client.
 *
 * This is the moment the journey stops feeling like a form: seeing "150 litres,
 * 2500 W" appear off their own photo is the proof that the three minutes are
 * buying something. It also catches a misreading while the client is still in
 * front of the unit and can retake the shot.
 *
 * Nameplate only. Screens 2 and 3 produce assessments — clearance, likely leak
 * origin — not readings: the client can neither confirm nor correct them, and
 * showing "cuve percée" before a technician has confirmed it would alarm
 * someone we have not called yet.
 *
 * Only fields actually read are listed; an empty row would advertise a failure
 * the client can do nothing about.
 */
function nameplateReadback(analysis: PhotoAnalysis | null, retake: string): string {
  const n = analysis?.nameplate;
  if (!n?.readable) return '';

  const rows: Array<[string, string]> = [];
  if (n.brand) rows.push(['Marque', n.brand]);
  if (n.model) rows.push(['Référence', n.model]);
  if (n.capacityLiters) rows.push(['Capacité', `${n.capacityLiters} litres`]);
  if (n.powerWatts) rows.push(['Puissance', `${n.powerWatts} W`]);
  if (n.voltage) rows.push(['Alimentation', n.voltage]);
  // Decimal comma: the client is comparing this against a French label.
  if (n.pressureBar)
    rows.push(['Pression max', `${String(n.pressureBar).replace('.', ',')} bar`]);
  if (n.heatUpTime) rows.push(['Temps de chauffe', n.heatUpTime]);
  if (n.tankLining) rows.push(['Cuve', n.tankLining]);
  if (n.protectionIndex) rows.push(['Indice de protection', n.protectionIndex]);
  if (n.manufactureCode) rows.push(['Code de fabrication', n.manufactureCode]);
  if (n.manufactureDate) rows.push(['Fabrication', n.manufactureDate]);
  if (n.serial) rows.push(['N° de série', n.serial]);
  if (n.barcode) rows.push(['Code-barres', n.barcode]);
  if (n.type !== 'unknown') rows.push(['Type', UNIT_TYPES[n.type]]);

  if (rows.length === 0) return '';
  return `
    <div class="readback">
      <p class="readback-title">Ce que nous avons lu sur votre photo</p>
      ${rows
        .map(
          ([k, v]) =>
            `<div class="row"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></div>`,
        )
        .join('')}
      <p class="readback-note">Une erreur ? Reprenez la photo, nous relirons.</p>
      ${retake}
    </div>`;
}

const UNIT_TYPES: Record<string, string> = {
  electric_immersion: 'Électrique blindé',
  electric_steatite: 'Électrique stéatite',
  heat_pump: 'Thermodynamique',
  gas: 'Gaz',
  unknown: '',
};

/**
 * Verdict laid over the bottom of the photo rather than stacked under it.
 *
 * On a phone the screen already carries a heading, a lead, the photo, the
 * readback and two buttons; a separate verdict band pushed the retake button
 * below the fold. Over a scrim it costs no vertical space at all.
 */
function verdictOverlay(ui: CaptureUi): string {
  if (!ui.verdict) return '';
  const spinner = ui.verdict.tone === 'wait' ? '<span class="spinner light"></span>' : '';
  return `<div class="shot-verdict ${ui.verdict.tone}">${spinner}<span>${escapeHtml(ui.verdict.text)}</span></div>`;
}

function verdictHtml(ui: CaptureUi): string {
  if (!ui.verdict) return '';
  if (ui.verdict.tone === 'wait') {
    return `<div class="verdict wait"><span class="spinner"></span>${escapeHtml(ui.verdict.text)}</div>`;
  }
  return `<div class="verdict ${ui.verdict.tone}">${escapeHtml(ui.verdict.text)}</div>`;
}

/* ---------- Control panel ---------- */

function panelScreen(): string {
  const ui = state.panelUi;
  const panel = state.data!.panel;

  // What the model read is shown back to the client: seeing "E3" appear
  // confirms the capture was worth making.
  const reading =
    panel.analysis && (panel.analysis.code || panel.analysis.blinkPattern)
      ? `<div class="learned">Lu sur le bandeau : ${escapeHtml(
          panel.analysis.code ?? panel.analysis.blinkPattern ?? '',
        )}</div>`
      : '';

  return `
    <p class="eyebrow">${PANEL_SCREEN.eyebrow}</p>
    <h1>${PANEL_SCREEN.title}</h1>
    <p class="lead">${PANEL_SCREEN.lead}</p>
    ${ui.previewUrl ? `<div class="shot"><img src="${ui.previewUrl}" alt="Image du bandeau"></div>` : ''}
    ${verdictHtml(ui)}
    ${reading}
    ${state.panelSkipped ? '' : `<div><button class="skip" data-skip-panel>${PANEL_SCREEN.skipLabel}</button></div>`}
    <input class="sr" type="file" accept="video/*" capture="environment" id="file-panel">
  `;
}

/* ---------- Questions ---------- */

function questionScreen(eyebrow: string, title: string, questions: Question[]): string {
  return `
    <p class="eyebrow">${eyebrow}</p>
    <h1>${title}</h1>
    ${questions.map((q) => `<div class="card">${questionBlock(q)}</div>`).join('')}
  `;
}

function questionBlock(q: Question): string {
  const current = state.answers[q.key];
  const isSelected = (value: unknown): boolean =>
    q.multi
      ? Array.isArray(current) && (current as unknown[]).includes(value)
      : current === value;

  return `
    <h2>${q.title}</h2>
    ${q.hint ? `<p class="hint">${q.hint}</p>` : ''}
    <div class="choices" role="group" aria-label="${escapeHtml(q.title)}">
      ${q.choices
        .map(
          (c) => `
        <button class="choice ${c.tone ?? ''}" type="button"
                aria-pressed="${isSelected(c.value)}"
                data-q="${q.key}" data-v="${String(c.value)}">
          <span class="ico" aria-hidden="true">${c.icon}</span>${escapeHtml(c.label)}
        </button>`,
        )
        .join('')}
    </div>
  `;
}

/* ---------- Confirmation ---------- */

function doneScreen(): string {
  const d = state.data!;
  const diagnosis = state.diagnosis;
  const count = ([1, 2, 3] as PhotoSlot[]).filter((s) => d.photos[s].uploaded).length;
  const nameplate = d.photos[1].analysis?.nameplate;
  const unit =
    nameplate?.readable && (nameplate.brand || nameplate.model)
      ? [
          nameplate.brand,
          nameplate.model,
          nameplate.capacityLiters ? `${nameplate.capacityLiters} L` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : 'À confirmer par le technicien';

  return `
    <div class="done-hero"><div class="check">✓</div>
      <h1>Votre dossier est parti.</h1>
      <p class="lead">${diagnosis ? escapeHtml(diagnosis.summary) : 'Notre technicien examine vos éléments.'}</p>
    </div>
    <div class="card recap">
      <h2>Votre dossier ${d.ref}</h2>
      <div class="row"><span class="k">Photos</span><span class="v">${count} / 3</span></div>
      <div class="row"><span class="k">Appareil</span><span class="v">${escapeHtml(unit)}</span></div>
      <div class="row"><span class="k">Rappel</span><span class="v">${escapeHtml(availabilityLabel(d.answers.availability))}</span></div>
    </div>
    <div class="card">
      <h2>Et ensuite ?</h2>
      <ol class="steps">
        <li>Un technicien analyse votre dossier.</li>
        <li>Il vous rappelle avec un diagnostic et un tarif.</li>
        <li>Si une intervention est nécessaire, il arrive avec la bonne pièce.</li>
      </ol>
    </div>
  `;
}

const AVAILABILITY_LABELS: Record<string, string> = {
  morning: 'Le matin',
  midday: 'Vers midi',
  afternoon: "L'après-midi",
  evening: 'En fin de journée',
};
const availabilityLabel = (a?: string) =>
  a ? (AVAILABILITY_LABELS[a] ?? '—') : 'Dès que possible';

/* ------------------------------------------------------------------ */
/* Action bar                                                          */
/* ------------------------------------------------------------------ */

function actionsBar(): string {
  if (state.screen === 's-stop') return '';

  let label = 'Continuer';
  let disabled = false;

  if (isPhotoScreen(state.screen)) {
    const slot = Number(state.screen[1]) as PhotoSlot;
    const p = state.data!.photos[slot];
    const ui = state.photoUi[slot];
    if (ui.busy) {
      label = 'Analyse en cours…';
      disabled = true;
    } else if (p.uploaded || p.skipped) {
      label = 'Continuer →';
    } else {
      label = p.attempts > 0 ? '📷 Reprendre la photo' : '📷 Prendre la photo';
    }
  } else if (state.screen === 's0') {
    disabled = !(state.answers.safety?.length ?? 0);
  } else if (state.screen === 's4') {
    disabled = !PROBLEM_QUESTIONS.every((q) => state.answers[q.key]);
  } else if (state.screen === 's4b') {
    const panel = state.data!.panel;
    if (state.panelUi.busy) {
      label = 'Analyse en cours…';
      disabled = true;
    } else if (panel.captured || state.panelSkipped) {
      label = 'Continuer →';
    } else {
      label = '🎥 Filmer 10 secondes';
    }
  } else if (state.screen === 's5') {
    label = state.submitting ? 'Envoi…' : 'Envoyer mon dossier';
    disabled = state.submitting || !CONTEXT_QUESTIONS.every((q) => state.answers[q.key]);
  } else if (state.screen === 's6') {
    return '';
  }

  const back = state.screen !== 's0';
  return `
    <div class="actions">
      <button class="btn primary" id="primary" ${disabled ? 'disabled' : ''}>${label}</button>
      ${back ? '<button class="btn ghost" id="secondary">Retour</button>' : ''}
    </div>
  `;
}

const isPhotoScreen = (s: ScreenId) => s === 's1' || s === 's2' || s === 's3';

/* ------------------------------------------------------------------ */
/* Interactions                                                        */
/* ------------------------------------------------------------------ */

function bind(): void {
  app.querySelectorAll<HTMLButtonElement>('.choice').forEach((btn) => {
    btn.addEventListener('click', () => onChoice(btn.dataset.q!, btn.dataset.v!));
  });

  app.querySelector('#primary')?.addEventListener('click', onPrimary);
  app.querySelector('#secondary')?.addEventListener('click', onBack);

  app.querySelectorAll<HTMLButtonElement>('[data-skip]').forEach((btn) => {
    btn.addEventListener('click', () => onSkip(Number(btn.dataset.skip) as PhotoSlot));
  });
  app.querySelectorAll<HTMLButtonElement>('[data-retake]').forEach((btn) => {
    btn.addEventListener('click', () =>
      startCapture(Number(btn.dataset.retake) as PhotoSlot),
    );
  });
  app.querySelectorAll<HTMLButtonElement>('[data-keep]').forEach((btn) => {
    btn.addEventListener('click', () => onKeep(Number(btn.dataset.keep) as PhotoSlot));
  });

  if (isPhotoScreen(state.screen)) {
    const slot = Number(state.screen[1]) as PhotoSlot;
    app
      .querySelector<HTMLInputElement>(`#file-${slot}`)
      ?.addEventListener('change', (e) => onFile(e, slot));
  }

  app.querySelector<HTMLInputElement>('#file-panel')?.addEventListener('change', onVideo);
  app.querySelector<HTMLButtonElement>('[data-skip-panel]')?.addEventListener('click', onSkipPanel);
}

function onChoice(key: string, rawValue: string): void {
  const q = [SAFETY_QUESTION, ...PROBLEM_QUESTIONS, ...CONTEXT_QUESTIONS].find(
    (x) => x.key === key,
  )!;

  if (q.multi) {
    const current = new Set((state.answers.safety ?? []) as SafetyFlag[]);
    const value = rawValue as SafetyFlag;
    // "None of these" is exclusive: ticking it clears the hazards, and ticking
    // a hazard clears it.
    if (value === 'none') {
      current.clear();
      current.add('none');
    } else {
      current.delete('none');
      current.has(value) ? current.delete(value) : current.add(value);
    }
    state.answers.safety = [...current];
  } else {
    (state.answers as unknown as Record<string, unknown>)[key] = rawValue;
  }

  render();
  void persistAnswers();
}

async function persistAnswers(): Promise<void> {
  try {
    const res = await api.patchAnswers(state.token, state.answers);
    if (res.status === 'safety_stop') {
      state.screen = 's-stop';
      render();
    }
  } catch {
    // Silent: answers are held locally and will be sent again on submission.
    // Showing a network error here would only worry the client without giving
    // them anything to fix.
  }
}

function onPrimary(): void {
  if (state.screen === 's0') {
    const flags = state.answers.safety ?? [];
    const hazard = flags.some((f) => BLOCKING_SAFETY_FLAGS.includes(f));
    state.screen = hazard ? 's-stop' : 's1';
    return render();
  }

  if (isPhotoScreen(state.screen)) {
    const slot = Number(state.screen[1]) as PhotoSlot;
    const p = state.data!.photos[slot];
    if (p.uploaded || p.skipped) {
      state.screen = slot === 3 ? 's4' : (`s${slot + 1}` as ScreenId);
      return render();
    }
    return void startCapture(slot);
  }

  if (state.screen === 's4') {
    // The panel step only makes sense on an electronic unit.
    state.screen = state.answers.hasPanel === 'yes' ? 's4b' : 's5';
    return render();
  }

  if (state.screen === 's4b') {
    const panel = state.data!.panel;
    if (panel.captured || state.panelSkipped) {
      state.screen = 's5';
      return render();
    }
    return app.querySelector<HTMLInputElement>('#file-panel')?.click();
  }

  if (state.screen === 's5') return void onSubmit();
}

function onBack(): void {
  const back: Partial<Record<ScreenId, ScreenId>> = {
    s1: 's0',
    s2: 's1',
    s3: 's2',
    s4: 's3',
    s4b: 's4',
    s5: state.answers.hasPanel === 'yes' ? 's4b' : 's4',
  };
  const target = back[state.screen];
  if (target) {
    state.screen = target;
    render();
  }
}

/* ---------- Photo capture ---------- */

/**
 * Opens the camera for a slot.
 *
 * A slot that declares a framing guide is shot in the page, over a live
 * preview: it is the only way to tell the client where to stand, and standing
 * close enough is the whole difference between a readable label and a sharp,
 * useless photo. Everything else goes to the system camera app, which focuses
 * and exposes better than a page ever will.
 *
 * Every failure — permission refused, no device, autoplay blocked — falls
 * through to the system camera. The journey never depends on this.
 */
async function startCapture(slot: PhotoSlot): Promise<void> {
  const systemCamera = () => app.querySelector<HTMLInputElement>(`#file-${slot}`)?.click();

  const guide = PHOTO_SCREENS[slot].guide;
  if (!guide || !cameraSupported()) return void systemCamera();

  let shot: Blob | null;
  try {
    shot = await captureWithGuide(guide);
  } catch {
    return void systemCamera();
  }
  // Backed out: leave the screen exactly as it was.
  if (!shot) return;

  await processCapture(slot, new File([shot], `slot-${slot}.jpg`, { type: 'image/jpeg' }));
}

async function onFile(event: Event, slot: PhotoSlot): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  await processCapture(slot, file);
}

async function processCapture(slot: PhotoSlot, file: File): Promise<void> {
  const ui = state.photoUi[slot];
  ui.busy = true;
  ui.keepOffered = false;
  ui.verdict = { tone: 'wait', text: 'Préparation de la photo…' };
  render();

  let normalized;
  try {
    normalized = await normalizePhoto(file, slot);
  } catch {
    // Exotic format or undecodable file: we have no usable photo, but we do
    // not send the client into a wall — they can skip the step.
    ui.busy = false;
    ui.verdict = {
      tone: 'ko',
      text: "Cette photo n'a pas pu être lue. Réessayez, ou passez cette étape.",
    };
    return render();
  }

  if (ui.previewUrl) URL.revokeObjectURL(ui.previewUrl);
  ui.previewUrl = normalized.previewUrl;
  // From here the photo on screen is not the one that was read.
  ui.analysisMatchesShot = false;

  const attempts = state.data!.photos[slot].attempts;
  ui.localVerdict = normalized.quality.verdict;
  const local = localGuidance(normalized.quality.verdict);

  // Local pre-filter, on every slot: it costs nothing and catches the finger
  // over the lens or the unlit cellar before the upload. Once only — on the
  // second attempt the photo goes through whatever it looks like. On the
  // nameplate the model then gives better advice than we can; elsewhere it is
  // the technician who looks, and neither is a reason to hold the client.
  if (local && attempts === 0) {
    ui.busy = false;
    ui.verdict = { tone: 'ko', text: local };
    ui.keepOffered = true;
    state.pendingBlob = normalized.blob;
    return render();
  }

  await upload(slot, normalized.blob);
}

async function upload(slot: PhotoSlot, blob: Blob): Promise<void> {
  const ui = state.photoUi[slot];
  ui.busy = true;
  ui.verdict = { tone: 'wait', text: 'Envoi de la photo…' };
  render();

  try {
    await api.uploadPhoto(state.token, slot, blob, ui.localVerdict);
  } catch {
    ui.busy = false;
    ui.verdict = {
      tone: 'ko',
      text: "L'envoi a échoué. Vérifiez votre réseau et réessayez.",
    };
    return render();
  }

  // Nothing to wait for on a slot the model never sees: polling would only
  // hold the client on a screen whose verdict is already settled.
  //
  // The local check is then the only thing that spoke, so the message says
  // exactly what it measured — sharpness, nothing about framing or subject. A
  // photo sent on a second attempt despite a reservation is acknowledged, not
  // congratulated.
  if (!isAnalyzedSlot(slot)) {
    ui.busy = false;
    ui.analysisMatchesShot = true;
    state.data!.photos[slot].uploaded = true;
    ui.verdict = localVerdictMessage(ui.localVerdict);
    return render();
  }

  ui.verdict = { tone: 'wait', text: 'Vérification de la photo…' };
  render();

  const updated = await api.waitForAnalysis(state.token, slot);
  ui.busy = false;

  if (!updated) {
    // Analysis too slow: accept. The photo is stored and the technician will
    // see it. Blocking the client on a server delay would be absurd.
    state.data!.photos[slot].uploaded = true;
    ui.verdict = { tone: 'ok', text: '✓ Photo reçue.' };
    return render();
  }

  state.data = updated;
  ui.analysisMatchesShot = true;
  const analysis = updated.photos[slot].analysis;
  const attempts = updated.photos[slot].attempts;

  if (!analysis) {
    ui.verdict = { tone: 'ok', text: '✓ Photo reçue.' };
    return render();
  }

  if (!analysis.usable && attempts < 2) {
    ui.verdict = {
      tone: 'ko',
      text: analysis.guidance ?? 'Reprenez la photo, s’il vous plaît.',
    };
    ui.keepOffered = true;
    // `uploaded` stays true server-side: the button offers a retake, but the
    // client may also keep the photo and move on.
    return render();
  }

  ui.verdict = verdictFor(analysis.usable, analysis.guidance);
  render();
}

/**
 * What the browser's own check is allowed to claim: sharpness, and nothing
 * about framing or subject — that was the model's job. A photo sent on a second
 * attempt despite a reservation is acknowledged, never congratulated.
 */
function localVerdictMessage(verdict: LocalVerdict): CaptureUi['verdict'] {
  return { tone: 'ok', text: verdict === 'ok' ? '✓ Photo nette.' : '✓ Photo reçue.' };
}

function verdictFor(usable: boolean, guidance: string | null): CaptureUi['verdict'] {
  if (usable) {
    return {
      tone: 'ok',
      text: guidance ? `✓ Photo reçue. ${guidance}` : '✓ Parfait, photo bien nette.',
    };
  }
  return {
    tone: 'ok',
    text: '✓ Merci — notre technicien vous rappellera si une autre photo est utile.',
  };
}

function onKeep(slot: PhotoSlot): void {
  const ui = state.photoUi[slot];
  ui.keepOffered = false;
  if (state.pendingBlob) {
    const blob = state.pendingBlob;
    state.pendingBlob = null;
    void upload(slot, blob);
    return;
  }
  ui.verdict = { tone: 'ok', text: '✓ Photo conservée.' };
  state.data!.photos[slot].uploaded = true;
  render();
}

async function onSkip(slot: PhotoSlot): Promise<void> {
  try {
    await api.skipPhoto(state.token, slot);
  } catch {
    /* skipping stays possible offline */
  }
  state.data!.photos[slot].skipped = true;
  state.photoUi[slot].verdict = { tone: 'ok', text: PHOTO_SCREENS[slot].skipConfirm };
  state.photoUi[slot].keepOffered = false;
  render();
}

/* ---------- Control panel ---------- */

async function onVideo(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;

  const ui = state.panelUi;
  ui.busy = true;
  ui.verdict = { tone: 'wait', text: 'Lecture de la vidéo…' };
  render();

  let frames;
  try {
    frames = await extractFrames(file);
  } catch {
    // Exotic codec, truncated video, refused seek: nothing can be extracted.
    // The client skips the step rather than being stuck on it.
    ui.busy = false;
    ui.verdict = {
      tone: 'ko',
      text: "Cette vidéo n'a pas pu être lue. Réessayez, ou passez cette étape.",
    };
    return render();
  }

  if (ui.previewUrl) URL.revokeObjectURL(ui.previewUrl);
  ui.previewUrl = frames.previewUrl;

  try {
    await api.uploadPanelFrames(state.token, frames.blobs, (done, total) => {
      ui.verdict = { tone: 'wait', text: `Envoi ${done} / ${total}…` };
      render();
    });
  } catch {
    ui.busy = false;
    ui.verdict = {
      tone: 'ko',
      text: "L'envoi a échoué. Vérifiez votre réseau et réessayez.",
    };
    return render();
  }

  ui.verdict = { tone: 'wait', text: 'Lecture du bandeau…' };
  render();

  const updated = await api.waitForPanel(state.token);
  ui.busy = false;

  // The video upload only starts here, once the verdict is in. Starting it
  // earlier would put twenty megabytes in competition with the polling
  // requests on the same uplink, delaying exactly what the client is waiting
  // for on screen.
  startVideoUpload(file);

  if (!updated) {
    state.data!.panel.captured = true;
    ui.verdict = { tone: 'ok', text: '✓ Images reçues.' };
    return render();
  }

  state.data = updated;
  const analysis = updated.panel.analysis;

  if (analysis && !analysis.usable && analysis.guidance) {
    ui.verdict = { tone: 'ko', text: analysis.guidance };
    return render();
  }

  ui.verdict = {
    tone: 'ok',
    text: analysis?.code
      ? `✓ Code ${analysis.code} relevé sur le bandeau.`
      : '✓ Bandeau enregistré.',
  };
  render();
}

/**
 * Keep the original recording for human review.
 *
 * Nothing awaits this promise: not the "Continue" button, not the submission.
 * A failure is reported without drama — the extracted frames already carry the
 * information the diagnosis needs.
 */
function startVideoUpload(file: File): void {
  state.video.abort?.();
  state.video = { active: true, ratio: 0, lastPct: -1, failed: false, abort: null };

  const { done, abort } = api.uploadPanelVideo(state.token, file, (ratio) => {
    state.video.ratio = ratio;
    // One render per percentage point is enough: refreshing on every progress
    // event would rebuild the DOM dozens of times a second.
    const pct = Math.round(ratio * 100);
    if (pct !== state.video.lastPct) {
      state.video.lastPct = pct;
      render();
    }
  });
  state.video.abort = abort;

  void done
    .then(() => {
      state.video.active = false;
      if (state.data) state.data.panel.videoUploaded = true;
    })
    .catch((err) => {
      state.video.active = false;
      // A deliberate cancellation is not a failure worth reporting.
      state.video.failed = !(err instanceof api.ApiError && err.code === 'aborted');
    })
    .finally(() => {
      state.video.abort = null;
      render();
    });
}

function onSkipPanel(): void {
  state.panelSkipped = true;
  state.panelUi.verdict = { tone: 'ok', text: PANEL_SCREEN.skipConfirm };
  render();
}

/* ---------- Submission ---------- */

async function onSubmit(): Promise<void> {
  state.submitting = true;
  render();
  try {
    const res = await api.submit(state.token);
    state.diagnosis = res.diagnosis;
    state.data = await api.getCase(state.token);
    state.screen = 's6';
  } catch {
    state.screen = 's6';
  } finally {
    state.submitting = false;
    render();
  }
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/**
 * Dead or expired link. The on-call number comes from the case, so it is
 * precisely unavailable here: point at the website rather than hard-coding a
 * value that would drift from the Worker's.
 */
function renderFatal(message: string): void {
  app.innerHTML = `
    <header class="top"><div class="brand"><div class="name">SOS Cumulus <span>+</span></div></div></header>
    <main class="body">
      <h1>Lien indisponible</h1>
      <p class="lead">${escapeHtml(message)}</p>
      <a class="call" href="https://soscumulus.fr">Nous contacter sur soscumulus.fr</a>
    </main>`;
}

void boot();
