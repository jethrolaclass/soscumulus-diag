/**
 * JSON schemas for structured outputs.
 *
 * Feature constraints, to respect or get a 400:
 *  - `additionalProperties: false` on every object;
 *  - every declared property must appear in `required` — optionality is
 *    expressed by a nullable type, not by absence;
 *  - no `minLength`, `maximum`, `pattern`, no recursive schema.
 *
 * One schema per photo slot rather than a single branching schema: the model
 * only sees the fields that concern it, which avoids stray fills and keeps the
 * output short.
 */

import type { PhotoSlot } from '../../../shared/types';

type JsonSchema = Record<string, unknown>;

const nullable = (type: string): string[] => [type, 'null'];

/** Quality-control fields, common to all three slots. */
const QUALITY_FIELDS: JsonSchema = {
  usable: {
    type: 'boolean',
    description: 'true if a technician can work from this photo, even imperfect.',
  },
  quality: { type: 'string', enum: ['good', 'fair', 'poor'] },
  problems: {
    type: 'array',
    items: {
      type: 'string',
      enum: ['blurry', 'dark', 'too_far', 'glare', 'framing', 'off_subject'],
    },
    description: 'Empty when there is no notable defect.',
  },
  guidance: {
    type: nullable('string'),
    description:
      'One sentence in French, second person plural, naming the gesture to make. null when the photo is fine.',
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
    'voltage',
    'pressureBar',
    'heatUpTime',
    'tankLining',
    'protectionIndex',
    'manufactureCode',
    'serial',
    'barcode',
    'manufactureDate',
    'type',
  ],
  properties: {
    readable: {
      type: 'boolean',
      description: 'false when the label is present but illegible.',
    },
    brand: { type: nullable('string') },
    model: {
      type: nullable('string'),
      description: 'Commercial reference exactly as printed.',
    },
    capacityLiters: { type: nullable('integer') },
    powerWatts: { type: nullable('integer') },
    voltage: {
      type: nullable('string'),
      description: 'As printed, e.g. "230V~", "400V 3~". Never normalised.',
    },
    pressureBar: {
      type: nullable('number'),
      description:
        'Maximum service pressure in bar. Convert from MPa: 1 MPa = 10 bar.',
    },
    heatUpTime: {
      type: nullable('string'),
      description: 'Heating time as printed, e.g. "4 h 20 min".',
    },
    tankLining: {
      type: nullable('string'),
      description: 'Tank protection marking as printed, e.g. "FE+EMAIL", "INOX".',
    },
    protectionIndex: {
      type: nullable('string'),
      description:
        'IP marking with the category when present, e.g. "IP25 D CAT.B".',
    },
    manufactureCode: {
      type: nullable('string'),
      description:
        'Manufacturing batch code as printed, e.g. "FAB 439". Transcribed, never decoded.',
    },
    serial: { type: nullable('string') },
    barcode: {
      type: nullable('string'),
      description:
        'Digits of the barcode, read one by one. null if a single digit is uncertain.',
    },
    manufactureDate: {
      type: nullable('string'),
      description: 'As printed, unreformatted (e.g. "03/2016", "2016").',
    },
    type: {
      type: 'string',
      enum: [
        'electric_immersion',
        'electric_steatite',
        'heat_pump',
        'gas',
        'unknown',
      ],
    },
  },
};

const INSTALLATION: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mounting', 'accessClearance', 'safetyGroupVisible', 'corrosionVisible'],
  properties: {
    mounting: {
      type: 'string',
      enum: [
        'wall_vertical',
        'wall_horizontal',
        'floor_standing',
        'under_sink',
        'unknown',
      ],
    },
    accessClearance: {
      type: 'string',
      enum: ['sufficient', 'tight', 'insufficient', 'unknown'],
      description:
        'Room to remove the cover and pull the tank. Drives the job duration.',
    },
    safetyGroupVisible: { type: nullable('boolean') },
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
      description: 'null when the photo does not settle the question.',
    },
    origin: {
      type: 'string',
      enum: ['safety_group', 'fitting', 'tank', 'hatch_gasket', 'undetermined'],
      description: 'tank means the whole unit has to be replaced.',
    },
    severity: {
      type: 'string',
      enum: ['seeping', 'dripping', 'running', 'none'],
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

/**
 * Control panel. The model sees several frames of one scene taken at regular
 * intervals: the question is about what *changes* between them.
 */
export const CONTROL_PANEL_SCHEMA: JsonSchema = {
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
        'One sentence in French, second person plural, when the capture must be redone. null otherwise.',
    },
    displayType: {
      type: 'string',
      enum: ['seven_segment', 'indicator_lights', 'lcd', 'none', 'unknown'],
    },
    code: {
      type: nullable('string'),
      description: 'Code read verbatim, no interpretation. E.g. "E3".',
    },
    blinkPattern: {
      type: nullable('string'),
      description:
        'What changes from one frame to the next, in plain words. null when nothing varies.',
    },
    indicators: {
      type: 'array',
      items: { type: 'string' },
      description: 'Lights observed, one per entry, with colour and position.',
    },
    interpretation: {
      type: nullable('string'),
      description: 'Technical reading. null when it would require the model manual.',
    },
  },
};

export const DIAGNOSIS_SCHEMA: JsonSchema = {
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
        'One or two sentences in French, no jargon. The only part the client may read.',
    },
    likelyCause: { type: 'string' },
    recommendedAction: { type: 'string' },
    urgency: {
      type: 'string',
      enum: ['immediate', 'within_24h', 'within_72h', 'schedulable'],
    },
    partsLikely: {
      type: 'array',
      items: { type: 'string' },
      description: 'Parts to load in the van. Empty when undeterminable.',
    },
    estimatedDurationMin: { type: nullable('integer') },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    needsOnSite: {
      type: 'boolean',
      description:
        'true as soon as a decisive element stays invisible on the photos.',
    },
    technicianNotes: {
      type: 'string',
      description: 'Internal. May be technical and mention uncertainties.',
    },
  },
};
