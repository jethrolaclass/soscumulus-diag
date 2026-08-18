/**
 * Contrat partagé entre le front (web/) et l'API (api/).
 * Toute évolution ici est une évolution d'API : versionner si breaking.
 */

export type PhotoSlot = 1 | 2 | 3;

export const PHOTO_SLOTS: Record<PhotoSlot, { key: string; label: string }> = {
  1: { key: 'plaque', label: "Étiquette signalétique" },
  2: { key: 'ensemble', label: "Vue d'ensemble" },
  3: { key: 'fuite', label: "Zone de fuite" },
};

/* ------------------------------------------------------------------ */
/* Sécurité — évalué avant toute autre chose                           */
/* ------------------------------------------------------------------ */

export type SafetyFlag = 'disjoncteur' | 'eau_electricite' | 'gaz' | 'aucun';

/** Un seul de ces drapeaux suffit à basculer le dossier en arrêt sécurité. */
export const BLOCKING_SAFETY_FLAGS: readonly SafetyFlag[] = [
  'disjoncteur',
  'eau_electricite',
  'gaz',
];

/* ------------------------------------------------------------------ */
/* Dossier                                                             */
/* ------------------------------------------------------------------ */

export type DossierStatus =
  | 'ouvert' // SMS envoyé, client n'a pas encore ouvert
  | 'en_cours' // au moins une réponse enregistrée
  | 'stop_securite' // danger déclaré, parcours interrompu, rappel immédiat
  | 'soumis' // dossier complet, diagnostic généré
  | 'expire';

export interface Answers {
  safety: SafetyFlag[];
  /** Où l'eau est visible. */
  ou?: 'dessus' | 'dessous' | 'groupe' | 'nulle';
  /** Reste-t-il de l'eau chaude ? */
  eauChaude?: 'oui' | 'non' | 'tiede';
  /** Bandeau électronique présent ? */
  ecran?: 'oui' | 'non';
  statut?: 'proprio' | 'locataire' | 'gestionnaire';
  acces?: 'facile' | 'placard' | 'trappe' | 'cave';
  dispo?: 'matin' | 'midi' | 'aprem' | 'soir';
}

export interface PhotoState {
  slot: PhotoSlot;
  uploaded: boolean;
  skipped: boolean;
  attempts: number;
  analysis: PhotoAnalysis | null;
  /** `pending` tant que Claude n'a pas rendu son verdict. */
  analysisStatus: 'idle' | 'pending' | 'done' | 'failed';
}

export interface Dossier {
  /** Référence lisible affichée au client (SC-0024). Jamais dans l'URL. */
  ref: string;
  status: DossierStatus;
  /** Pré-remplis depuis le formulaire du site — ne pas redemander. */
  tel: string;
  ville: string | null;
  probleme: string | null;
  answers: Answers;
  photos: Record<PhotoSlot, PhotoState>;
  /** Renseigné seulement si le client a déclaré un écran ou des voyants. */
  bandeau: BandeauState;
  diagnostic: Diagnostic | null;
  createdAt: string;
  expiresAt: string;
}

/* ------------------------------------------------------------------ */
/* Analyse d'une photo (sortie structurée Claude)                      */
/* ------------------------------------------------------------------ */

export type PhotoProblem =
  | 'flou'
  | 'sombre'
  | 'trop_loin'
  | 'reflet'
  | 'cadrage'
  | 'hors_sujet';

export interface Nameplate {
  readable: boolean;
  brand: string | null;
  model: string | null;
  capacityLiters: number | null;
  powerWatts: number | null;
  serial: string | null;
  manufactureDate: string | null;
  type:
    | 'electrique_blinde'
    | 'electrique_steatite'
    | 'thermodynamique'
    | 'gaz'
    | 'inconnu';
}

export interface Installation {
  mounting:
    | 'mural_vertical'
    | 'mural_horizontal'
    | 'sur_socle'
    | 'sous_evier'
    | 'inconnu';
  accessClearance: 'suffisant' | 'limite' | 'insuffisant' | 'inconnu';
  groupeSecuriteVisible: boolean | null;
  corrosionVisible: boolean | null;
}

export interface Leak {
  present: boolean | null;
  origin:
    | 'groupe_securite'
    | 'raccord'
    | 'cuve'
    | 'joint_trappe'
    | 'indetermine';
  severity: 'suintement' | 'goutte_a_goutte' | 'ecoulement' | 'aucune';
}

export interface PhotoAnalysis {
  slot: PhotoSlot;
  /** Exploitable par un technicien, même imparfaite. */
  usable: boolean;
  quality: 'bonne' | 'moyenne' | 'insuffisante';
  problems: PhotoProblem[];
  /**
   * Consigne actionnable en français, adressée au client, à la deuxième
   * personne. `null` si la photo convient. C'est la valeur ajoutée du vLLM
   * par rapport au contrôle de netteté local.
   */
  guidance: string | null;
  nameplate: Nameplate | null;
  installation: Installation | null;
  leak: Leak | null;
}

/* ------------------------------------------------------------------ */
/* Bandeau de commande (appareils électroniques)                       */
/* ------------------------------------------------------------------ */

/**
 * Analyse d'une séquence d'images extraites de la vidéo du bandeau.
 *
 * Distincte de `PhotoAnalysis` parce que la question posée est différente :
 * il ne s'agit pas de juger une image mais de lire une *séquence* — un code
 * de défaut clignotant ne se déduit pas d'une image isolée.
 */
export interface BandeauAnalysis {
  usable: boolean;
  guidance: string | null;
  displayType:
    | 'afficheur_numerique'
    | 'voyants'
    | 'ecran_lcd'
    | 'aucun'
    | 'indetermine';
  /** Code de défaut lu tel quel, ex. « E3 ». null si rien de lisible. */
  code: string | null;
  /** Description de la séquence observée d'une image à l'autre. */
  blinkPattern: string | null;
  /** Voyants observés, ex. « voyant rouge fixe à gauche ». */
  indicators: string[];
  /** Lecture technique du signal, si elle est possible sans le manuel. */
  interpretation: string | null;
  frameCount: number;
}

export interface BandeauState {
  captured: boolean;
  frameCount: number;
  /**
   * La vidéo source, conservée pour vérification humaine. Son envoi est
   * différé et n'a jamais bloqué le parcours : `false` signifie donc
   * « pas encore arrivée », pas « le client n'a rien filmé ».
   */
  videoUploaded: boolean;
  analysis: BandeauAnalysis | null;
  analysisStatus: 'idle' | 'pending' | 'done' | 'failed';
}

/* ------------------------------------------------------------------ */
/* Diagnostic de synthèse                                              */
/* ------------------------------------------------------------------ */

export interface Diagnostic {
  summary: string;
  likelyCause: string;
  recommendedAction: string;
  urgency: 'immediate' | 'sous_24h' | 'sous_72h' | 'planifiable';
  partsLikely: string[];
  estimatedDurationMin: number | null;
  confidence: 'haute' | 'moyenne' | 'faible';
  /** `true` si une visite reste indispensable malgré les photos. */
  needsOnSite: boolean;
  /** Notes techniques internes — n'apparaissent pas côté client. */
  technicianNotes: string;
}

/* ------------------------------------------------------------------ */
/* Payloads HTTP                                                       */
/* ------------------------------------------------------------------ */

/** POST /api/lead — appelé par Google Apps Script. */
export interface LeadRequest {
  tel: string;
  ville?: string;
  probleme?: string;
  source?: string;
}

export interface LeadResponse {
  ref: string;
  url: string;
  smsSent: boolean;
}

/** POST /api/dossier/:token/photo?slot=N — corps = JPEG brut. */
export interface PhotoUploadResponse {
  slot: PhotoSlot;
  accepted: true;
  /** L'analyse est asynchrone : interroger /status. */
  analysisStatus: 'pending';
}

export interface ApiError {
  error: string;
  message: string;
}
