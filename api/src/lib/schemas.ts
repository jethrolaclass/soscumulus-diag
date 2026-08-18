/**
 * Schémas JSON pour les sorties structurées.
 *
 * Contraintes de la fonctionnalité, à respecter sous peine de 400 :
 *  - `additionalProperties: false` sur chaque objet ;
 *  - toute propriété déclarée doit figurer dans `required` — l'optionnalité
 *    s'exprime par un type nullable, pas par une absence ;
 *  - pas de `minLength`, `maximum`, `pattern` ni de schéma récursif.
 *
 * Un schéma par emplacement plutôt qu'un schéma unique à branches : le modèle
 * ne voit que les champs qui le concernent, ce qui évite les remplissages
 * parasites et raccourcit la sortie.
 */

import type { PhotoSlot } from '../../../shared/types';

type JsonSchema = Record<string, unknown>;

const nullable = (type: string): string[] => [type, 'null'];

/** Champs de contrôle qualité, communs aux trois emplacements. */
const QUALITY_FIELDS: JsonSchema = {
  usable: {
    type: 'boolean',
    description:
      "true si un technicien peut exploiter cette photo, même imparfaite.",
  },
  quality: { type: 'string', enum: ['bonne', 'moyenne', 'insuffisante'] },
  problems: {
    type: 'array',
    items: {
      type: 'string',
      enum: ['flou', 'sombre', 'trop_loin', 'reflet', 'cadrage', 'hors_sujet'],
    },
    description: 'Vide si aucun défaut notable.',
  },
  guidance: {
    type: nullable('string'),
    description:
      "Une phrase à la deuxième personne du pluriel décrivant le geste à faire. null si la photo convient.",
  },
};

const QUALITY_KEYS = Object.keys(QUALITY_FIELDS);

const NAMEPLATE: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'readable',
    'brand',
    'model',
    'capacityLiters',
    'powerWatts',
    'serial',
    'manufactureDate',
    'type',
  ],
  properties: {
    readable: {
      type: 'boolean',
      description: "false si l'étiquette est présente mais illisible.",
    },
    brand: { type: nullable('string') },
    model: {
      type: nullable('string'),
      description: 'Référence commerciale exacte, telle qu\'imprimée.',
    },
    capacityLiters: { type: nullable('integer') },
    powerWatts: { type: nullable('integer') },
    serial: { type: nullable('string') },
    manufactureDate: {
      type: nullable('string'),
      description: 'Tel qu\'imprimé, sans reformatage (ex. "03/2016", "2016").',
    },
    type: {
      type: 'string',
      enum: [
        'electrique_blinde',
        'electrique_steatite',
        'thermodynamique',
        'gaz',
        'inconnu',
      ],
    },
  },
};

const INSTALLATION: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'mounting',
    'accessClearance',
    'groupeSecuriteVisible',
    'corrosionVisible',
  ],
  properties: {
    mounting: {
      type: 'string',
      enum: [
        'mural_vertical',
        'mural_horizontal',
        'sur_socle',
        'sous_evier',
        'inconnu',
      ],
    },
    accessClearance: {
      type: 'string',
      enum: ['suffisant', 'limite', 'insuffisant', 'inconnu'],
      description:
        "Dégagement pour déposer le capot et sortir la cuve. Détermine la durée d'intervention.",
    },
    groupeSecuriteVisible: { type: nullable('boolean') },
    corrosionVisible: { type: nullable('boolean') },
  },
};

const LEAK: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['present', 'origin', 'severity'],
  properties: {
    present: {
      type: nullable('boolean'),
      description: 'null si la photo ne permet pas de trancher.',
    },
    origin: {
      type: 'string',
      enum: [
        'groupe_securite',
        'raccord',
        'cuve',
        'joint_trappe',
        'indetermine',
      ],
      description: 'cuve implique un remplacement complet de l\'appareil.',
    },
    severity: {
      type: 'string',
      enum: ['suintement', 'goutte_a_goutte', 'ecoulement', 'aucune'],
    },
  },
};

function photoSchema(extra: Record<string, JsonSchema>): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...QUALITY_KEYS, ...Object.keys(extra)],
    properties: { ...QUALITY_FIELDS, ...extra },
  };
}

export const PHOTO_ANALYSIS_SCHEMAS: Record<PhotoSlot, JsonSchema> = {
  1: photoSchema({ nameplate: NAMEPLATE }),
  2: photoSchema({ installation: INSTALLATION }),
  3: photoSchema({ leak: LEAK }),
};

export const DIAGNOSTIC_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'summary',
    'likelyCause',
    'recommendedAction',
    'urgency',
    'partsLikely',
    'estimatedDurationMin',
    'confidence',
    'needsOnSite',
    'technicianNotes',
  ],
  properties: {
    summary: {
      type: 'string',
      description:
        'Une à deux phrases sans jargon. Seule partie potentiellement lue par le client.',
    },
    likelyCause: { type: 'string' },
    recommendedAction: { type: 'string' },
    urgency: {
      type: 'string',
      enum: ['immediate', 'sous_24h', 'sous_72h', 'planifiable'],
    },
    partsLikely: {
      type: 'array',
      items: { type: 'string' },
      description: 'Pièces à charger dans le camion. Vide si indéterminable.',
    },
    estimatedDurationMin: { type: nullable('integer') },
    confidence: { type: 'string', enum: ['haute', 'moyenne', 'faible'] },
    needsOnSite: {
      type: 'boolean',
      description:
        'true dès qu\'un élément déterminant reste invisible sur les photos.',
    },
    technicianNotes: {
      type: 'string',
      description: 'Interne. Peut être technique et mentionner les incertitudes.',
    },
  },
};

/**
 * Bandeau de commande. Le modèle voit plusieurs images d'une même scène prises
 * à intervalle régulier : la question porte sur ce qui *change* entre elles.
 */
export const BANDEAU_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'usable',
    'guidance',
    'displayType',
    'code',
    'blinkPattern',
    'indicators',
    'interpretation',
  ],
  properties: {
    usable: { type: 'boolean' },
    guidance: {
      type: nullable('string'),
      description:
        'Une phrase à la deuxième personne du pluriel si la capture est à refaire. null sinon.',
    },
    displayType: {
      type: 'string',
      enum: [
        'afficheur_numerique',
        'voyants',
        'ecran_lcd',
        'aucun',
        'indetermine',
      ],
    },
    code: {
      type: nullable('string'),
      description: "Code lu tel qu'affiché, sans interprétation. Ex. « E3 ».",
    },
    blinkPattern: {
      type: nullable('string'),
      description:
        "Ce qui change d'une image à l'autre, décrit en clair. null si rien ne varie.",
    },
    indicators: {
      type: 'array',
      items: { type: 'string' },
      description: 'Voyants observés, un par entrée, avec couleur et position.',
    },
    interpretation: {
      type: nullable('string'),
      description:
        "Lecture technique du signal. null si elle exige le manuel du modèle.",
    },
  },
};
