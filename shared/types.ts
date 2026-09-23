/**
 * Contract shared by the front end (web/) and the API (api/).
 * Any change here is an API change: version it if breaking.
 */

export type PhotoSlot = 1 | 2 | 3;

export const PHOTO_SLOTS: Record<PhotoSlot, { key: string; label: string }> = {
  1: { key: 'nameplate', label: 'Étiquette signalétique' },
  2: { key: 'overview', label: "Vue d'ensemble" },
  3: { key: 'leak', label: 'Zone de fuite' },
};

/**
 * Slots whose photo is sent to the model.
 *
 * The nameplate carries what a human cannot reconstruct later — a reference, a
 * barcode, a capacity. The overview carries what the nameplate never prints:
 * the appliance is a cylinder on a wall, and its posture, its proportion and
 * the side its water arrives from are exactly the columns the replacement guide
 * sorts by. A label says "150 litres"; it does not say whether the tank is a
 * Ø 513 standard or a Ø 570 compact, and those two take different brackets.
 *
 * The leak shot stays unread: a technician reads a wet patch better from the
 * photo than we can describe it back to him, and nothing in it picks a part.
 */
export const ANALYZED_PHOTO_SLOTS: readonly PhotoSlot[] = [1, 2];

export const isAnalyzedSlot = (slot: PhotoSlot): boolean =>
  ANALYZED_PHOTO_SLOTS.includes(slot);

/* ------------------------------------------------------------------ */
/* Safety — assessed before anything else                              */
/* ------------------------------------------------------------------ */

/**
 * No gas hazard here: SOS Cumulus only services electric water heaters, so the
 * question is never asked. The `gas` value on `Nameplate.type` is a different
 * matter and stays — a client may well own a gas unit and call anyway, and the
 * technician is better off knowing before driving out.
 */
export type SafetyFlag =
  | 'breaker_tripped'
  | 'water_near_electrics'
  /**
   * Phone triage only. On the web the client is asked *where* water is showing,
   * and a leak is an ordinary question — most of them wait. On the phone the
   * agent asks one yes/no question and cannot see anything, so any declared
   * leak hands over to a human. Recorded as what it is rather than folded into
   * `water_near_electrics`: a technician reads these flags, and "water near
   * sockets" is not something to write when nobody said it.
   */
  | 'water_leak'
  | 'none';

/** Any one of these flags stops the journey and triggers a call back. */
export const BLOCKING_SAFETY_FLAGS: readonly SafetyFlag[] = [
  'breaker_tripped',
  'water_near_electrics',
  'water_leak',
];

/* ------------------------------------------------------------------ */
/* Case                                                                */
/* ------------------------------------------------------------------ */

export type CaseStatus =
  | 'open' // text sent, client has not opened the link yet
  | 'in_progress' // at least one answer recorded
  | 'safety_stop' // hazard declared, journey stopped, call back now
  | 'submitted' // complete, diagnosis produced
  | 'expired';

export interface Answers {
  safety: SafetyFlag[];
  /**
   * Who the technician asks for at the door, and where the door is.
   *
   * The website form gives a phone number and a commune — enough to call back,
   * not enough to drive out. These are collected on the last screen, where the
   * client has already seen what the three minutes bought them.
   *
   * The address is one line, as the address service returns it: that is what
   * goes into a van's satnav. Structuring it into number, street and postcode
   * would buy nothing today and would have to be kept in step with a service
   * that already does the parsing.
   */
  firstName?: string;
  lastName?: string;
  address?: string;
  /** Where water is visible. */
  waterLocation?: 'top' | 'bottom' | 'safety_group' | 'nowhere';
  /** Is there any hot water left? */
  hotWater?: 'yes' | 'no' | 'lukewarm';
  /** Does the unit have an electronic control panel? */
  hasPanel?: 'yes' | 'no';
  occupancy?: 'owner' | 'tenant' | 'manager';
  access?: 'easy' | 'cupboard' | 'hatch' | 'basement';
  /**
   * Several slots, not one: almost nobody is reachable at a single hour of the
   * day, and forcing a choice buys a wrong answer rather than a precise one.
   * Stored in the order the question offers them, never in click order.
   */
  availability?: Availability[];
}

export type Availability = 'morning' | 'midday' | 'afternoon' | 'evening';

/**
 * Verdict of the check the browser runs on the photo before sending it —
 * sharpness, exposure, glare. Recorded with the upload.
 *
 * It used to live only in the page. Now that two slots out of three never
 * reach the model, it is the only quality signal they carry: the client sees
 * it again after a reload, and the team can tell whether a photo that turned
 * out unusable had been flagged and sent anyway.
 */
export type LocalVerdict = 'ok' | 'blurry' | 'dark' | 'overexposed';

export const LOCAL_VERDICTS: readonly LocalVerdict[] = [
  'ok',
  'blurry',
  'dark',
  'overexposed',
];

export interface PhotoState {
  slot: PhotoSlot;
  uploaded: boolean;
  skipped: boolean;
  attempts: number;
  analysis: PhotoAnalysis | null;
  /** Stays `pending` until the model returns its verdict. */
  analysisStatus: 'idle' | 'pending' | 'done' | 'failed';
  /** `null` on a photo uploaded before this was recorded, or skipped. */
  localVerdict: LocalVerdict | null;
}

export interface DiagnosisCase {
  /** Human-readable reference shown to the client (SC-0024). Never routed. */
  ref: string;
  status: CaseStatus;
  /** Prefilled from the website form — never ask for these again. */
  phone: string;
  city: string | null;
  reportedIssue: string | null;
  answers: Answers;
  photos: Record<PhotoSlot, PhotoState>;
  /** Only filled in when the client declared a screen or indicator lights. */
  panel: ControlPanelState;
  diagnosis: Diagnosis | null;
  /**
   * On-call number shown on the safety-stop screen. Served by the API rather
   * than compiled into the front end: changing it must not require a rebuild,
   * and above all must not leave two values to drift apart.
   */
  emergencyPhone: string;
  createdAt: string;
  expiresAt: string;
}

/* ------------------------------------------------------------------ */
/* Photo analysis (structured model output)                            */
/* ------------------------------------------------------------------ */

export type PhotoProblem =
  | 'blurry'
  | 'dark'
  | 'too_far'
  | 'glare'
  | 'framing'
  | 'off_subject';

export interface Nameplate {
  readable: boolean;
  brand: string | null;
  model: string | null;
  capacityLiters: number | null;
  powerWatts: number | null;
  /**
   * Supply voltage as printed ("230V~", "400V 3~"). A string, not a number:
   * a three-phase unit prints both values, and which one it is decides whether
   * the technician can even connect the replacement on the existing line.
   */
  voltage: string | null;
  /** Maximum service pressure in bar. Labels print MPa; 1 MPa = 10 bar. */
  pressureBar: number | null;
  /** Time to heat a full tank, as printed ("4 h 20 min"). */
  heatUpTime: string | null;
  /**
   * Tank protection marking as printed ("FE+EMAIL", "INOX"). Enamelled steel
   * needs its anode checked; stainless does not. That decides what goes in the
   * van.
   */
  tankLining: string | null;
  /** IP marking, with the category when the label carries one ("IP25 D CAT.B"). */
  protectionIndex: string | null;
  /**
   * Manufacturing batch code as printed ("FAB 439"). Distinct from
   * `manufactureDate`: it is the only dating on many labels, and its encoding
   * varies by maker — transcribe it, never decode it.
   */
  manufactureCode: string | null;
  serial: string | null;
  /**
   * Digits printed under or beside the barcode, usually vertically along the
   * label edge. Kept apart from `serial`: some labels carry both, and this one
   * identifies the exact unit for warranty and parts ordering.
   */
  barcode: string | null;
  manufactureDate: string | null;
  type:
    | 'electric_immersion'
    | 'electric_steatite'
    | 'heat_pump'
    | 'gas'
    | 'unknown';
}

export interface Installation {
  mounting:
    | 'wall_vertical'
    | 'wall_horizontal'
    | 'floor_standing'
    | 'under_sink'
    | 'unknown';
  accessClearance: 'sufficient' | 'tight' | 'insufficient' | 'unknown';
  safetyGroupVisible: boolean | null;
  corrosionVisible: boolean | null;

  /*
   * Everything below exists to pick a replacement, and every field of it is
   * absent from the nameplate. A label gives brand, reference and volume; the
   * guide sorts by posture, diameter and where the water connects.
   */

  /**
   * Brand read off the casing — a logo, a moulded word, a front sticker.
   *
   * Worth asking for on its own: on the one real case we have, the label gave
   * no brand at all and the shell carried it.
   */
  brand: string | null;
  /**
   * Squat or slim, judged on the proportion of the cylinder, since a photo
   * gives no absolute measurement. `compact` is the short wide shell (Ø 555-570),
   * `standard` the tall narrow one (Ø 505-530), `flat` the rectangular casing of
   * a built-in. The two round families take different brackets at equal volume,
   * which is the whole reason this field exists.
   */
  shellProfile: 'standard' | 'compact' | 'flat' | 'unknown';
  /** Where the pipes leave the tank — the guide splits its horizontal rows on it. */
  waterConnection: 'below' | 'side' | 'front' | 'unknown';
  /** Whether the wall brackets are visible enough for a technician to measure. */
  bracketsVisible: boolean | null;
}

export interface Leak {
  present: boolean | null;
  origin: 'safety_group' | 'fitting' | 'tank' | 'hatch_gasket' | 'undetermined';
  severity: 'seeping' | 'dripping' | 'running' | 'none';
}

export interface PhotoAnalysis {
  slot: PhotoSlot;
  /** Usable by a technician, even if imperfect. */
  usable: boolean;
  quality: 'good' | 'fair' | 'poor';
  problems: PhotoProblem[];
  /**
   * Actionable instruction in French, addressed to the client. `null` when the
   * photo is fine. This is what the model adds over the local sharpness check.
   */
  guidance: string | null;
  nameplate: Nameplate | null;
  installation: Installation | null;
  leak: Leak | null;
}

/* ------------------------------------------------------------------ */
/* Control panel (electronic units)                                    */
/* ------------------------------------------------------------------ */

/**
 * Analysis of a sequence of frames extracted from the control-panel video.
 *
 * Kept separate from `PhotoAnalysis` because the question differs: this is not
 * about judging one image but about reading a *sequence* — a blinking fault
 * code cannot be deduced from a single frame.
 */
export interface ControlPanelAnalysis {
  usable: boolean;
  guidance: string | null;
  displayType: 'seven_segment' | 'indicator_lights' | 'lcd' | 'none' | 'unknown';
  /** Fault code read verbatim, e.g. "E3". null when nothing is legible. */
  code: string | null;
  /** What changes from one frame to the next. */
  blinkPattern: string | null;
  /** Indicators observed, e.g. "steady red light on the left". */
  indicators: string[];
  /** Technical reading of the signal, when possible without the manual. */
  interpretation: string | null;
  frameCount: number;
}

export interface ControlPanelState {
  captured: boolean;
  frameCount: number;
  /**
   * Source video, kept for human review. Its upload is deferred and never
   * blocked the journey, so `false` means "not arrived yet", not "the client
   * filmed nothing".
   */
  videoUploaded: boolean;
  analysis: ControlPanelAnalysis | null;
  analysisStatus: 'idle' | 'pending' | 'done' | 'failed';
}

/* ------------------------------------------------------------------ */
/* Final diagnosis                                                     */
/* ------------------------------------------------------------------ */

export interface Diagnosis {
  summary: string;
  likelyCause: string;
  recommendedAction: string;
  /**
   * What the job is, not what it costs. The quote is priced from this and the
   * capacity read off the nameplate — never by the model, which has no price
   * list and must not guess one.
   */
  interventionKind: 'repair' | 'replacement' | 'undetermined';
  urgency: 'immediate' | 'within_24h' | 'within_72h' | 'schedulable';
  partsLikely: string[];
  estimatedDurationMin: number | null;
  confidence: 'high' | 'medium' | 'low';
  /** `true` when a site visit remains necessary despite the photos. */
  needsOnSite: boolean;
  /** Internal notes — never shown to the client. */
  technicianNotes: string;
}

/* ------------------------------------------------------------------ */
/* HTTP payloads                                                       */
/* ------------------------------------------------------------------ */

/** POST /api/lead — called by Google Apps Script. */
export interface LeadRequest {
  phone: string;
  city?: string;
  reportedIssue?: string;
  source?: string;
}

export interface LeadResponse {
  ref: string;
  url: string;
  smsSent: boolean;
}

/** POST /api/case/:token/photo?slot=N — body is a raw JPEG. */
export interface PhotoUploadResponse {
  slot: PhotoSlot;
  accepted: true;
  /** Analysis is asynchronous: poll the case to get the verdict. */
  analysisStatus: 'pending';
}

export interface ApiError {
  error: string;
  message: string;
}
