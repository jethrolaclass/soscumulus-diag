/**
 * Water heaters: what is installed out there, what we sell, and what replaces
 * what.
 *
 * Seeded from Atlantic's 2026 replacement guide (pages 234-239), read off the
 * document itself. Every row is marked `source: 'guide-2026'`; anything a
 * technician adds later from the compatibility table of the intervention sheet
 * should be marked `source: 'terrain'`, because measured beats printed.
 *
 * THE IMPORTANT CAVEAT. The guide sorts by bracket spacing and shell diameter —
 * Ø 505 against Ø 570, entraxe 800 against 1050. A nameplate photo gives none
 * of that: it gives brand, commercial reference and capacity. So a photo
 * narrows the choice to a handful of candidates and no further, and the last
 * step is a tape measure on site. `findCandidates` returns a list for exactly
 * that reason, and a quote built on a single-candidate guess would be a quote
 * for the wrong appliance.
 *
 * Dimensions are millimetres, as printed in the guide.
 */

export type Orientation = 'vertical' | 'horizontal' | 'integration';
export type Mounting = 'wall' | 'floor';
/** Tank protection, as the guide groups its rows. */
export type Tech = 'blinde' | 'steatite' | 'aci' | 'hpc' | 'thermodynamique';
/** Where the water connects: underneath, or on the side. */
export type Connection = 'below' | 'side';

export interface Heater {
  brand: string;
  /** Commercial reference when the guide gives one, else the family. */
  model: string;
  capacityLiters: number;
  orientation: Orientation;
  mounting: Mounting;
  tech: Tech | null;
  connection: Connection | null;

  heightMm: number | null;
  /** Width for a flat unit; length for a horizontal one. */
  widthMm: number | null;
  diameterMm: number | null;
  /** Entraxe H — between the two fixing points of one bracket. */
  bracketHMm: number | null;
  /** Entraxe V — between the upper and the lower bracket. */
  bracketVMm: number | null;
  /** Cote A — upper bracket to the water connections. */
  coteAMm: number | null;

  /** Set on what we sell. Null on an installed appliance we only recognise. */
  sku: string | null;
  /** Euros including tax, appliance alone. Null until the price list is filled. */
  price: number | null;

  /** SKUs that go in its place. Empty on our own products. */
  compatibleWith: string[];
  source: 'guide-2026' | 'terrain';
}

/* ------------------------------------------------------------------ */
/* What we sell — Atlantic and Thermor only                            */
/* ------------------------------------------------------------------ */

const sold = (
  model: string,
  sku: string,
  capacityLiters: number,
  orientation: Orientation,
  tech: Tech | null,
  dims: Partial<Heater>,
  brand = 'Atlantic',
): Heater => ({
  brand,
  model,
  capacityLiters,
  orientation,
  mounting: 'wall',
  tech,
  connection: null,
  heightMm: null,
  widthMm: null,
  diameterMm: null,
  bracketHMm: null,
  bracketVMm: null,
  coteAMm: null,
  sku,
  price: null,
  compatibleWith: [],
  source: 'guide-2026',
  ...dims,
});

export const CATALOGUE: Heater[] = [
  // ---- Horizontal mural, raccord dessous (guide p. 234-235)
  sold('Chaufféo 100 L', '023172', 100, 'horizontal', 'blinde', {
    widthMm: 830, bracketHMm: 500, diameterMm: 520, connection: 'below',
  }),
  sold('Chaufféo+ 100 L', '053121', 100, 'horizontal', 'steatite', {
    widthMm: 830, bracketHMm: 500, diameterMm: 520, connection: 'below',
  }),
  // The guide prints "Zénéo 155412" in the horizontal 100 L row and again in
  // the 150 L one, while the series reads 155411 / 155412 / 155413 for
  // 100 / 150 / 200 L. Taken as a misprint on the 100 L line — to confirm with
  // Atlantic before anything is ordered on it.
  sold('Zénéo 100 L', '155411', 100, 'horizontal', 'aci', {
    widthMm: 830, bracketHMm: 500, diameterMm: 520, connection: 'below',
  }),
  sold('Chaufféo 100 L', '025109', 100, 'horizontal', 'blinde', {
    widthMm: 740, diameterMm: 570, connection: 'side',
  }),
  sold('Chaufféo 150 L', '023178', 150, 'horizontal', 'blinde', {
    widthMm: 1140, bracketHMm: 800, diameterMm: 520, connection: 'below',
  }),
  sold('Chaufféo+ 150 L', '053122', 150, 'horizontal', 'steatite', {
    widthMm: 1140, bracketHMm: 800, diameterMm: 520, connection: 'below',
  }),
  sold('Zénéo 150 L', '155412', 150, 'horizontal', 'aci', {
    widthMm: 1140, bracketHMm: 800, diameterMm: 520, connection: 'below',
  }),
  sold('Chaufféo 150 L', '025122', 150, 'horizontal', 'blinde', {
    widthMm: 990, diameterMm: 570, connection: 'side',
  }),
  sold('Chaufféo 200 L', '023193', 200, 'horizontal', 'blinde', {
    widthMm: 1460, bracketHMm: 800, diameterMm: 520, connection: 'below',
  }),
  sold('Chaufféo+ 200 L', '053123', 200, 'horizontal', 'steatite', {
    widthMm: 1460, bracketHMm: 800, diameterMm: 520, connection: 'below',
  }),
  sold('Zénéo 200 L', '155413', 200, 'horizontal', 'aci', {
    widthMm: 1460, bracketHMm: 800, diameterMm: 520, connection: 'below',
  }),
  sold('Chaufféo 200 L', '025118', 200, 'horizontal', 'blinde', {
    widthMm: 1245, diameterMm: 570, connection: 'side',
  }),

  // ---- Vertical mural standard Ø 513 (guide p. 236-237)
  sold('Chaufféo 100 L', '021114', 100, 'vertical', 'blinde', {
    diameterMm: 513, heightMm: 835, coteAMm: 85, bracketVMm: 750,
  }),
  sold('Zénéo 100 L', '153109', 100, 'vertical', 'aci', {
    diameterMm: 513, heightMm: 835, coteAMm: 85, bracketVMm: 750,
  }),
  sold('Chaufféo+ 100 L', '053015', 100, 'vertical', 'steatite', {
    diameterMm: 513, heightMm: 835, coteAMm: 85, bracketVMm: 750,
  }),
  sold('Calypso Connecté 100 L', '234511', 100, 'vertical', 'thermodynamique', {
    diameterMm: 580, heightMm: 1050, coteAMm: 55, bracketVMm: 800,
  }),
  sold('Chaufféo 150 L', '021116', 150, 'vertical', 'blinde', {
    diameterMm: 513, heightMm: 1155, coteAMm: 105, bracketVMm: 800,
  }),
  sold('Zénéo 150 L', '153111', 150, 'vertical', 'aci', {
    diameterMm: 513, heightMm: 1155, coteAMm: 105, bracketVMm: 800,
  }),
  sold('Chaufféo+ 150 L', '053016', 150, 'vertical', 'steatite', {
    diameterMm: 513, heightMm: 1155, coteAMm: 105, bracketVMm: 800,
  }),
  sold('Calypso Connecté 150 L', '234512', 150, 'vertical', 'thermodynamique', {
    diameterMm: 580, heightMm: 1300, coteAMm: 351, bracketVMm: 800,
  }),
  sold('Chaufféo 200 L', '021117', 200, 'vertical', 'blinde', {
    diameterMm: 513, heightMm: 1475, coteAMm: 425, bracketVMm: 800,
  }),
  sold('Zénéo 200 L', '153112', 200, 'vertical', 'aci', {
    diameterMm: 513, heightMm: 1475, coteAMm: 425, bracketVMm: 800,
  }),
  sold('Chaufféo+ 200 L', '053017', 200, 'vertical', 'steatite', {
    diameterMm: 513, heightMm: 1475, coteAMm: 425, bracketVMm: 800,
  }),
  sold('Aquéo 150 L', '154116', 150, 'vertical', 'aci', {
    diameterMm: 513, heightMm: 1155, coteAMm: 105, bracketVMm: 800,
  }),
  sold('Aquéo 200 L', '154117', 200, 'vertical', 'aci', {
    diameterMm: 513, heightMm: 1475, coteAMm: 425, bracketVMm: 800,
  }),

  // ---- Vertical mural compact Ø 570 (guide p. 236-237)
  sold('Chaufféo 100 L compact', '021210', 100, 'vertical', 'blinde', {
    diameterMm: 570, heightMm: 770, coteAMm: 160, bracketVMm: 570,
  }),
  sold('Chaufféo 100 L compact', '021225', 100, 'vertical', 'blinde', {
    diameterMm: 570, heightMm: 740, coteAMm: 165, bracketVMm: 570,
  }),
  sold('Chaufféo+ 100 L compact', '053008', 100, 'vertical', 'steatite', {
    diameterMm: 570, heightMm: 770, coteAMm: 160, bracketVMm: 570,
  }),
  sold('Zénéo 100 L compact', '156210', 100, 'vertical', 'aci', {
    diameterMm: 570, heightMm: 780, coteAMm: 135, bracketVMm: 570,
  }),
  sold('Zénéo 100 L compact', '156211', 100, 'vertical', 'aci', {
    diameterMm: 570, heightMm: 740, coteAMm: 165, bracketVMm: 570,
  }),
  sold('Chaufféo 150 L compact', '021215', 150, 'vertical', 'blinde', {
    diameterMm: 570, heightMm: 1020, coteAMm: 230, bracketVMm: 750,
  }),
  sold('Chaufféo 150 L compact', '021226', 150, 'vertical', 'blinde', {
    diameterMm: 570, heightMm: 990, coteAMm: 235, bracketVMm: 750,
  }),
  sold('Chaufféo+ 150 L compact', '053009', 150, 'vertical', 'steatite', {
    diameterMm: 570, heightMm: 1020, coteAMm: 230, bracketVMm: 750,
  }),
  sold('Zénéo 150 L compact', '156215', 150, 'vertical', 'aci', {
    diameterMm: 570, heightMm: 1030, coteAMm: 210, bracketVMm: 750,
  }),
  sold('Zénéo 150 L compact', '156212', 150, 'vertical', 'aci', {
    diameterMm: 570, heightMm: 990, coteAMm: 235, bracketVMm: 750,
  }),
  sold('Chaufféo 200 L compact', '021220', 200, 'vertical', 'blinde', {
    diameterMm: 570, heightMm: 1275, coteAMm: 185, bracketVMm: 800,
  }),
  sold('Chaufféo 200 L compact', '021227', 200, 'vertical', 'blinde', {
    diameterMm: 570, heightMm: 1245, coteAMm: 190, bracketVMm: 800,
  }),
  sold('Zénéo 200 L compact', '156220', 200, 'vertical', 'aci', {
    diameterMm: 570, heightMm: 1255, coteAMm: 165, bracketVMm: 800,
  }),
  sold('Zénéo 200 L compact', '156213', 200, 'vertical', 'aci', {
    diameterMm: 570, heightMm: 1245, coteAMm: 190, bracketVMm: 800,
  }),

  // ---- Intégration, plat (guide p. 238-239)
  sold('Linéo 40 L', '157205', 40, 'integration', null, {
    widthMm: 490, heightMm: 765, bracketHMm: 440, bracketVMm: 500, coteAMm: 610,
  }),
  sold('Linéo 65 L', '157207', 65, 'integration', null, {
    widthMm: 490, heightMm: 1090, bracketHMm: 440, bracketVMm: 700, coteAMm: 975,
  }),
  sold('Linéo 80 L', '157209', 80, 'integration', null, {
    widthMm: 490, heightMm: 1300, bracketHMm: 440, bracketVMm: 800, coteAMm: 1185,
  }),
  sold('Linéo plat 100 L', '157216', 100, 'integration', null, {
    widthMm: 550, heightMm: 1240, bracketHMm: 440, bracketVMm: 800, coteAMm: 1122,
  }),
];

/* ------------------------------------------------------------------ */
/* What is out there, and what replaces it                             */
/* ------------------------------------------------------------------ */

const installed = (
  brand: string,
  model: string,
  capacityLiters: number,
  orientation: Orientation,
  tech: Tech | null,
  dims: Partial<Heater>,
  compatibleWith: string[],
): Heater => ({
  brand,
  model,
  capacityLiters,
  orientation,
  mounting: 'wall',
  tech,
  connection: null,
  heightMm: null,
  widthMm: null,
  diameterMm: null,
  bracketHMm: null,
  bracketVMm: null,
  coteAMm: null,
  sku: null,
  price: null,
  compatibleWith,
  source: 'guide-2026',
  ...dims,
});

export const INSTALLED: Heater[] = [
  // ---- Horizontal 100 L, raccord dessous
  installed('Ariston', 'Blindé', 100, 'horizontal', 'blinde',
    { widthMm: 750, bracketHMm: 280, diameterMm: 560, connection: 'below' },
    ['023172', '053121', '155411']),
  installed('Thermor', 'Blindé', 100, 'horizontal', 'blinde',
    { widthMm: 835, bracketHMm: 600, diameterMm: 505, connection: 'below' },
    ['023172', '053121', '155411']),
  installed('De Dietrich', 'ACI', 100, 'horizontal', 'aci',
    { widthMm: 835, bracketHMm: 600, diameterMm: 505, connection: 'below' },
    ['155411']),
  installed('Thermor', 'ACI / Duralis', 100, 'horizontal', 'aci',
    { widthMm: 835, bracketHMm: 600, diameterMm: 505, connection: 'below' },
    ['155411']),
  installed('Pacific', 'ACI', 100, 'horizontal', 'aci',
    { widthMm: 860, bracketHMm: 600, diameterMm: 505, connection: 'below' },
    ['155411']),
  installed('Thermor', 'Blindé', 100, 'horizontal', 'blinde',
    { widthMm: 745, diameterMm: 570, connection: 'side' }, ['025109']),
  installed('Pacific', 'Blindé', 100, 'horizontal', 'blinde',
    { widthMm: 745, diameterMm: 570, connection: 'side' }, ['025109']),

  // ---- Horizontal 150 L
  installed('Ariston', 'Blindé / Stéatite', 150, 'horizontal', 'blinde',
    { widthMm: 1010, bracketHMm: 500, diameterMm: 560, connection: 'below' },
    ['023178', '053122', '155412']),
  installed('Thermor', 'Blindé / Stéatite', 150, 'horizontal', 'blinde',
    { widthMm: 1155, bracketHMm: 800, diameterMm: 505, connection: 'below' },
    ['023178', '053122', '155412']),
  installed('De Dietrich', 'ACI', 150, 'horizontal', 'aci',
    { widthMm: 1155, bracketHMm: 600, diameterMm: 505, connection: 'below' },
    ['155412']),
  installed('Thermor', 'ACI / Duralis', 150, 'horizontal', 'aci',
    { widthMm: 1155, bracketHMm: 800, diameterMm: 505, connection: 'below' },
    ['155412']),
  installed('Pacific', 'ACI', 150, 'horizontal', 'aci',
    { widthMm: 1180, bracketHMm: 800, diameterMm: 505, connection: 'below' },
    ['155412']),
  installed('Thermor', 'Blindé', 150, 'horizontal', 'blinde',
    { widthMm: 1000, diameterMm: 570, connection: 'side' }, ['025122']),
  installed('Pacific', 'Blindé', 150, 'horizontal', 'blinde',
    { widthMm: 1000, diameterMm: 570, connection: 'side' }, ['025122']),

  // ---- Horizontal 200 L
  installed('Ariston', 'Blindé', 200, 'horizontal', 'blinde',
    { widthMm: 1270, bracketHMm: 800, diameterMm: 560, connection: 'below' },
    ['023193', '053123', '155413']),
  installed('Thermor', 'Blindé', 200, 'horizontal', 'blinde',
    { widthMm: 1475, bracketHMm: 1050, diameterMm: 505, connection: 'below' },
    ['023193', '053123', '155413']),
  installed('De Dietrich', 'ACI', 200, 'horizontal', 'aci',
    { widthMm: 1510, bracketHMm: 1050, diameterMm: 505, connection: 'below' },
    ['155413']),
  installed('Thermor', 'ACI / Duralis', 200, 'horizontal', 'aci',
    { widthMm: 1475, bracketHMm: 1050, diameterMm: 505, connection: 'below' },
    ['155413']),
  installed('Pacific', 'ACI', 200, 'horizontal', 'aci',
    { widthMm: 1510, bracketHMm: 1050, diameterMm: 505, connection: 'below' },
    ['155413']),
  installed('Thermor', 'Blindé', 200, 'horizontal', 'blinde',
    { widthMm: 1255, diameterMm: 570, connection: 'side' }, ['025118']),
  installed('Pacific', 'Blindé', 200, 'horizontal', 'blinde',
    { widthMm: 1255, diameterMm: 570, connection: 'side' }, ['025118']),

  // ---- Vertical standard Ø 505/530, 100 L
  installed('De Dietrich', 'Blindé', 100, 'vertical', 'blinde',
    { diameterMm: 505, heightMm: 885, coteAMm: 100 }, ['021114', '153109']),
  installed('Ariston', 'Blindé', 100, 'vertical', 'blinde',
    { diameterMm: 530, heightMm: 835, coteAMm: 270 }, ['021114', '153109']),
  installed('Thermor', 'Blindé', 100, 'vertical', 'blinde',
    { diameterMm: 505, heightMm: 885, coteAMm: 285 }, ['021114', '153109']),
  installed('Pacific', 'Blindé', 100, 'vertical', 'blinde',
    { diameterMm: 505, heightMm: 910, coteAMm: 300 }, ['021114', '153109']),
  installed('Thermor', 'Stéatite', 100, 'vertical', 'steatite',
    { diameterMm: 505, heightMm: 885, coteAMm: 285 }, ['053015', '153109']),
  installed('Thermor', 'ACI / Duralis / Visualis', 100, 'vertical', 'aci',
    { diameterMm: 505, heightMm: 885, coteAMm: 285 }, ['153109']),

  // ---- Vertical compact Ø 555/570, 100 L
  installed('Ariston', 'Blindé', 100, 'vertical', 'blinde',
    { diameterMm: 560, heightMm: 770, coteAMm: 220 }, ['021210', '021225']),
  installed('Thermor', 'Blindé', 100, 'vertical', 'blinde',
    { diameterMm: 570, heightMm: 780, coteAMm: 135 }, ['021210', '021225']),
  installed('Thermor', 'Stéatite', 100, 'vertical', 'steatite',
    { diameterMm: 570, heightMm: 780, coteAMm: 135 }, ['053008', '156210']),
  installed('Thermor', 'ACI / Duralis / Visualis', 100, 'vertical', 'aci',
    { diameterMm: 570, heightMm: 780, coteAMm: 135 }, ['156210', '156211']),

  // ---- Vertical standard Ø 505/513/530, 150 L
  installed('De Dietrich', 'Blindé', 150, 'vertical', 'blinde',
    { diameterMm: 513, heightMm: 1210, coteAMm: 120, bracketVMm: 800 },
    ['021116', '153111']),
  installed('Ariston', 'Blindé', 150, 'vertical', 'blinde',
    { diameterMm: 530, heightMm: 1160, coteAMm: 100, bracketVMm: 800 },
    ['021116', '153111']),
  installed('Thermor', 'Blindé', 150, 'vertical', 'blinde',
    { diameterMm: 513, heightMm: 1210, coteAMm: 120, bracketVMm: 800 },
    ['021116', '153111']),
  installed('Thermor', 'Stéatite', 150, 'vertical', 'steatite',
    { diameterMm: 513, heightMm: 1210, coteAMm: 120, bracketVMm: 800 },
    ['053016', '153111']),
  installed('Thermor', 'ACI / Duralis / Visualis', 150, 'vertical', 'aci',
    { diameterMm: 513, heightMm: 1210, coteAMm: 120, bracketVMm: 800 },
    ['153111']),

  // ---- Vertical compact Ø 555/570, 150 L
  installed('Ariston', 'Blindé', 150, 'vertical', 'blinde',
    { diameterMm: 560, heightMm: 1010, coteAMm: 260, bracketVMm: 500 },
    ['021215', '021226', '154116']),
  installed('Thermor', 'Blindé', 150, 'vertical', 'blinde',
    { diameterMm: 570, heightMm: 1030, coteAMm: 210, bracketVMm: 500 },
    ['021215', '021226', '154116']),
  installed('Thermor', 'Stéatite', 150, 'vertical', 'steatite',
    { diameterMm: 570, heightMm: 1030, coteAMm: 210, bracketVMm: 500 },
    ['053009', '156215', '156212']),
  installed('Thermor', 'ACI / Duralis', 150, 'vertical', 'aci',
    { diameterMm: 570, heightMm: 1030, coteAMm: 210, bracketVMm: 500 },
    ['156215', '156212']),

  // ---- Vertical standard Ø 505/513/530, 200 L
  installed('De Dietrich', 'Blindé', 200, 'vertical', 'blinde',
    { diameterMm: 513, heightMm: 1530, coteAMm: 535, bracketVMm: 800 },
    ['021117', '153112', '154117']),
  installed('Thermor', 'Blindé', 200, 'vertical', 'blinde',
    { diameterMm: 513, heightMm: 1530, coteAMm: 435, bracketVMm: 800 },
    ['021117', '153112', '154117']),
  installed('Thermor', 'Stéatite', 200, 'vertical', 'steatite',
    { diameterMm: 513, heightMm: 1530, coteAMm: 435, bracketVMm: 800 },
    ['053017', '153112']),
  installed('Thermor', 'ACI / Duralis / Visualis', 200, 'vertical', 'aci',
    { diameterMm: 513, heightMm: 1530, coteAMm: 435, bracketVMm: 800 },
    ['153112']),

  // ---- Vertical compact Ø 555/570, 200 L
  installed('Ariston', 'Blindé', 200, 'vertical', 'blinde',
    { diameterMm: 560, heightMm: 1280, coteAMm: 220, bracketVMm: 800 },
    ['021220', '021227']),
  installed('Thermor', 'Blindé', 200, 'vertical', 'blinde',
    { diameterMm: 570, heightMm: 1255, coteAMm: 265, bracketVMm: 800 },
    ['021220', '021227']),
  installed('Thermor', 'Stéatite', 200, 'vertical', 'steatite',
    { diameterMm: 570, heightMm: 1255, coteAMm: 265, bracketVMm: 800 },
    ['053010', '156220', '156213']),
  installed('Thermor', 'ACI / Duralis', 200, 'vertical', 'aci',
    { diameterMm: 570, heightMm: 1255, coteAMm: 265, bracketVMm: 800 },
    ['156220', '156213']),

  // ---- Intégration
  installed('Thermor', 'Malicio 40 L', 40, 'integration', null,
    { widthMm: 490, heightMm: 765, bracketHMm: 440, bracketVMm: 500, coteAMm: 610 },
    ['157205']),
  installed('Ariston', '45 L', 45, 'integration', null,
    { widthMm: 506, heightMm: 776, bracketHMm: 306, bracketVMm: 405, coteAMm: 608 },
    ['157205']),
  installed('De Dietrich', 'CESL C 50 L', 50, 'integration', null,
    { widthMm: 470, heightMm: 860, bracketHMm: 355, bracketVMm: 470, coteAMm: 653 },
    ['157205']),
  installed('Thermor', 'Malicio 65 L', 65, 'integration', null,
    { widthMm: 490, heightMm: 1090, bracketHMm: 440, bracketVMm: 700, coteAMm: 975 },
    ['157207']),
  installed('Ariston', '65 L', 65, 'integration', null,
    { widthMm: 506, heightMm: 1066, bracketHMm: 306, bracketVMm: 695, coteAMm: 893 },
    ['157207']),
  installed('Altech', '65 L', 65, 'integration', null,
    { widthMm: 530, heightMm: 925, bracketHMm: 360, bracketVMm: 482 },
    ['157207']),
  installed('Thermor', 'Malicio 80 L', 80, 'integration', null,
    { widthMm: 490, heightMm: 1300, bracketHMm: 440, bracketVMm: 800, coteAMm: 1185 },
    ['157209']),
  installed('Ariston', '80 L', 80, 'integration', null,
    { widthMm: 506, heightMm: 1251, bracketHMm: 306, bracketVMm: 880, coteAMm: 1083 },
    ['157209']),
  installed('Altech', '80 L', 80, 'integration', null,
    { widthMm: 530, heightMm: 1070, bracketHMm: 360, bracketVMm: 622 },
    ['157209']),
  installed('De Dietrich', 'CESL C 80 L', 80, 'integration', null,
    { widthMm: 570, heightMm: 900, bracketHMm: 415, bracketVMm: 365, coteAMm: 630 },
    ['157209']),
  installed('Thermor', 'Malicio 100 L', 100, 'integration', null,
    { widthMm: 550, heightMm: 1240, bracketHMm: 440, bracketVMm: 800, coteAMm: 1122 },
    ['157216']),
  installed('De Dietrich', 'CESL C 100 L', 100, 'integration', null,
    { widthMm: 570, heightMm: 1090, bracketHMm: 415, bracketVMm: 550, coteAMm: 265 },
    ['157216']),
];

/* ------------------------------------------------------------------ */
/* Lookup                                                              */
/* ------------------------------------------------------------------ */

const key = (v: string | null | undefined) =>
  (v ?? '').toLowerCase().replace(/[\s.\-/+]/g, '');

export const bySku = (sku: string): Heater | null =>
  CATALOGUE.find((h) => h.sku === sku) ?? null;

export interface Candidates {
  /** Installed rows that fit what the nameplate says. */
  matched: Heater[];
  /** The replacements they point to, de-duplicated. */
  replacements: Heater[];
  /**
   * What a human still has to settle. Empty only when exactly one replacement
   * came out — and even then the bracket spacing is worth a glance.
   */
  undecided: string[];
}

/** Which family a shell belongs to, from its diameter. */
function profileOf(h: Heater): 'standard' | 'compact' | 'flat' | 'unknown' {
  if (h.orientation === 'integration') return 'flat';
  if (h.diameterMm === null) return 'unknown';
  return h.diameterMm >= 550 ? 'compact' : 'standard';
}

export interface NameplateFacts {
  brand?: string | null;
  model?: string | null;
  capacityLiters?: number | null;
  tankLining?: string | null;
}

/**
 * What the overview photo settles that the label cannot.
 *
 * Shaped after `Installation` rather than importing it, so the table stays
 * usable from a script or a test with three fields typed by hand.
 */
export interface InstallationFacts {
  brand?: string | null;
  mounting?: 'wall_vertical' | 'wall_horizontal' | 'floor_standing' | 'under_sink' | 'unknown';
  shellProfile?: 'standard' | 'compact' | 'flat' | 'unknown';
  waterConnection?: 'below' | 'side' | 'front' | 'unknown';
}

/**
 * Narrows the catalogue from what the two photos gave us.
 *
 * The label does the coarse work — brand and capacity rule out most of the
 * table. It cannot do the fine work: the guide separates its rows by shell
 * diameter and bracket spacing, and no label prints either. That is the
 * overview photo's job, and it is why `installation` is a parameter rather than
 * a nicety: posture and proportion are what split a Ø 513 standard from a
 * Ø 570 compact of the same 150 litres, which take different brackets.
 *
 * Whatever comes back is a shortlist. Even a single hit leaves the entraxe to
 * a tape measure.
 */
export function findCandidates(
  nameplate: NameplateFacts,
  installation?: InstallationFacts | null,
): Candidates {
  // The casing carries the brand when the label only carries a logo, so the
  // photo wins over the empty field rather than merely filling in for it.
  const brand = key(installation?.brand) || key(nameplate.brand);
  const litres = nameplate.capacityLiters ?? null;

  const orientation =
    installation?.mounting === 'wall_vertical'
      ? 'vertical'
      : installation?.mounting === 'wall_horizontal'
        ? 'horizontal'
        : installation?.shellProfile === 'flat'
          ? 'integration'
          : null;

  // 'unknown' is a real answer from the model — the appliance was cut off, or
  // the angle was too oblique to judge a proportion — and it must not filter.
  const profile =
    installation?.shellProfile && installation.shellProfile !== 'unknown'
      ? installation.shellProfile
      : null;
  const connection =
    installation?.waterConnection === 'below' || installation?.waterConnection === 'side'
      ? installation.waterConnection
      : null;

  const matched = INSTALLED.filter((h) => {
    if (litres !== null && h.capacityLiters !== litres) return false;
    // An unread brand widens the net rather than emptying it: capacity alone
    // still rules out most of the catalogue.
    if (brand && key(h.brand) !== brand) return false;
    if (orientation && h.orientation !== orientation) return false;
    // Standard against compact is a vertical distinction; on a horizontal tank
    // the model is judging a length against a diameter, which is another axis.
    if (profile && h.orientation === 'vertical' && profileOf(h) !== profile) return false;
    if (connection && h.connection !== null && h.connection !== connection) return false;
    return true;
  });

  const skus = new Set<string>();
  for (const h of matched) for (const s of h.compatibleWith) skus.add(s);
  let replacements = [...skus].map(bySku).filter((h): h is Heater => h !== null);

  // The guide points a row at several references — blindé, stéatite, ACI — and
  // the label says which of the three is in the wall.
  const lining = key(nameplate.tankLining);
  const wantsAci = lining.includes('aci') || key(nameplate.model).includes('aci');
  if (wantsAci) {
    const aci = replacements.filter((h) => h.tech === 'aci');
    if (aci.length > 0) replacements = aci;
  }

  const undecided: string[] = [];
  if (litres === null) undecided.push('capacité non lue sur la plaque');
  if (!brand) undecided.push('marque non lue');
  if (!orientation) undecided.push('vertical ou horizontal à confirmer');
  if (!profile && new Set(matched.map(profileOf)).size > 1) {
    undecided.push('diamètre à mesurer');
  }
  if (replacements.length > 1) undecided.push('entraxe à mesurer');

  return { matched, replacements, undecided };
}
