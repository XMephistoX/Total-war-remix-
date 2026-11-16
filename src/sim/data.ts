// Data-driven unit and faction definitions. New factions and units are added here,
// not in the simulation code.

export type UnitClass = 'infantry' | 'spear' | 'missile' | 'cavalry' | 'general';
export type Discipline = 'impetuous' | 'normal' | 'disciplined';
export type Visual = 'sword' | 'spear' | 'archer' | 'skirmisher' | 'cavalry' | 'general';

export interface MissileStats {
  kind: 'arrow' | 'javelin' | 'stone';
  range: number; // meters
  damage: number;
  ammo: number;
  reload: number; // seconds between shots
  speed: number; // horizontal speed, m/s
}

export interface UnitDef {
  id: string;
  name: string;
  cls: UnitClass;
  visual: Visual;
  /** Converted 3D model (public/units/<model>.*); falls back to the placeholder visual. */
  model?: string;
  men: number; // soldiers at "Large" unit size
  ranks: number;
  spacing: number; // side-to-side distance between soldiers
  rankSpacing: number; // front-to-back distance between ranks
  radius: number; // body radius for collisions
  mounted: boolean;
  walk: number; // m/s
  run: number; // m/s
  attack: number;
  charge: number;
  defense: number; // melee skill
  armor: number;
  shield: number; // only counts against attacks from the front (half from the side)
  hp: number;
  morale: number; // base morale, 0-100
  discipline: Discipline;
  stamina: number; // multiplier on fatigue drain (lower is hardier)
  bonusVsCav?: number;
  reach: number; // melee reach beyond body radius
  missile?: MissileStats;
  cost: number;
  /** Which battle line this unit deploys in when armies are laid out automatically (1 = front). */
  line?: number;
}

export interface FactionDef {
  id: string;
  name: string;
  culture: string;
  primary: number; // tunic / main color
  secondary: number; // shield color
  trim: number;
}

export const FACTIONS: Record<string, FactionDef> = {
  rome: { id: 'rome', name: 'Rome', culture: 'roman', primary: 0xa3221c, secondary: 0xc8302a, trim: 0xd8b04a },
  gauls: { id: 'gauls', name: 'Gauls', culture: 'celtic', primary: 0x2c5ca0, secondary: 0x3c5f9e, trim: 0xc9c2a8 },
};

const foot = { mounted: false, radius: 0.42, spacing: 1.25, rankSpacing: 1.4 };
const horse = { mounted: true, radius: 0.9, spacing: 2.3, rankSpacing: 3.2 };

export const UNITS: Record<string, UnitDef> = {
  // ---------------- Rome (pre-Marian, camillan/polybian style) ----------------
  rome_general: {
    id: 'rome_general', name: "General's Bodyguard", cls: 'general', visual: 'general', model: 'rome_general', men: 32, ranks: 2, ...horse,
    walk: 3.2, run: 9.5, attack: 9, charge: 11, defense: 6, armor: 7, shield: 4, hp: 2, morale: 82,
    discipline: 'disciplined', stamina: 0.8, reach: 1.3, cost: 900,
  },
  hastati: {
    id: 'hastati', name: 'Hastati', cls: 'infantry', visual: 'sword', model: 'rome_hastati', men: 160, ranks: 6, ...foot,
    walk: 1.9, run: 4.4, attack: 7, charge: 4, defense: 5, armor: 5, shield: 4, hp: 1, morale: 60,
    discipline: 'disciplined', stamina: 1, reach: 0.8, cost: 400,
  },
  principes: {
    id: 'principes', name: 'Principes', cls: 'infantry', visual: 'sword', model: 'rome_principes', men: 160, ranks: 6, ...foot, line: 2,
    walk: 1.9, run: 4.3, attack: 8, charge: 4, defense: 6, armor: 7, shield: 4, hp: 1, morale: 66,
    discipline: 'disciplined', stamina: 1, reach: 0.8, cost: 550,
  },
  triarii: {
    id: 'triarii', name: 'Triarii', cls: 'spear', visual: 'spear', model: 'rome_triarii', men: 80, ranks: 4, ...foot, line: 3,
    walk: 1.8, run: 4.0, attack: 6, charge: 3, defense: 9, armor: 7, shield: 4, hp: 1, morale: 76,
    discipline: 'disciplined', stamina: 1.1, bonusVsCav: 8, reach: 1.7, cost: 500,
  },
  velites: {
    id: 'velites', name: 'Velites', cls: 'missile', visual: 'skirmisher', model: 'rome_velites', men: 80, ranks: 2, ...foot, spacing: 1.6,
    walk: 2.1, run: 5.0, attack: 3, charge: 2, defense: 2, armor: 1, shield: 2, hp: 1, morale: 40,
    discipline: 'normal', stamina: 0.9, reach: 0.7, cost: 220,
    missile: { kind: 'javelin', range: 50, damage: 11, ammo: 6, reload: 4.5, speed: 22 },
  },
  equites: {
    id: 'equites', name: 'Equites', cls: 'cavalry', visual: 'cavalry', model: 'rome_equites', men: 54, ranks: 3, ...horse,
    walk: 3.2, run: 9.0, attack: 6, charge: 8, defense: 4, armor: 4, shield: 3, hp: 1, morale: 55,
    discipline: 'normal', stamina: 0.9, reach: 1.2, cost: 450,
  },

  // ---------------- Gauls ----------------
  gaul_chieftain: {
    id: 'gaul_chieftain', name: "Chieftain's Warriors", cls: 'general', visual: 'general', model: 'gaul_chieftain', men: 32, ranks: 2, ...horse,
    walk: 3.2, run: 9.8, attack: 9, charge: 12, defense: 5, armor: 5, shield: 4, hp: 2, morale: 80,
    discipline: 'normal', stamina: 0.8, reach: 1.3, cost: 900,
  },
  warband: {
    id: 'warband', name: 'Warband', cls: 'infantry', visual: 'sword', model: 'gaul_warband', men: 200, ranks: 6, ...foot,
    walk: 2.0, run: 4.8, attack: 9, charge: 7, defense: 3, armor: 1, shield: 2, hp: 1, morale: 62,
    discipline: 'impetuous', stamina: 0.9, reach: 0.8, cost: 280,
  },
  gaul_spear: {
    id: 'gaul_spear', name: 'Spear Warriors', cls: 'spear', visual: 'spear', model: 'gaul_spear', men: 160, ranks: 6, ...foot, line: 2,
    walk: 1.9, run: 4.5, attack: 6, charge: 4, defense: 6, armor: 3, shield: 3, hp: 1, morale: 56,
    discipline: 'normal', stamina: 1, bonusVsCav: 6, reach: 1.7, cost: 300,
  },
  gaul_slingers: {
    id: 'gaul_slingers', name: 'Slingers', cls: 'missile', visual: 'archer', model: 'gaul_slinger', men: 80, ranks: 2, ...foot, spacing: 1.5,
    walk: 2.0, run: 4.8, attack: 3, charge: 1, defense: 2, armor: 1, shield: 0, hp: 1, morale: 38,
    discipline: 'normal', stamina: 1, reach: 0.7, cost: 220,
    missile: { kind: 'stone', range: 120, damage: 7, ammo: 30, reload: 5.5, speed: 40 },
  },
  gaul_cavalry: {
    id: 'gaul_cavalry', name: 'Noble Horse', cls: 'cavalry', visual: 'cavalry', model: 'gaul_cavalry', men: 54, ranks: 3, ...horse,
    walk: 3.3, run: 9.6, attack: 7, charge: 9, defense: 3, armor: 3, shield: 3, hp: 1, morale: 54,
    discipline: 'normal', stamina: 0.9, reach: 1.2, cost: 450,
  },

  // ---------------- Other cultures (campaign) ----------------
  ...world(),
};

type Stats = Pick<UnitDef, 'attack' | 'charge' | 'defense' | 'armor' | 'shield' | 'morale' | 'cost'> & Partial<UnitDef>;

/** Units for the cultures that only appear in the campaign. Models are added as they get converted. */
function world(): Record<string, UnitDef> {
  const out: Record<string, UnitDef> = {};
  const add = (id: string, name: string, base: Omit<UnitDef, 'id' | 'name' | keyof Stats> & Partial<UnitDef>, st: Stats) => {
    out[id] = { ...base, ...st, id, name } as UnitDef;
  };
  const gen = { cls: 'general' as const, visual: 'general' as const, men: 32, ranks: 2, ...horse, walk: 3.2, run: 9.5, hp: 2, discipline: 'disciplined' as const, stamina: 0.8, reach: 1.3 };
  const cav = { cls: 'cavalry' as const, visual: 'cavalry' as const, men: 54, ranks: 3, ...horse, walk: 3.2, run: 9.2, hp: 1, discipline: 'normal' as const, stamina: 0.9, reach: 1.2 };
  const lcav = { ...cav, run: 10.2, walk: 3.4 };
  const sword = { cls: 'infantry' as const, visual: 'sword' as const, men: 160, ranks: 6, ...foot, walk: 1.9, run: 4.5, hp: 1, discipline: 'normal' as const, stamina: 1, reach: 0.8 };
  const spear = { cls: 'spear' as const, visual: 'spear' as const, men: 160, ranks: 6, ...foot, walk: 1.8, run: 4.2, hp: 1, discipline: 'normal' as const, stamina: 1.05, reach: 1.7, bonusVsCav: 6 };
  const pike = { ...spear, ranks: 8, walk: 1.6, run: 3.4, reach: 3.2, bonusVsCav: 10, stamina: 1.15 };
  const skirm = { cls: 'missile' as const, visual: 'skirmisher' as const, men: 80, ranks: 2, ...foot, spacing: 1.6, walk: 2.1, run: 5.0, hp: 1, discipline: 'normal' as const, stamina: 0.9, reach: 0.7 };
  const archer = { ...skirm, visual: 'archer' as const, spacing: 1.5 };
  const jav = (range = 50, damage = 11) => ({ missile: { kind: 'javelin' as const, range, damage, ammo: 6, reload: 4.5, speed: 22 } });
  const bow = (range = 150, damage = 7) => ({ missile: { kind: 'arrow' as const, range, damage, ammo: 30, reload: 5, speed: 48 } });
  const sling = { missile: { kind: 'stone' as const, range: 120, damage: 7, ammo: 30, reload: 5.5, speed: 40 } };

  // Carthage
  add('cart_general', 'Sacred Band Cavalry', gen, { attack: 9, charge: 11, defense: 6, armor: 7, shield: 4, morale: 82, cost: 900 });
  add('libyan_spear', 'Libyan Spearmen', spear, { attack: 6, charge: 3, defense: 7, armor: 5, shield: 4, morale: 60, cost: 380, discipline: 'disciplined' });
  add('sacred_band', 'Sacred Band', { ...spear, men: 120, discipline: 'disciplined', line: 2 }, { attack: 9, charge: 5, defense: 9, armor: 8, shield: 4, morale: 80, cost: 800 });
  add('balearic_slingers', 'Balearic Slingers', { ...archer, ...sling }, { attack: 3, charge: 1, defense: 2, armor: 1, shield: 0, morale: 40, cost: 260 });
  add('numidian_cav', 'Numidian Cavalry', { ...lcav, ...jav(55, 9), cls: 'cavalry' }, { attack: 4, charge: 5, defense: 3, armor: 1, shield: 2, morale: 48, cost: 330 });
  add('cart_cav', 'Punic Cavalry', cav, { attack: 6, charge: 8, defense: 4, armor: 4, shield: 3, morale: 55, cost: 450 });
  // Iberians
  add('iber_general', 'Iberian Chieftain', gen, { attack: 8, charge: 11, defense: 5, armor: 5, shield: 4, morale: 78, cost: 850 });
  add('scutarii', 'Scutarii', { ...sword, ...jav(35, 8) }, { attack: 7, charge: 5, defense: 5, armor: 3, shield: 4, morale: 58, cost: 360 });
  add('caetrati', 'Caetrati', { ...skirm, ...jav() }, { attack: 4, charge: 2, defense: 3, armor: 1, shield: 2, morale: 44, cost: 220 });
  add('iber_spear', 'Iberian Spearmen', spear, { attack: 5, charge: 3, defense: 6, armor: 2, shield: 3, morale: 50, cost: 260 });
  add('iber_cav', 'Iberian Cavalry', { ...lcav, ...jav(45, 9) }, { attack: 5, charge: 6, defense: 3, armor: 2, shield: 3, morale: 52, cost: 380 });
  // Greeks
  add('greek_general', "Strategos' Guard", gen, { attack: 8, charge: 10, defense: 6, armor: 7, shield: 3, morale: 80, cost: 850 });
  add('hoplites', 'Hoplites', { ...spear, discipline: 'disciplined', ranks: 8 }, { attack: 6, charge: 4, defense: 8, armor: 6, shield: 5, morale: 64, cost: 420 });
  add('spartans', 'Spartan Hoplites', { ...spear, men: 120, ranks: 8, discipline: 'disciplined' }, { attack: 9, charge: 5, defense: 10, armor: 7, shield: 5, morale: 86, cost: 900 });
  add('peltasts', 'Peltasts', { ...skirm, ...jav() }, { attack: 4, charge: 2, defense: 3, armor: 1, shield: 2, morale: 44, cost: 230 });
  add('cretan_archers', 'Cretan Archers', { ...archer, ...bow(170, 8) }, { attack: 3, charge: 1, defense: 2, armor: 2, shield: 0, morale: 46, cost: 320 });
  add('greek_cav', 'Greek Cavalry', cav, { attack: 6, charge: 7, defense: 4, armor: 4, shield: 0, morale: 54, cost: 420 });
  // Hellenistic kingdoms
  add('hell_general', 'Royal Bodyguard', gen, { attack: 9, charge: 12, defense: 6, armor: 7, shield: 2, morale: 84, cost: 950 });
  add('phalangites', 'Phalangites', { ...pike, discipline: 'disciplined' }, { attack: 6, charge: 3, defense: 7, armor: 4, shield: 3, morale: 62, cost: 400 });
  add('hypaspists', 'Hypaspists', { ...spear, men: 120, discipline: 'disciplined', line: 2 }, { attack: 8, charge: 4, defense: 8, armor: 6, shield: 4, morale: 74, cost: 620 });
  add('thureophoroi', 'Thureophoroi', { ...spear, ...jav(35, 8) }, { attack: 6, charge: 4, defense: 6, armor: 4, shield: 4, morale: 56, cost: 340 });
  add('hell_archers', 'Archers', { ...archer, ...bow() }, { attack: 3, charge: 1, defense: 2, armor: 1, shield: 0, morale: 40, cost: 250 });
  add('companions', 'Companion Cavalry', cav, { attack: 8, charge: 11, defense: 5, armor: 6, shield: 0, morale: 72, cost: 700 });
  // Thracians and Dacians
  add('thrac_general', 'Thracian Nobles', gen, { attack: 8, charge: 11, defense: 5, armor: 5, shield: 3, morale: 78, cost: 850 });
  add('falxmen', 'Falxmen', { ...sword, men: 120, discipline: 'impetuous', reach: 1.1 }, { attack: 12, charge: 6, defense: 2, armor: 2, shield: 0, morale: 66, cost: 520 });
  add('thrac_peltasts', 'Thracian Peltasts', { ...skirm, ...jav() }, { attack: 5, charge: 3, defense: 3, armor: 1, shield: 2, morale: 46, cost: 240 });
  add('thrac_warband', 'Warband', { ...sword, discipline: 'impetuous', men: 200 }, { attack: 8, charge: 6, defense: 3, armor: 1, shield: 2, morale: 56, cost: 260 });
  add('thrac_cav', 'Thracian Cavalry', { ...lcav, ...jav(45, 9) }, { attack: 6, charge: 7, defense: 3, armor: 2, shield: 2, morale: 52, cost: 400 });
  // Steppe
  add('nomad_general', 'Noble Horse Archers', { ...gen, ...bow(140, 8) }, { attack: 7, charge: 8, defense: 5, armor: 5, shield: 0, morale: 78, cost: 900 });
  add('horse_archers', 'Horse Archers', { ...lcav, ...bow(140, 7) }, { attack: 3, charge: 3, defense: 3, armor: 1, shield: 0, morale: 50, cost: 380 });
  add('nomad_nobles', 'Noble Cavalry', cav, { attack: 7, charge: 9, defense: 5, armor: 5, shield: 2, morale: 64, cost: 560 });
  add('nomad_archers', 'Foot Archers', { ...archer, ...bow(150, 7) }, { attack: 3, charge: 1, defense: 2, armor: 1, shield: 0, morale: 38, cost: 220 });
  add('nomad_spear', 'Steppe Spearmen', spear, { attack: 5, charge: 3, defense: 5, armor: 2, shield: 2, morale: 44, cost: 220 });
  // Pontus and Armenia
  add('east_general', 'Royal Guard', gen, { attack: 8, charge: 11, defense: 6, armor: 8, shield: 2, morale: 80, cost: 950 });
  add('east_spear', 'Hillmen Spearmen', spear, { attack: 5, charge: 3, defense: 6, armor: 3, shield: 3, morale: 48, cost: 250 });
  add('east_archers', 'Eastern Archers', { ...archer, ...bow() }, { attack: 3, charge: 1, defense: 2, armor: 1, shield: 0, morale: 40, cost: 230 });
  add('cataphracts', 'Cataphracts', { ...cav, walk: 2.8, run: 7.6, stamina: 1.2 }, { attack: 8, charge: 12, defense: 6, armor: 10, shield: 0, morale: 70, cost: 900 });
  add('east_cav', 'Light Cavalry', { ...lcav, ...jav(45, 9) }, { attack: 5, charge: 6, defense: 3, armor: 2, shield: 2, morale: 50, cost: 360 });
  add('east_phalanx', 'Bronze Shields', { ...pike, discipline: 'disciplined' }, { attack: 6, charge: 3, defense: 7, armor: 5, shield: 3, morale: 60, cost: 420 });
  // Numidia
  add('numid_general', 'Numidian Prince', { ...gen, ...jav(50, 10) }, { attack: 7, charge: 9, defense: 5, armor: 4, shield: 3, morale: 78, cost: 850 });
  add('numid_javelins', 'Desert Javelinmen', { ...skirm, ...jav() }, { attack: 4, charge: 2, defense: 3, armor: 1, shield: 2, morale: 42, cost: 200 });
  add('numid_infantry', 'Numidian Infantry', { ...sword, ...jav(30, 8) }, { attack: 6, charge: 4, defense: 4, armor: 2, shield: 3, morale: 50, cost: 280 });
  // Germans
  add('germ_general', "Chieftain's Retinue", gen, { attack: 9, charge: 12, defense: 5, armor: 4, shield: 4, morale: 80, cost: 850 });
  add('germ_spear', 'Spear Levy', { ...spear, men: 200 }, { attack: 5, charge: 3, defense: 5, armor: 1, shield: 3, morale: 48, cost: 200 });
  add('germ_warband', 'Germanic Warband', { ...sword, men: 200, discipline: 'impetuous' }, { attack: 9, charge: 7, defense: 3, armor: 1, shield: 2, morale: 60, cost: 270 });
  add('germ_skirm', 'Skirmishers', { ...skirm, ...jav() }, { attack: 4, charge: 2, defense: 2, armor: 0, shield: 2, morale: 40, cost: 180 });
  add('germ_cav', 'Germanic Horse', cav, { attack: 7, charge: 9, defense: 3, armor: 2, shield: 3, morale: 56, cost: 420 });
  // Rome after the Marian reforms
  add('legionaries', 'Legionary Cohort', { ...sword, model: 'rome_principes', ...jav(30, 9) }, { attack: 9, charge: 5, defense: 7, armor: 7, shield: 5, morale: 72, cost: 600, discipline: 'disciplined' });
  add('first_cohort', 'First Cohort', { ...sword, men: 200, model: 'rome_principes', line: 2, ...jav(30, 9) }, { attack: 10, charge: 5, defense: 8, armor: 8, shield: 5, morale: 84, cost: 900, discipline: 'disciplined' });
  add('aux_infantry', 'Auxilia', { ...spear, model: 'rome_triarii', bonusVsCav: 4 }, { attack: 6, charge: 3, defense: 6, armor: 4, shield: 4, morale: 56, cost: 320 });
  add('aux_archers', 'Archer Auxilia', { ...archer, ...bow() }, { attack: 3, charge: 1, defense: 3, armor: 2, shield: 0, morale: 46, cost: 280 });
  add('legion_cav', 'Legionary Cavalry', { ...cav, model: 'rome_equites' }, { attack: 7, charge: 9, defense: 5, armor: 5, shield: 3, morale: 64, cost: 520 });
  // Britons
  add('brit_chariots', 'Chariots', { ...lcav, ...jav(45, 10), walk: 3.4, run: 9.0, men: 32, ranks: 2 }, { attack: 6, charge: 10, defense: 3, armor: 2, shield: 0, morale: 56, cost: 520 });
  return out;
}

export interface ArmySlot {
  unit: string;
  dx: number; // lateral offset from army center (meters, + = to the army's right)
  dz: number; // depth offset (meters, + = behind the front line)
}

// Starting deployments for the battle test. Offsets are relative to the army center,
// in the army's own frame (x to the right, z backwards).
export const ARMIES: Record<string, ArmySlot[]> = {
  rome: [
    { unit: 'velites', dx: -60, dz: -28 },
    { unit: 'velites', dx: 60, dz: -28 },
    { unit: 'hastati', dx: -66, dz: 0 },
    { unit: 'hastati', dx: -22, dz: 0 },
    { unit: 'hastati', dx: 22, dz: 0 },
    { unit: 'hastati', dx: 66, dz: 0 },
    { unit: 'principes', dx: -44, dz: 24 },
    { unit: 'principes', dx: 0, dz: 24 },
    { unit: 'principes', dx: 44, dz: 24 },
    { unit: 'triarii', dx: 0, dz: 46 },
    { unit: 'equites', dx: -125, dz: 6 },
    { unit: 'equites', dx: 125, dz: 6 },
    { unit: 'rome_general', dx: 0, dz: 75 },
  ],
  gauls: [
    { unit: 'gaul_slingers', dx: -55, dz: -26 },
    { unit: 'gaul_slingers', dx: 55, dz: -26 },
    { unit: 'warband', dx: -110, dz: 0 },
    { unit: 'warband', dx: -55, dz: 0 },
    { unit: 'warband', dx: 0, dz: 0 },
    { unit: 'warband', dx: 55, dz: 0 },
    { unit: 'warband', dx: 110, dz: 0 },
    { unit: 'gaul_spear', dx: -40, dz: 28 },
    { unit: 'gaul_spear', dx: 40, dz: 28 },
    { unit: 'gaul_cavalry', dx: -165, dz: 8 },
    { unit: 'gaul_cavalry', dx: 165, dz: 8 },
    { unit: 'gaul_chieftain', dx: 0, dz: 70 },
  ],
};

export type UnitSize = 'normal' | 'large' | 'huge';
export const UNIT_SIZE_SCALE: Record<UnitSize, number> = { normal: 0.5, large: 1, huge: 1.5 };
