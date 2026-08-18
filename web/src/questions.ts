import type { PhotoSlot } from '../../shared/types';
import type { Answers } from '../../shared/types';

/**
 * Définition déclarative du questionnaire. Les écrans sont générés depuis ces
 * données : ajouter une question ne demande ni HTML ni gestionnaire d'événement.
 */

export interface Choice {
  /** Valeur stockée dans `Answers`. Typée `string` : le rendu passe par le DOM,
   *  qui ne transporte que des chaînes, et la validation se fait à l'écriture. */
  value: string;
  label: string;
  icon: string;
  /** Teinte de l'état sélectionné — souligne un danger ou une absence de danger. */
  tone?: 'danger' | 'safe';
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
    { value: 'disjoncteur', label: 'Le disjoncteur a sauté', icon: '⚡', tone: 'danger' },
    {
      value: 'eau_electricite',
      label: "De l'eau coule près de prises ou d'appareils électriques",
      icon: '💧',
      tone: 'danger',
    },
    { value: 'gaz', label: 'Une odeur de gaz', icon: '🔥', tone: 'danger' },
    { value: 'aucun', label: 'Aucun de ces cas', icon: '✓', tone: 'safe' },
  ],
};

export const PROBLEM_QUESTIONS: Question[] = [
  {
    key: 'ou',
    title: "Où voyez-vous de l'eau ?",
    choices: [
      { value: 'dessus', label: "Sur le dessus de l'appareil", icon: '⬆️' },
      { value: 'dessous', label: 'En dessous', icon: '⬇️' },
      {
        value: 'groupe',
        label: 'Sur le petit robinet du tuyau (groupe de sécurité)',
        icon: '🔧',
      },
      { value: 'nulle', label: 'Nulle part', icon: '—' },
    ],
  },
  {
    key: 'eauChaude',
    title: 'Avez-vous encore de l’eau chaude ?',
    choices: [
      { value: 'oui', label: 'Oui', icon: '🔥' },
      { value: 'non', label: 'Non', icon: '❄️' },
      { value: 'tiede', label: 'Un peu, tiède', icon: '🌡️' },
    ],
  },
  {
    key: 'ecran',
    title: 'Votre appareil a-t-il un écran ou des petites lumières ?',
    choices: [
      { value: 'oui', label: 'Oui', icon: '💡' },
      { value: 'non', label: 'Non', icon: '○' },
    ],
  },
];

export const CONTEXT_QUESTIONS: Question[] = [
  {
    key: 'statut',
    title: 'Vous êtes…',
    choices: [
      { value: 'proprio', label: 'Propriétaire', icon: '🏠' },
      { value: 'locataire', label: 'Locataire', icon: '🔑' },
      { value: 'gestionnaire', label: 'Je gère ce logement', icon: '🗂️' },
    ],
  },
  {
    key: 'acces',
    title: 'Le chauffe-eau est…',
    choices: [
      { value: 'facile', label: "Facile d'accès", icon: '🚪' },
      { value: 'placard', label: 'Dans un placard ou un coffrage', icon: '🚪' },
      { value: 'trappe', label: 'Faux plafond ou trappe', icon: '🪜' },
      { value: 'cave', label: 'Cave ou sous-sol', icon: '🕳️' },
    ],
  },
  {
    key: 'dispo',
    title: 'Vous êtes joignable plutôt…',
    choices: [
      { value: 'matin', label: 'Le matin', icon: '🌅' },
      { value: 'midi', label: 'Vers midi', icon: '☀️' },
      { value: 'aprem', label: "L'après-midi", icon: '🌤️' },
      { value: 'soir', label: 'Le soir', icon: '🌙' },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Écrans photo                                                        */
/* ------------------------------------------------------------------ */

export interface PhotoScreen {
  slot: PhotoSlot;
  eyebrow: string;
  title: string;
  lead: string;
  /** Proposé sous le bouton — jamais une impasse pour le client. */
  skipLabel: string;
  skipConfirm: string;
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
  },
  2: {
    slot: 2,
    eyebrow: 'Photo 2 sur 3',
    title: 'Le chauffe-eau en entier',
    lead: "Reculez de deux ou trois pas pour qu'on voie <b>l'appareil entier</b> et ce qu'il y a autour.",
    skipLabel: 'Je ne peux pas reculer davantage',
    skipConfirm: 'Noté — le technicien tiendra compte de la place disponible.',
  },
  3: {
    slot: 3,
    eyebrow: 'Photo 3 sur 3',
    title: 'Là où ça coule',
    lead: "Cadrez l'endroit où vous voyez de l'eau : au sol, sur un tuyau ou sur l'appareil.",
    skipLabel: 'Rien ne coule pour le moment',
    skipConfirm: "Noté : rien ne coule pour l'instant.",
  },
};

export const SCREEN_ORDER = [
  's0',
  's1',
  's2',
  's3',
  's4',
  's5',
  's6',
] as const;

export type ScreenId = (typeof SCREEN_ORDER)[number] | 's-stop';

export const SCREEN_META: Record<ScreenId, { label: string; pct: number }> = {
  s0: { label: 'Étape 1 sur 6 · Sécurité', pct: 8 },
  s1: { label: 'Étape 2 sur 6 · Photo 1', pct: 24 },
  s2: { label: 'Étape 3 sur 6 · Photo 2', pct: 40 },
  s3: { label: 'Étape 4 sur 6 · Photo 3', pct: 56 },
  s4: { label: 'Étape 5 sur 6 · Le problème', pct: 72 },
  s5: { label: 'Étape 6 sur 6 · Vous', pct: 88 },
  s6: { label: 'Terminé', pct: 100 },
  's-stop': { label: 'Sécurité', pct: 8 },
};
