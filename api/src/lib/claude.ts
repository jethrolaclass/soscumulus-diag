/**
 * Appels vision. Point d'entrée unique vers le modèle : si le mécanisme
 * d'authentification ou le fournisseur change un jour, c'est le seul fichier
 * à toucher.
 *
 * Deux contraintes d'architecture pilotent ce module :
 *
 *  1. Aucun octet d'image ne transite par le Worker. On passe une URL R2
 *     présignée à durée courte et l'API va chercher l'image elle-même.
 *     Encoder 300 Ko en base64 dans un Worker dépasserait les 10 ms de CPU
 *     du plan gratuit ; signer une URL en coûte moins de un.
 *
 *  2. Sortie structurée, pas de boucle agentique. La tâche est « regarde
 *     cette photo, rends ce JSON » : `output_config.format` garantit un
 *     résultat parseable par construction, en un aller-retour.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  BandeauAnalysis,
  Diagnostic,
  PhotoAnalysis,
  PhotoSlot,
} from '../../../shared/types';
import type { Env } from '../env';
import {
  PHOTO_ANALYSIS_SCHEMAS,
  DIAGNOSTIC_SCHEMA,
  BANDEAU_SCHEMA,
} from './schemas';

const MODEL = 'claude-opus-5';

/**
 * Les classificateurs d'Opus 5 peuvent décliner une requête (HTTP 200,
 * `stop_reason: "refusal"`). Sur des photos de chaufferie c'est improbable,
 * mais un faux positif ne doit pas casser un diagnostic client : le repli
 * serveur re-sert la requête sur un autre modèle dans le même appel.
 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * `fallbacks` est accepté par l'API mais pas encore décrit par les types du SDK
 * (0.72.x). On l'injecte par un objet volontairement élargi plutôt qu'en
 * castant l'appel entier : le reste des paramètres continue d'être vérifié par
 * le compilateur. À supprimer dès que le SDK expose le champ.
 */
const REFUSAL_FALLBACK = {
  betas: [FALLBACK_BETA],
  fallbacks: 'default',
} as unknown as { betas: string[] };

function client(env: Env): Anthropic {
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    maxRetries: 2,
  });
}

/* ------------------------------------------------------------------ */
/* Prompts                                                             */
/* ------------------------------------------------------------------ */

/**
 * Préambule commun, identique à chaque appel — c'est lui qui porte le point
 * de cache. Le cache ne s'amorce qu'au-delà de 512 tokens de préfixe sur
 * Opus 5 : ne pas raccourcir ce bloc sans vérifier `cache_read_input_tokens`
 * dans les logs, sous peine de payer le plein tarif à chaque photo.
 */
const PREAMBLE = `Tu assistes SOS Cumulus, une entreprise de dépannage de chauffe-eau en région lyonnaise. Un client vient de photographier son appareil avec son téléphone, depuis chez lui, souvent dans un local mal éclairé — cave, placard, sous-sol, faux plafond.

Ton rôle est double et les deux volets comptent autant l'un que l'autre.

Premier volet : contrôler que la photo est exploitable par un technicien qui préparera une intervention sans s'être déplacé. Une photo peut être parfaitement nette et pourtant inutilisable — trop loin pour lire les caractères d'une étiquette, reflet du flash sur un autocollant, cadrage qui coupe la zone utile, sujet qui n'est pas celui demandé. Juge l'utilité réelle pour le technicien, pas la qualité photographique.

Second volet : extraire les informations techniques présentes dans l'image, et uniquement celles-là. N'invente jamais une marque, une référence, une capacité ou une date que tu ne lis pas distinctement. Un champ illisible vaut null — un technicien qui se déplace avec la mauvaise pièce parce qu'une référence a été devinée coûte plus cher qu'un champ vide. Si tu hésites entre deux lectures d'un caractère, le champ est null.

Sur le champ "guidance" : il est lu tel quel par le client, sur son téléphone, debout devant son appareil. Écris une seule phrase, en français, à la deuxième personne du pluriel, qui dit le geste concret à faire — pas le défaut constaté. « Rapprochez-vous à environ 30 cm de l'étiquette » et non « la photo est trop éloignée ». Pas de jargon, pas de vocabulaire technique, pas de ton d'expert. Si la photo convient en l'état, guidance vaut null.

Sur le champ "usable" : il commande le parcours. true signifie qu'un technicien peut travailler avec cette photo, même imparfaite. Ne mets false que si la photo est réellement inexploitable, car cela oblige le client à recommencer. Dans le doute, mets true et signale la réserve dans "problems".`;

const SLOT_PROMPTS: Record<PhotoSlot, string> = {
  1: `Photo demandée : l'étiquette signalétique du chauffe-eau, celle qui porte la marque, la référence et les caractéristiques électriques.

Lis l'étiquette caractère par caractère. La capacité est en litres, la puissance en watts. Le type se déduit des mentions présentes : une résistance stéatite est souvent annoncée explicitement, un modèle blindé mentionne parfois « thermoplongeur », un thermodynamique porte une mention de pompe à chaleur ou un COP, un modèle gaz affiche un débit calorifique en kW.

Si l'étiquette est présente mais qu'aucun caractère n'est lisible, nameplate.readable vaut false et tous les champs valent null.`,

  2: `Photo demandée : le chauffe-eau en entier, dans son environnement.

Évalue le dégagement disponible autour de l'appareil : un technicien doit pouvoir déposer le capot, accéder au groupe de sécurité et, si besoin, sortir la cuve. « insuffisant » signifie qu'une dépose sera impossible sans démonter autre chose — c'est une information qui change le chiffrage et la durée de l'intervention, signale-la sans hésiter.

Le groupe de sécurité est la petite pièce en laiton sur l'arrivée d'eau froide, généralement munie d'une molette et d'un tuyau d'évacuation.`,

  3: `Photo demandée : la zone où le client voit de l'eau.

Cherche l'origine de l'écoulement, pas seulement sa présence. Une eau qui s'écoule au sol peut venir du groupe de sécurité — ce qui est parfois normal en phase de chauffe —, d'un raccord desserré, du joint de la trappe de visite, ou d'un percement de cuve, qui impose un remplacement complet. Trace le trajet de l'eau, en remontant vers le point haut mouillé.

Distingue une trace ancienne, sèche ou calcaire, d'un écoulement actif. Si le client déclare ne rien voir couler et que la photo le confirme, leak.present vaut false.`,
};

/* ------------------------------------------------------------------ */
/* Analyse d'une photo                                                 */
/* ------------------------------------------------------------------ */

export interface PhotoContext {
  ville: string | null;
  probleme: string | null;
  /** Rang de la tentative — au-delà de 1, le client a déjà repris la photo. */
  attempt: number;
}

export async function analyzePhoto(
  env: Env,
  slot: PhotoSlot,
  imageUrl: string,
  context: PhotoContext,
): Promise<PhotoAnalysis> {
  const anthropic = client(env);

  const declared = [
    context.ville ? `Commune : ${context.ville}.` : null,
    context.probleme ? `Problème déclaré par le client : « ${context.probleme} ».` : null,
    context.attempt > 1
      ? `Le client a déjà repris cette photo ${context.attempt - 1} fois. Sois plus indulgent sur la qualité et plus précis sur le geste à faire.`
      : null,
  ]
    .filter(Boolean)
    .join(' ');

  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    ...REFUSAL_FALLBACK,
    // `medium` suffit largement pour de la lecture d'étiquette et du contrôle
    // qualité, et Opus 5 y reste très solide. Relever à `high` seulement si
    // les évaluations sur photos réelles montrent un écart.
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: PHOTO_ANALYSIS_SCHEMAS[slot] },
    },
    system: [
      { type: 'text', text: PREAMBLE, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: SLOT_PROMPTS[slot] },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: imageUrl } },
          { type: 'text', text: declared || 'Analyse cette photo.' },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new VisionError('refusal', 'Analyse déclinée par le modèle.');
  }

  logUsage(env, `photo:${slot}`, response.usage);

  // Chaque schéma ne porte que sa section : on complète les deux autres pour
  // que le type `PhotoAnalysis` soit uniforme quel que soit l'emplacement.
  const parsed = parseJson<Partial<PhotoAnalysis>>(response);
  return {
    nameplate: null,
    installation: null,
    leak: null,
    ...parsed,
    slot,
  } as PhotoAnalysis;
}

/* ------------------------------------------------------------------ */
/* Bandeau de commande                                                 */
/* ------------------------------------------------------------------ */

const BANDEAU_PROMPT = `Tu reçois plusieurs images du bandeau de commande d'un chauffe-eau, extraites d'une même vidéo de dix secondes et espacées régulièrement dans le temps. Elles sont fournies dans l'ordre chronologique.

Ta question n'est pas « que montre cette image » mais « qu'est-ce qui change d'une image à l'autre ». Les chauffe-eau électroniques signalent leurs défauts par une séquence : un voyant allumé sur deux images et éteint sur les trois autres décrit un clignotement, et le rythme fait partie du diagnostic autant que la couleur.

Compare donc les images entre elles avant de conclure. Décris dans "blinkPattern" ce que tu observes de variation, en clair et sans jargon d'expert — par exemple « le voyant rouge de droite est allumé sur les images 1 et 3, éteint sur les autres, ce qui correspond à un clignotement lent ». Si tout est strictement identique d'une image à l'autre, blinkPattern vaut null et tu le signales comme un affichage fixe dans "indicators".

Le champ "code" ne contient que ce qui est écrit à l'écran, transcrit tel quel. N'interprète pas dans ce champ et ne complète pas un caractère douteux : un code de défaut mal lu envoie le technicien sur une fausse piste.

Le champ "interpretation" accueille ta lecture technique, mais uniquement si elle est fondée. Les codes de défaut varient d'un constructeur à l'autre et souvent d'une gamme à l'autre : si la signification exacte demande le manuel du modèle, mets null plutôt qu'une hypothèse. Décrire correctement le signal a plus de valeur que le traduire de travers.`;

export async function analyzeBandeau(
  env: Env,
  frameUrls: string[],
  context: { probleme: string | null },
): Promise<BandeauAnalysis> {
  const anthropic = client(env);

  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    ...REFUSAL_FALLBACK,
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: BANDEAU_SCHEMA },
    },
    system: [
      { type: 'text', text: PREAMBLE, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: BANDEAU_PROMPT },
    ],
    messages: [
      {
        role: 'user',
        content: [
          // Chaque image est précédée de son rang : sans repère explicite, le
          // modèle n'a aucun moyen de restituer l'ordre dans sa description.
          ...frameUrls.flatMap((url, i) => [
            { type: 'text' as const, text: `Image ${i + 1} sur ${frameUrls.length}` },
            { type: 'image' as const, source: { type: 'url' as const, url } },
          ]),
          {
            type: 'text' as const,
            text: context.probleme
              ? `Problème déclaré par le client : « ${context.probleme} ».`
              : 'Décris ce qu\'affiche le bandeau.',
          },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new VisionError('refusal', 'Analyse du bandeau déclinée.');
  }

  logUsage(env, 'bandeau', response.usage);
  const parsed = parseJson<Omit<BandeauAnalysis, 'frameCount'>>(response);
  return { ...parsed, frameCount: frameUrls.length };
}

/* ------------------------------------------------------------------ */
/* Synthèse                                                            */
/* ------------------------------------------------------------------ */

export async function synthesize(
  env: Env,
  payload: {
    answers: unknown;
    analyses: PhotoAnalysis[];
    bandeau: BandeauAnalysis | null;
    ville: string | null;
    probleme: string | null;
  },
): Promise<Diagnostic> {
  const anthropic = client(env);

  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    ...REFUSAL_FALLBACK,
    // La synthèse engage un déplacement et un chiffrage : on paie l'effort.
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: DIAGNOSTIC_SCHEMA },
    },
    system: [
      { type: 'text', text: PREAMBLE, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: SYNTHESIS_PROMPT },
    ],
    messages: [
      {
        role: 'user',
        content: JSON.stringify(payload, null, 2),
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new VisionError('refusal', 'Synthèse déclinée par le modèle.');
  }

  logUsage(env, 'synthese', response.usage);
  return parseJson<Diagnostic>(response);
}

const SYNTHESIS_PROMPT = `Tu reçois l'ensemble d'un dossier : les réponses du client au questionnaire et les analyses des photos. Produis le diagnostic qui servira à préparer l'intervention.

Ce diagnostic est lu par un technicien qui va charger son camion. Sois utile à cette décision précise : quelle pièce emporter, combien de temps prévoir, et faut-il y aller aujourd'hui.

Ne surestime jamais ta certitude. Trois photos et six questions ne remplacent pas une visite : si les éléments ne permettent pas de trancher entre deux causes, dis-le dans "likelyCause" et mets "confidence" à "faible". Un diagnostic prudent et honnête vaut mieux qu'un diagnostic affirmatif et faux — le technicien ajustera sur place, mais il ne peut pas rattraper une pièce restée à l'atelier.

Le champ "needsOnSite" vaut true dès qu'un élément déterminant reste invisible sur les photos.

"summary" est la seule partie potentiellement lue par le client : une à deux phrases, sans jargon. "technicianNotes" est interne et peut être technique, direct, et mentionner les incertitudes.`;

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

export class VisionError extends Error {
  constructor(
    public code: 'refusal' | 'malformed' | 'empty',
    message: string,
  ) {
    super(message);
    this.name = 'VisionError';
  }
}

function parseJson<T>(response: { content: Array<{ type: string }> }): T {
  const block = response.content.find(
    (b): b is { type: 'text'; text: string } => b.type === 'text',
  );
  if (!block) throw new VisionError('empty', 'Réponse sans bloc texte.');
  try {
    return JSON.parse(block.text) as T;
  } catch {
    // `output_config.format` garantit la conformité au schéma ; arriver ici
    // signale un incident côté API, pas une donnée client inhabituelle.
    throw new VisionError('malformed', 'JSON non parseable malgré le schéma.');
  }
}

function logUsage(
  env: Env,
  label: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
  },
): void {
  // Sans cette trace, la dérive de coût est invisible. `cache_read` à zéro sur
  // des appels successifs signale que le préfixe a été invalidé.
  if (env.LOG_USAGE !== 'true') return;
  console.log(
    JSON.stringify({
      evt: 'claude_usage',
      label,
      in: usage.input_tokens,
      out: usage.output_tokens,
      cached: usage.cache_read_input_tokens ?? 0,
    }),
  );
}
