import './styles.css';
import type {
  Answers,
  Diagnostic,
  Dossier,
  PhotoSlot,
  SafetyFlag,
} from '../../shared/types';
import { BLOCKING_SAFETY_FLAGS } from '../../shared/types';
import * as api from './lib/api';
import { localGuidance, normalizePhoto } from './lib/image';
import {
  CONTEXT_QUESTIONS,
  PHOTO_SCREENS,
  PROBLEM_QUESTIONS,
  SAFETY_QUESTION,
  SCREEN_META,
  SAFETY_QUESTION as SAFETY,
  type Question,
  type ScreenId,
} from './questions';

/* ------------------------------------------------------------------ */
/* État                                                                */
/* ------------------------------------------------------------------ */

interface PhotoUi {
  previewUrl: string | null;
  /** Message affiché sous l'aperçu. */
  verdict: { tone: 'ok' | 'ko' | 'wait'; text: string } | null;
  busy: boolean;
  /** Le client peut conserver une photo refusée : on ne le bloque jamais. */
  keepOffered: boolean;
}

const state = {
  token: '',
  dossier: null as Dossier | null,
  screen: 's0' as ScreenId,
  answers: {} as Answers,
  photoUi: {
    1: emptyPhotoUi(),
    2: emptyPhotoUi(),
    3: emptyPhotoUi(),
  } as Record<PhotoSlot, PhotoUi>,
  diagnostic: null as Diagnostic | null,
  submitting: false,
  /** Photo refusée par le pré-filtre local, conservée si le client insiste. */
  pendingBlob: null as Blob | null,
};

function emptyPhotoUi(): PhotoUi {
  return { previewUrl: null, verdict: null, busy: false, keepOffered: false };
}

const app = document.getElementById('app')!;

/* ------------------------------------------------------------------ */
/* Amorçage                                                            */
/* ------------------------------------------------------------------ */

async function boot(): Promise<void> {
  const token = location.pathname.split('/').filter(Boolean).pop() ?? '';
  if (!token || token === 'd') return renderFatal('Lien incomplet.');

  state.token = token;
  try {
    state.dossier = await api.getDossier(token);
  } catch {
    return renderFatal(
      "Ce lien n'est plus valide. Contactez-nous et nous vous en enverrons un nouveau.",
    );
  }

  state.answers = state.dossier.answers ?? {};
  state.diagnostic = state.dossier.diagnostic;

  // Reprise en cours de route : le client a pu fermer l'onglet et rouvrir le
  // SMS plus tard. On le replace là où il s'était arrêté plutôt qu'au début.
  if (state.dossier.status === 'stop_securite') state.screen = 's-stop';
  else if (state.dossier.status === 'soumis') state.screen = 's6';
  else state.screen = resumeScreen(state.dossier);

  for (const slot of [1, 2, 3] as PhotoSlot[]) {
    const p = state.dossier.photos[slot];
    if (p.uploaded && p.analysis) {
      state.photoUi[slot].verdict = verdictFor(p.analysis.usable, p.analysis.guidance);
    }
  }

  render();
}

function resumeScreen(d: Dossier): ScreenId {
  if (!d.answers.safety?.length) return 's0';
  for (const slot of [1, 2, 3] as PhotoSlot[]) {
    const p = d.photos[slot];
    if (!p.uploaded && !p.skipped) return (`s${slot}` as ScreenId);
  }
  if (!d.answers.ou || !d.answers.eauChaude || !d.answers.ecran) return 's4';
  if (!d.answers.statut || !d.answers.acces || !d.answers.dispo) return 's5';
  return 's5';
}

/* ------------------------------------------------------------------ */
/* Rendu                                                               */
/* ------------------------------------------------------------------ */

function render(): void {
  const d = state.dossier;
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
    <main class="body">${screenBody()}</main>
    ${actionsBar()}
  `;

  bind();
  app.querySelector('.body')?.scrollTo({ top: 0 });
}

function slotStrip(): string {
  return ([1, 2, 3] as PhotoSlot[])
    .map((slot) => {
      const p = state.dossier?.photos[slot];
      const ui = state.photoUi[slot];
      const active = state.screen === `s${slot}`;
      const done = p?.uploaded || p?.skipped;
      const cls = ['slot', done ? 'done' : '', active ? 'active' : ''].join(' ');
      const label = ['1 · Plaque', '2 · Ensemble', '3 · Fuite'][slot - 1];
      const inner = ui.previewUrl
        ? `<img src="${ui.previewUrl}" alt="">`
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
      return stopScreen();
    case 's1':
    case 's2':
    case 's3':
      return photoScreen(Number(state.screen[1]) as PhotoSlot);
    case 's4':
      return questionScreen('Le problème', 'Trois questions rapides', PROBLEM_QUESTIONS);
    case 's5':
      return questionScreen('Vous et votre logement', 'Presque terminé', CONTEXT_QUESTIONS);
    case 's6':
      return doneScreen();
  }
}

/* ---------- Accueil ---------- */

function welcomeScreen(): string {
  const d = state.dossier!;
  // Le formulaire du site a déjà collecté téléphone, ville et problème :
  // on les rappelle pour rassurer, on ne les redemande pas.
  const known = [
    d.tel ? `<span>📞 ${escapeHtml(d.tel)}</span>` : '',
    d.ville ? `<span>📍 ${escapeHtml(d.ville)}</span>` : '',
  ].join('');

  return `
    <p class="eyebrow">SOS Diag Express</p>
    <h1>Votre diagnostic, sans attendre une visite.</h1>
    <p class="lead">3 photos, quelques questions, et notre technicien vous rappelle avec un diagnostic clair.</p>
    <div class="known">${known}</div>
    ${d.probleme ? `<p class="hint">Votre demande : « ${escapeHtml(d.probleme)} »</p>` : ''}
    <div class="card">${questionBlock(SAFETY_QUESTION)}</div>
    <div class="trust"><span class="lock">🔒</span>Vos photos ne servent qu'à votre diagnostic et sont supprimées sous 7 jours.</div>
  `;
}

function stopScreen(): string {
  return `
    <div class="stop">
      <p class="eyebrow" style="color:var(--ko)">Sécurité d'abord</p>
      <h2>On vous appelle tout de suite.</h2>
      <p>Votre situation demande un humain, pas un formulaire. En attendant notre appel :</p>
      <ol>
        <li>Coupez le disjoncteur du chauffe-eau (ou le général).</li>
        <li>Fermez le robinet d'arrivée d'eau sous l'appareil, ou l'arrivée générale.</li>
        <li>Ne touchez pas aux fils. Éloignez ce qui est électrique de l'eau.</li>
        <li>Odeur de gaz : ouvrez les fenêtres, ne touchez à aucun interrupteur, sortez et appelez le 18.</li>
      </ol>
      <a class="call" href="tel:${escapeHtml(URGENCE_TEL)}">📞 Nous appeler maintenant</a>
    </div>
    <p class="hint" style="margin-top:12px">Un technicien SOS Cumulus a été alerté et vous rappelle au numéro indiqué.</p>
  `;
}

/* ---------- Photos ---------- */

function photoScreen(slot: PhotoSlot): string {
  const cfg = PHOTO_SCREENS[slot];
  const ui = state.photoUi[slot];
  const p = state.dossier!.photos[slot];

  const verdict = ui.verdict
    ? ui.verdict.tone === 'wait'
      ? `<div class="verdict wait"><span class="spinner"></span>${escapeHtml(ui.verdict.text)}</div>`
      : `<div class="verdict ${ui.verdict.tone}">${escapeHtml(ui.verdict.text)}</div>`
    : '';

  return `
    <p class="eyebrow">${cfg.eyebrow}</p>
    <h1>${cfg.title}</h1>
    <p class="lead">${cfg.lead}</p>
    ${ui.previewUrl ? `<div class="shot"><img src="${ui.previewUrl}" alt="Votre photo"></div>` : ''}
    ${verdict}
    ${ui.keepOffered ? `<button class="skip" data-keep="${slot}">Garder cette photo quand même</button>` : ''}
    ${p.skipped ? '' : `<div><button class="skip" data-skip="${slot}">${cfg.skipLabel}</button></div>`}
    <input class="sr" type="file" accept="image/*" capture="environment" id="file-${slot}">
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
  const d = state.dossier!;
  const diag = state.diagnostic;
  const count = ([1, 2, 3] as PhotoSlot[]).filter((s) => d.photos[s].uploaded).length;
  const nameplate = d.photos[1].analysis?.nameplate;
  const appareil =
    nameplate?.readable && (nameplate.brand || nameplate.model)
      ? [nameplate.brand, nameplate.model, nameplate.capacityLiters ? `${nameplate.capacityLiters} L` : null]
          .filter(Boolean)
          .join(' · ')
      : 'À confirmer par le technicien';

  return `
    <div class="done-hero"><div class="check">✓</div>
      <h1>Votre dossier est parti.</h1>
      <p class="lead">${diag ? escapeHtml(diag.summary) : 'Notre technicien examine vos éléments.'}</p>
    </div>
    <div class="card recap">
      <h2>Votre dossier ${d.ref}</h2>
      <div class="row"><span class="k">Photos</span><span class="v">${count} / 3</span></div>
      <div class="row"><span class="k">Appareil</span><span class="v">${escapeHtml(appareil)}</span></div>
      <div class="row"><span class="k">Rappel</span><span class="v">${escapeHtml(dispoLabel(d.answers.dispo))}</span></div>
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

const DISPO_LABELS: Record<string, string> = {
  matin: 'Le matin',
  midi: 'Vers midi',
  aprem: "L'après-midi",
  soir: 'En fin de journée',
};
const dispoLabel = (d?: string) => (d ? (DISPO_LABELS[d] ?? '—') : 'Dès que possible');

/* ------------------------------------------------------------------ */
/* Barre d'action                                                      */
/* ------------------------------------------------------------------ */

function actionsBar(): string {
  if (state.screen === 's-stop') return '';

  let label = 'Continuer';
  let disabled = false;

  if (isPhotoScreen(state.screen)) {
    const slot = Number(state.screen[1]) as PhotoSlot;
    const p = state.dossier!.photos[slot];
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
  app.querySelectorAll<HTMLButtonElement>('[data-keep]').forEach((btn) => {
    btn.addEventListener('click', () => onKeep(Number(btn.dataset.keep) as PhotoSlot));
  });

  if (isPhotoScreen(state.screen)) {
    const slot = Number(state.screen[1]) as PhotoSlot;
    app
      .querySelector<HTMLInputElement>(`#file-${slot}`)
      ?.addEventListener('change', (e) => onFile(e, slot));
  }
}

function onChoice(key: string, rawValue: string): void {
  const q = [SAFETY, ...PROBLEM_QUESTIONS, ...CONTEXT_QUESTIONS].find(
    (x) => x.key === key,
  )!;

  if (q.multi) {
    const current = new Set((state.answers.safety ?? []) as SafetyFlag[]);
    const value = rawValue as SafetyFlag;
    // « Aucun de ces cas » est exclusif : le cocher efface les dangers, et
    // cocher un danger l'efface.
    if (value === 'aucun') {
      current.clear();
      current.add('aucun');
    } else {
      current.delete('aucun');
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
    if (res.status === 'stop_securite') {
      state.screen = 's-stop';
      render();
    }
  } catch {
    // Silencieux : les réponses sont conservées localement et repartiront à
    // la soumission. Afficher une erreur réseau à ce stade ne ferait
    // qu'inquiéter sans rien permettre de corriger.
  }
}

function onPrimary(): void {
  if (state.screen === 's0') {
    const flags = state.answers.safety ?? [];
    const danger = flags.some((f) => BLOCKING_SAFETY_FLAGS.includes(f));
    state.screen = danger ? 's-stop' : 's1';
    return render();
  }

  if (isPhotoScreen(state.screen)) {
    const slot = Number(state.screen[1]) as PhotoSlot;
    const p = state.dossier!.photos[slot];
    if (p.uploaded || p.skipped) {
      state.screen = slot === 3 ? 's4' : (`s${slot + 1}` as ScreenId);
      return render();
    }
    return app.querySelector<HTMLInputElement>(`#file-${slot}`)?.click();
  }

  if (state.screen === 's4') {
    state.screen = 's5';
    return render();
  }

  if (state.screen === 's5') return void onSubmit();
}

function onBack(): void {
  const back: Partial<Record<ScreenId, ScreenId>> = {
    s1: 's0', s2: 's1', s3: 's2', s4: 's3', s5: 's4',
  };
  const target = back[state.screen];
  if (target) {
    state.screen = target;
    render();
  }
}

/* ---------- Capture ---------- */

async function onFile(event: Event, slot: PhotoSlot): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;

  const ui = state.photoUi[slot];
  ui.busy = true;
  ui.keepOffered = false;
  ui.verdict = { tone: 'wait', text: 'Préparation de la photo…' };
  render();

  let normalized;
  try {
    normalized = await normalizePhoto(file);
  } catch {
    // Format exotique ou décodage impossible : on n'a pas de photo utilisable,
    // mais on ne renvoie pas le client dans le mur — il peut passer l'étape.
    ui.busy = false;
    ui.verdict = { tone: 'ko', text: "Cette photo n'a pas pu être lue. Réessayez, ou passez cette étape." };
    return render();
  }

  if (ui.previewUrl) URL.revokeObjectURL(ui.previewUrl);
  ui.previewUrl = normalized.previewUrl;

  const attempts = state.dossier!.photos[slot].attempts;
  const local = localGuidance(normalized.quality.verdict);

  // Pré-filtre local : on évite un upload et un appel API pour une photo
  // manifestement inexploitable. Une seule fois — à la deuxième tentative on
  // envoie quoi qu'il arrive, le vLLM tranchera avec un conseil plus utile.
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
    await api.uploadPhoto(state.token, slot, blob);
  } catch {
    ui.busy = false;
    ui.verdict = { tone: 'ko', text: "L'envoi a échoué. Vérifiez votre réseau et réessayez." };
    return render();
  }

  ui.verdict = { tone: 'wait', text: 'Vérification de la photo…' };
  render();

  const dossier = await api.waitForAnalysis(state.token, slot);
  ui.busy = false;

  if (!dossier) {
    // Analyse trop lente : on accepte. La photo est stockée, le technicien la
    // verra. Bloquer le client sur un délai serveur serait absurde.
    state.dossier!.photos[slot].uploaded = true;
    ui.verdict = { tone: 'ok', text: '✓ Photo reçue.' };
    return render();
  }

  state.dossier = dossier;
  const analysis = dossier.photos[slot].analysis;
  const attempts = dossier.photos[slot].attempts;

  if (!analysis) {
    ui.verdict = { tone: 'ok', text: '✓ Photo reçue.' };
    return render();
  }

  if (!analysis.usable && attempts < 2) {
    ui.verdict = { tone: 'ko', text: analysis.guidance ?? 'Reprenez la photo, s’il vous plaît.' };
    ui.keepOffered = true;
    // `uploaded` reste vrai côté serveur : le bouton propose la reprise, mais
    // le client peut aussi conserver la photo et poursuivre.
    return render();
  }

  ui.verdict = verdictFor(analysis.usable, analysis.guidance);
  render();
}

function verdictFor(usable: boolean, guidance: string | null): PhotoUi['verdict'] {
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
  state.dossier!.photos[slot].uploaded = true;
  render();
}

async function onSkip(slot: PhotoSlot): Promise<void> {
  try {
    await api.skipPhoto(state.token, slot);
  } catch {
    /* le passage reste possible hors ligne */
  }
  state.dossier!.photos[slot].skipped = true;
  state.photoUi[slot].verdict = { tone: 'ok', text: PHOTO_SCREENS[slot].skipConfirm };
  state.photoUi[slot].keepOffered = false;
  render();
}

/* ---------- Soumission ---------- */

async function onSubmit(): Promise<void> {
  state.submitting = true;
  render();
  try {
    const res = await api.submit(state.token);
    state.diagnostic = res.diagnostic;
    state.dossier = await api.getDossier(state.token);
    state.screen = 's6';
  } catch {
    state.screen = 's6';
  } finally {
    state.submitting = false;
    render();
  }
}

/* ------------------------------------------------------------------ */
/* Divers                                                              */
/* ------------------------------------------------------------------ */

const URGENCE_TEL = '+33000000000';

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function renderFatal(message: string): void {
  app.innerHTML = `
    <header class="top"><div class="brand"><div class="name">SOS Cumulus <span>+</span></div></div></header>
    <main class="body">
      <h1>Lien indisponible</h1>
      <p class="lead">${escapeHtml(message)}</p>
      <a class="call" href="tel:${escapeHtml(URGENCE_TEL)}">📞 Nous appeler</a>
    </main>`;
}

void boot();
