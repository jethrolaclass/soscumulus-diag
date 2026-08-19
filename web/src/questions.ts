import type { Answers, PhotoSlot } from '../../shared/types';

/**
 * Declarative definition of the questionnaire. Screens are generated from this
 * data: adding a question needs neither markup nor an event handler.
 *
 * Labels stay in French — they are read by the client. Values are English:
 * they are identifiers, stored in the database and matched in code.
 */

export interface Choice {
  /**
   * Value stored in `Answers`. Typed as `string`: rendering goes through the
   * DOM, which only carries strings, and validation happens on write.
   */
  value: string;
  label: string;
  icon: string;
  /** Selected-state tint — marks a hazard or the absence of one. */
  tone?: 'danger' | 'safe';
  /**
   * On a multiple-choice question, ticking it clears every other answer, and
   * ticking another clears it. "None of these" only means anything alone.
   */
  exclusive?: boolean;
}

export interface Question {
  key: keyof Answers;
  title: string;
  hint?: string;
  multi?: boolean;
  choices: Choice[];
}

export const SAFETY_QUESTION: Question = {
  key: 'safety',
  title: 'Avant tout : êtes-vous en sécurité ?',
  hint: 'Touchez tout ce qui vous concerne.',
  multi: true,
  choices: [
    { value: 'breaker_tripped', label: 'Le disjoncteur a sauté', icon: '⚡', tone: 'danger' },
    {
      value: 'water_near_electrics',
      label: "De l'eau coule près de prises ou d'appareils électriques",
      icon: '💧',
      tone: 'danger',
    },
    { value: 'none', label: 'Aucun de ces cas', icon: '✓', tone: 'safe', exclusive: true },
  ],
};

export const PROBLEM_QUESTIONS: Question[] = [
  {
    key: 'waterLocation',
    title: "Où voyez-vous de l'eau ?",
    choices: [
      { value: 'top', label: "Sur le dessus de l'appareil", icon: '⬆️' },
      { value: 'bottom', label: 'En dessous', icon: '⬇️' },
      {
        value: 'safety_group',
        label: 'Sur le petit robinet du tuyau (groupe de sécurité)',
        icon: '🔧',
      },
      { value: 'nowhere', label: 'Nulle part', icon: '—' },
    ],
  },
  {
    key: 'hotWater',
    title: 'Avez-vous encore de l’eau chaude ?',
    choices: [
      { value: 'yes', label: 'Oui', icon: '🔥' },
      { value: 'no', label: 'Non', icon: '❄️' },
      { value: 'lukewarm', label: 'Un peu, tiède', icon: '🌡️' },
    ],
  },
  {
    key: 'hasPanel',
    title: 'Votre appareil a-t-il un écran ou des petites lumières ?',
    choices: [
      { value: 'yes', label: 'Oui', icon: '💡' },
      { value: 'no', label: 'Non', icon: '○' },
    ],
  },
];

export const CONTEXT_QUESTIONS: Question[] = [
  {
    key: 'occupancy',
    title: 'Vous êtes…',
    choices: [
      { value: 'owner', label: 'Propriétaire', icon: '🏠' },
      { value: 'tenant', label: 'Locataire', icon: '🔑' },
      { value: 'manager', label: 'Je gère ce logement', icon: '🗂️' },
    ],
  },
  {
    key: 'access',
    title: 'Le chauffe-eau est…',
    choices: [
      { value: 'easy', label: "Facile d'accès", icon: '🚪' },
      { value: 'cupboard', label: 'Dans un placard ou un coffrage', icon: '🚪' },
      { value: 'hatch', label: 'Faux plafond ou trappe', icon: '🪜' },
      { value: 'basement', label: 'Cave ou sous-sol', icon: '🕳️' },
    ],
  },
  {
    key: 'availability',
    title: 'Vous êtes joignable plutôt…',
    hint: 'Touchez tous les moments qui vous conviennent.',
    multi: true,
    choices: [
      { value: 'morning', label: 'Le matin', icon: '🌅' },
      { value: 'midday', label: 'Vers midi', icon: '☀️' },
      { value: 'afternoon', label: "L'après-midi", icon: '🌤️' },
      { value: 'evening', label: 'Le soir', icon: '🌙' },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Photo screens                                                       */
/* ------------------------------------------------------------------ */

export interface PhotoScreen {
  slot: PhotoSlot;
  eyebrow: string;
  title: string;
  lead: string;
  /** Offered under the button — never a dead end for the client. */
  skipLabel: string;
  skipConfirm: string;
  /**
   * Reference shot. Showing what a good photo looks like does more than any
   * written instruction — these are real client photos, and saying so is part
   * of why they reassure.
   */
  example: {
    src: string;
    caption: string;
    /** `object-position`, so the useful area survives the crop. */
    focus: string;
  };
  /**
   * Framing guide, and the switch that turns it on: a slot that declares one is
   * shot through the in-page camera, the others through the system camera app.
   * Only a slot with a distance to hold needs one.
   */
  guide?: {
    /** Read over the live image, above the frame. */
    hint: string;
    /**
     * `label` is a window cut to the shape of a nameplate; `full` is the frame
     * itself, inset, for fitting a whole appliance as tightly as possible.
     */
    shape: 'label' | 'full';
  };
}

export const PHOTO_SCREENS: Record<PhotoSlot, PhotoScreen> = {
  1: {
    slot: 1,
    eyebrow: 'Photo 1 sur 3',
    title: "L'étiquette du chauffe-eau",
    lead: "Rapprochez-vous de l'étiquette collée sur l'appareil. On doit pouvoir <b>lire les chiffres</b>.",
    skipLabel: "Je ne trouve pas l'étiquette",
    skipConfirm:
      "Pas de souci — photographiez alors le dessus ou le capot, et notre technicien s'en occupera.",
    example: {
      src: '/examples/nameplate.jpg',
      caption: "Net, bien éclairé, l'étiquette remplit l'image.",
      focus: '50% 55%',
    },
    guide: { hint: "Placez l'étiquette dans le cadre", shape: 'label' },
  },
  2: {
    slot: 2,
    eyebrow: 'Photo 2 sur 3',
    title: 'Le chauffe-eau en entier',
    lead: "Reculez de deux ou trois pas pour qu'on voie <b>l'appareil entier</b> et ce qu'il y a autour.",
    skipLabel: 'Je ne peux pas reculer davantage',
    skipConfirm: 'Noté — le technicien tiendra compte de la place disponible.',
    guide: { hint: "Tout l'appareil, au plus près", shape: 'full' },
    example: {
      src: '/examples/overview.jpg',
      caption:
        "Appareil entier, murs et plafond visibles — on voit où et comment il est posé. (Vraie photo client.)",
      focus: '50% 45%',
    },
  },
  3: {
    slot: 3,
    eyebrow: 'Photo 3 sur 3',
    title: 'Là où ça coule',
    lead: "Cadrez l'endroit où vous voyez de l'eau : au sol, sur un tuyau ou sur l'appareil.",
    skipLabel: 'Rien ne coule pour le moment',
    skipConfirm: "Noté : rien ne coule pour l'instant.",
    example: {
      src: '/examples/leak.jpg',
      caption: "Le dessous, la bride et les raccords. Là où l'eau se voit.",
      focus: '50% 60%',
    },
  },
};

/** Conditional screen: shown only when the client declares a panel. */
export const PANEL_SCREEN = {
  eyebrow: 'Une dernière chose',
  title: 'Filmez le bandeau 10 secondes',
  lead: "Les lumières ou l'écran nous disent ce que dit l'appareil. Filmez-le <b>10 secondes sans bouger</b>.",
  skipLabel: 'Je préfère passer cette étape',
  skipConfirm: 'Noté — le technicien lira le bandeau sur place.',
} as const;

export const SCREEN_ORDER = ['s0', 's1', 's2', 's3', 's4', 's5', 's6'] as const;

/** `s4b` and `s-stop` are conditional: outside the nominal flow. */
export type ScreenId = (typeof SCREEN_ORDER)[number] | 's4b' | 's-stop';

export const SCREEN_META: Record<ScreenId, { label: string; pct: number }> = {
  s0: { label: 'Étape 1 sur 6 · Sécurité', pct: 8 },
  s1: { label: "Étape 2 sur 6 · Photo de l'étiquette", pct: 24 },
  s2: { label: 'Étape 3 sur 6 · Photo du chauffe-eau', pct: 40 },
  s3: { label: 'Étape 4 sur 6 · Photo de la fuite', pct: 56 },
  s4: { label: 'Étape 5 sur 6 · Le problème', pct: 72 },
  s4b: { label: 'Étape 5 sur 6 · Bandeau', pct: 78 },
  s5: { label: 'Étape 6 sur 6 · Vous', pct: 88 },
  s6: { label: 'Terminé', pct: 100 },
  's-stop': { label: 'Sécurité', pct: 8 },
};
