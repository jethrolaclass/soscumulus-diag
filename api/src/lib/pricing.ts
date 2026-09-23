/**
 * Quote arithmetic: labour rates, and the appliance picked from the catalogue.
 *
 * Deliberately plain tables and plain arithmetic, never the model. A quote
 * leaves here, is read aloud by the voice agent, is texted to the client, and
 * is accepted by replying "OK" — that is a commitment. A figure that was
 * guessed rather than looked up is a figure the company owes.
 *
 * The rates start empty, which is not an oversight: with nothing to look up,
 * the quote comes back `needsHumanPricing` and the agent promises a call rather
 * than a price. Nothing wrong is ever said out loud.
 */

import type { Diagnosis, Installation, Nameplate } from '../../../shared/types';
import type { Heater } from './heaters';
import { findCandidates } from './heaters';

/* ------------------------------------------------------------------ */
/* Labour                                                              */
/* ------------------------------------------------------------------ */

export interface LabourRates {
  /** Call-out, charged whatever the outcome. */
  callOut: number | null;
  /**
   * Flat rate, the same for a repair and for a replacement — that is how the
   * intervention sheet is already worded, and it removes any incentive to
   * replace what could be repaired.
   */
  labour: number | null;
}

export const RATES: LabourRates = { callOut: null, labour: null };

/* ------------------------------------------------------------------ */
/* Choosing the replacement                                            */
/* ------------------------------------------------------------------ */

export interface Replacement {
  model: Heater;
  /** Everything the photos left open — read aloud as a caveat, never hidden. */
  undecided: string[];
  /** The other references the guide allows, when the shortlist did not close. */
  alternatives: Heater[];
}

/**
 * One replacement, or none.
 *
 * Returns null as soon as the two photos leave more than one candidate. That is
 * the common case today and it is the right one: the guide sorts by bracket
 * spacing, nothing photographs a bracket spacing, and a quote sent for the
 * wrong shell is worse than a call back.
 */
export function findReplacement(
  nameplate: Nameplate | null,
  installation: Installation | null,
): Replacement | null {
  if (!nameplate?.readable) return null;

  const { replacements, undecided } = findCandidates(nameplate, installation);
  if (replacements.length !== 1) return null;

  return { model: replacements[0], undecided, alternatives: [] };
}

/* ------------------------------------------------------------------ */
/* Quote                                                               */
/* ------------------------------------------------------------------ */

export interface QuoteLine {
  label: string;
  amount: number;
}

export interface Quote {
  lines: QuoteLine[];
  total: number | null;
  replacement: Replacement | null;
  /**
   * `true` when anything is missing a price, or when the photos did not settle
   * whether this is a repair or a replacement. The agent must then promise a
   * call, never a figure.
   */
  needsHumanPricing: boolean;
  /** Why, in French, ready to be read aloud. Empty when the quote is firm. */
  reason: string;
}

const UNPRICED = (reason: string): Quote => ({
  lines: [],
  total: null,
  replacement: null,
  needsHumanPricing: true,
  reason,
});

/** "Atlantic Zénéo 150 L vertical mural", as it is read to a client. */
function label(h: Heater): string {
  const posture =
    h.orientation === 'integration'
      ? 'encastrable'
      : `${h.orientation === 'vertical' ? 'vertical' : 'horizontal'} ${h.mounting === 'wall' ? 'mural' : 'sur socle'}`;
  return `${h.brand} ${h.model} ${posture}`;
}

export function buildQuote(
  diagnosis: Diagnosis,
  nameplate: Nameplate | null,
  installation: Installation | null,
): Quote {
  if (diagnosis.interventionKind === 'undetermined') {
    return UNPRICED(
      'Vos photos sont bien arrivées. Pour trancher entre une réparation et un ' +
        'remplacement, il faut l’œil d’un technicien : il vous rappelle et vous ' +
        'donne le bon chiffre, pas un chiffre approximatif.',
    );
  }

  const lines: QuoteLine[] = [];
  if (RATES.callOut === null || RATES.labour === null) {
    return UNPRICED(
      'Votre dossier est complet, on a tout ce qu’il faut. Un technicien vous ' +
        'rappelle avec le montant exact et vous propose un rendez-vous.',
    );
  }
  lines.push({ label: 'Déplacement', amount: RATES.callOut });
  lines.push({ label: 'Main-d’œuvre', amount: RATES.labour });

  let replacement: Replacement | null = null;
  if (diagnosis.interventionKind === 'replacement') {
    replacement = findReplacement(nameplate, installation);
    if (!replacement) {
      return UNPRICED(
        'Vos photos nous ont permis de cerner votre appareil. Pour choisir le ' +
          'bon modèle de remplacement, il reste à mesurer l’écartement de vos ' +
          'fixations : un technicien vous rappelle pour ça et vous donne le ' +
          'montant exact.',
      );
    }
    if (replacement.model.price === null) {
      return UNPRICED(
        'On a identifié le modèle qu’il vous faut. Un technicien vous rappelle ' +
          'avec le montant exact et vous propose un rendez-vous.',
      );
    }
    lines.push({ label: label(replacement.model), amount: replacement.model.price });
  }

  return {
    lines,
    total: lines.reduce((sum, l) => sum + l.amount, 0),
    replacement,
    needsHumanPricing: false,
    // Whatever the photos left open is said out loud, not buried in the total.
    reason:
      replacement && replacement.undecided.length > 0
        ? 'Sous réserve que le modèle retenu se pose sur votre fixation actuelle.'
        : '',
  };
}
