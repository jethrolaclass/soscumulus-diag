/**
 * Vision calls. Single point of contact with the model: if the authentication
 * mechanism or the provider ever changes, this is the only file to touch.
 *
 * Two architectural constraints drive this module:
 *
 *  1. Images reach the model through the Files API, never base64 and never a
 *     URL the API has to fetch. Signed URLs were the first design and had to
 *     go: the generated URL answered 200 with the right image from everywhere
 *     we could test, yet the API replied "Unable to download the file" — from
 *     the custom domain and from workers.dev alike. Whatever blocks that
 *     inbound fetch is outside our reach, so we push instead of being pulled.
 *
 *     The bytes stream from R2 into the upload as a Blob copy, not a base64
 *     encode — a memory copy, cheap enough to stay inside the CPU budget.
 *     Uploaded files are deleted once the analysis returns.
 *
 *  2. Structured output, no agent loop. The task is "look at this photo,
 *     return this JSON": `output_config.format` guarantees a parseable result
 *     in a single round trip.
 *
 * Prompts stay in French: the model must return client-facing guidance in
 * French, and the domain vocabulary (étiquette signalétique, groupe de
 * sécurité, bandeau) has no crisp English equivalent for this trade.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  ControlPanelAnalysis,
  Diagnosis,
  PhotoAnalysis,
  PhotoSlot,
} from '../../../shared/types';
import type { Env } from '../env';
import {
  PHOTO_ANALYSIS_SCHEMAS,
  DIAGNOSIS_SCHEMA,
  CONTROL_PANEL_SCHEMA,
} from './schemas';

const MODEL = 'claude-opus-5';

/**
 * Opus 5 classifiers may decline a request (HTTP 200, `stop_reason: refusal`).
 * Unlikely on boiler-room photos, but a false positive must not break a client
 * diagnosis: the server-side fallback re-serves the request on another model
 * within the same call.
 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FILES_BETA = 'files-api-2025-04-14';

/**
 * `fallbacks` is accepted by the API but not yet described by the SDK types
 * (0.72.x). Injected through a deliberately widened object rather than casting
 * the whole call, so the remaining parameters stay type-checked. Remove once
 * the SDK exposes the field.
 */
const REFUSAL_FALLBACK = {
  betas: [FALLBACK_BETA, FILES_BETA],
  fallbacks: 'default',
} as unknown as { betas: string[] };

/**
 * Push one R2 object to the Files API and return its id.
 *
 * Throws when the object is missing: an absent photo is a bug worth surfacing,
 * not something to paper over with a partial analysis.
 */
export async function uploadImage(env: Env, r2Key: string): Promise<string> {
  const object = await env.PHOTOS.get(r2Key);
  if (!object) throw new VisionError('empty', `R2 object missing: ${r2Key}`);

  const uploaded = await client(env).beta.files.upload({
    file: new File([await object.blob()], 'photo.jpg', { type: 'image/jpeg' }),
    betas: [FILES_BETA],
  });
  return uploaded.id;
}

/** Best effort: a leftover file costs storage, never correctness. */
export async function deleteImages(env: Env, fileIds: string[]): Promise<void> {
  await Promise.all(
    fileIds.map((id) =>
      client(env)
        .beta.files.delete(id, { betas: [FILES_BETA] })
        .catch((err) => console.error(`file ${id} not deleted`, err)),
    ),
  );
}

function client(env: Env): Anthropic {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
}

/* ------------------------------------------------------------------ */
/* Prompts                                                             */
/* ------------------------------------------------------------------ */

/**
 * Shared preamble, identical on every call — this is what carries the cache
 * breakpoint. Caching only kicks in above a 512-token prefix on Opus 5: do not
 * shorten this block without checking `cache_read_input_tokens` in the logs,
 * or every photo pays full price.
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

Le code-barres mérite une attention particulière : ses chiffres sont presque toujours imprimés **à la verticale**, le long du bord gauche ou droit de l'étiquette, tournés de 90 degrés par rapport au reste du texte. C'est pour cette raison qu'on les oublie. Ils forment une suite de quatorze à seize chiffres qui identifie l'appareil exact — c'est ce qui permet de commander la bonne pièce et de vérifier une garantie, donc l'information la plus utile de toute l'étiquette après la référence.

Prends le temps de faire pivoter mentalement cette zone et de lire les chiffres un par un. Reporte-les dans "barcode" sans espace ni séparateur. Si un seul chiffre reste douteux, le champ vaut null : un numéro à un chiffre près ne sert à rien et fait commander la mauvaise pièce.

Le champ "serial" est distinct : il n'est renseigné que si l'étiquette porte un numéro de série explicitement libellé comme tel, en plus du code-barres.

Si l'étiquette est présente mais qu'aucun caractère n'est lisible, nameplate.readable vaut false et tous les champs valent null.`,

  2: `Photo demandée : le chauffe-eau en entier, dans son environnement.

Évalue le dégagement disponible autour de l'appareil : un technicien doit pouvoir déposer le capot, accéder au groupe de sécurité et, si besoin, sortir la cuve. « insufficient » signifie qu'une dépose sera impossible sans démonter autre chose — c'est une information qui change le chiffrage et la durée de l'intervention, signale-la sans hésiter.

Le groupe de sécurité est la petite pièce en laiton sur l'arrivée d'eau froide, généralement munie d'une molette et d'un tuyau d'évacuation.`,

  3: `Photo demandée : la zone où le client voit de l'eau.

Cherche l'origine de l'écoulement, pas seulement sa présence. Une eau qui s'écoule au sol peut venir du groupe de sécurité — ce qui est parfois normal en phase de chauffe —, d'un raccord desserré, du joint de la trappe de visite, ou d'un percement de cuve, qui impose un remplacement complet. Trace le trajet de l'eau, en remontant vers le point haut mouillé.

Distingue une trace ancienne, sèche ou calcaire, d'un écoulement actif. Si le client déclare ne rien voir couler et que la photo le confirme, leak.present vaut false.`,
};

const CONTROL_PANEL_PROMPT = `Tu reçois plusieurs images du bandeau de commande d'un chauffe-eau, extraites d'une même vidéo de dix secondes et espacées régulièrement dans le temps. Elles sont fournies dans l'ordre chronologique.

Ta question n'est pas « que montre cette image » mais « qu'est-ce qui change d'une image à l'autre ». Les chauffe-eau électroniques signalent leurs défauts par une séquence : un voyant allumé sur deux images et éteint sur les trois autres décrit un clignotement, et le rythme fait partie du diagnostic autant que la couleur.

Compare donc les images entre elles avant de conclure. Décris dans "blinkPattern" ce que tu observes de variation, en clair et sans jargon d'expert — par exemple « le voyant rouge de droite est allumé sur les images 1 et 3, éteint sur les autres, ce qui correspond à un clignotement lent ». Si tout est strictement identique d'une image à l'autre, blinkPattern vaut null et tu le signales comme un affichage fixe dans "indicators".

Le champ "code" ne contient que ce qui est écrit à l'écran, transcrit tel quel. N'interprète pas dans ce champ et ne complète pas un caractère douteux : un code de défaut mal lu envoie le technicien sur une fausse piste.

Le champ "interpretation" accueille ta lecture technique, mais uniquement si elle est fondée. Les codes de défaut varient d'un constructeur à l'autre et souvent d'une gamme à l'autre : si la signification exacte demande le manuel du modèle, mets null plutôt qu'une hypothèse. Décrire correctement le signal a plus de valeur que le traduire de travers.`;

const SYNTHESIS_PROMPT = `Tu reçois l'ensemble d'un dossier : les réponses du client au questionnaire et les analyses des photos. Produis le diagnostic qui servira à préparer l'intervention.

Ce diagnostic est lu par un technicien qui va charger son camion. Sois utile à cette décision précise : quelle pièce emporter, combien de temps prévoir, et faut-il y aller aujourd'hui.

Ne surestime jamais ta certitude. Trois photos et six questions ne remplacent pas une visite : si les éléments ne permettent pas de trancher entre deux causes, dis-le dans "likelyCause" et mets "confidence" à "low". Un diagnostic prudent et honnête vaut mieux qu'un diagnostic affirmatif et faux — le technicien ajustera sur place, mais il ne peut pas rattraper une pièce restée à l'atelier.

Le champ "needsOnSite" vaut true dès qu'un élément déterminant reste invisible sur les photos.

"summary" est la seule partie potentiellement lue par le client : une à deux phrases, sans jargon. "technicianNotes" est interne et peut être technique, direct, et mentionner les incertitudes.`;

/* ------------------------------------------------------------------ */
/* Photo analysis                                                      */
/* ------------------------------------------------------------------ */

export interface PhotoContext {
  city: string | null;
  reportedIssue: string | null;
  /** Attempt number — above 1, the client has already retaken the photo. */
  attempt: number;
}

export async function analyzePhoto(
  env: Env,
  slot: PhotoSlot,
  fileId: string,
  context: PhotoContext,
): Promise<PhotoAnalysis> {
  const anthropic = client(env);

  const declared = [
    context.city ? `Commune : ${context.city}.` : null,
    context.reportedIssue
      ? `Problème déclaré par le client : « ${context.reportedIssue} ».`
      : null,
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
    // `medium` is ample for label reading and quality control, and Opus 5 stays
    // strong there. Raise to `high` only if evaluation on real photos shows a
    // gap.
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
          { type: 'image', source: { type: 'file', file_id: fileId } },
          { type: 'text', text: declared || 'Analyse cette photo.' },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new VisionError('refusal', 'Analyse déclinée par le modèle.');
  }

  logUsage(env, `photo:${slot}`, response.usage);

  // Each schema carries only its own section: fill the other two so the
  // `PhotoAnalysis` shape stays uniform whatever the slot.
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
/* Control panel                                                       */
/* ------------------------------------------------------------------ */

export async function analyzeControlPanel(
  env: Env,
  frameIds: string[],
  context: { reportedIssue: string | null },
): Promise<ControlPanelAnalysis> {
  const anthropic = client(env);

  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    ...REFUSAL_FALLBACK,
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: CONTROL_PANEL_SCHEMA },
    },
    system: [
      { type: 'text', text: PREAMBLE, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: CONTROL_PANEL_PROMPT },
    ],
    messages: [
      {
        role: 'user',
        content: [
          // Each frame is preceded by its rank: with no explicit marker the
          // model has no way to restore the order in its description.
          ...frameIds.flatMap((fileId, i) => [
            {
              type: 'text' as const,
              text: `Image ${i + 1} sur ${frameIds.length}`,
            },
            {
              type: 'image' as const,
              source: { type: 'file' as const, file_id: fileId },
            },
          ]),
          {
            type: 'text' as const,
            text: context.reportedIssue
              ? `Problème déclaré par le client : « ${context.reportedIssue} ».`
              : "Décris ce qu'affiche le bandeau.",
          },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new VisionError('refusal', 'Analyse du bandeau déclinée.');
  }

  logUsage(env, 'control_panel', response.usage);
  const parsed = parseJson<Omit<ControlPanelAnalysis, 'frameCount'>>(response);
  return { ...parsed, frameCount: frameIds.length };
}

/* ------------------------------------------------------------------ */
/* Synthesis                                                           */
/* ------------------------------------------------------------------ */

export async function synthesize(
  env: Env,
  payload: {
    answers: unknown;
    analyses: PhotoAnalysis[];
    panel: ControlPanelAnalysis | null;
    city: string | null;
    reportedIssue: string | null;
  },
): Promise<Diagnosis> {
  const anthropic = client(env);

  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    ...REFUSAL_FALLBACK,
    // The synthesis commits a call-out and a quote: the effort is worth paying.
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: DIAGNOSIS_SCHEMA },
    },
    system: [
      { type: 'text', text: PREAMBLE, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: SYNTHESIS_PROMPT },
    ],
    messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
  });

  if (response.stop_reason === 'refusal') {
    throw new VisionError('refusal', 'Synthèse déclinée par le modèle.');
  }

  logUsage(env, 'synthesis', response.usage);
  return parseJson<Diagnosis>(response);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
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
  if (!block) throw new VisionError('empty', 'Response carried no text block.');
  try {
    return JSON.parse(block.text) as T;
  } catch {
    // `output_config.format` guarantees schema conformance; reaching here
    // signals an API incident, not unusual client data.
    throw new VisionError('malformed', 'JSON unparseable despite the schema.');
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
  // Without this trace, cost drift is invisible. A zero `cached` across
  // successive calls means the prefix was invalidated.
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
