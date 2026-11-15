// Data-driven unit and faction definitions. New factions and units are added here,
// not in the simulation code.

export type UnitClass = 'infantry' | 'spear' | 'missile' | 'cavalry' | 'general';
export type Discipline = 'impetuous' | 'normal' | 'disciplined';
export type Visual = 'sword' | 'spear' | 'archer' | 'skirmisher' | 'cavalry' | 'general';

export interface MissileStats {
  kind: 'arrow' | 'javelin';
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
  gauls: { id: 'gauls', name: 'Gauls', culture: 'celtic', primary: 0x2f6b3a, secondary: 0x3c5f9e, trim: 0xc9c2a8 },
};

const foot = { mounted: false, radius: 0.42, spacing: 1.25, rankSpacing: 1.4 };
const horse = { mounted: true, radius: 0.9, spacing: 2.3, rankSpacing: 3.2 };

export const UNITS: Record<string, UnitDef> = {
  // ---------------- Rome (pre-Marian, camillan/polybian style) ----------------
  rome_general: {
    id: 'rome_general', name: "General's Bodyguard", cls: 'general', visual: 'general', men: 32, ranks: 2, ...horse,
    walk: 3.2, run: 9.5, attack: 9, charge: 11, defense: 6, armor: 7, shield: 4, hp: 2, morale: 82,
    discipline: 'disciplined', stamina: 0.8, reach: 1.3, cost: 900,
  },
  hastati: {
    id: 'hastati', name: 'Hastati', cls: 'infantry', visual: 'sword', men: 160, ranks: 6, ...foot,
    walk: 1.9, run: 4.4, attack: 7, charge: 4, defense: 5, armor: 5, shield: 4, hp: 1, morale: 60,
    discipline: 'disciplined', stamina: 1, reach: 0.8, cost: 400,
  },
  principes: {
    id: 'principes', name: 'Principes', cls: 'infantry', visual: 'sword', men: 160, ranks: 6, ...foot,
    walk: 1.9, run: 4.3, attack: 8, charge: 4, defense: 6, armor: 7, shield: 4, hp: 1, morale: 66,
    discipline: 'disciplined', stamina: 1, reach: 0.8, cost: 550,
  },
  triarii: {
    id: 'triarii', name: 'Triarii', cls: 'spear', visual: 'spear', men: 80, ranks: 4, ...foot,
    walk: 1.8, run: 4.0, attack: 6, charge: 3, defense: 9, armor: 7, shield: 4, hp: 1, morale: 76,
    discipline: 'disciplined', stamina: 1.1, bonusVsCav: 8, reach: 1.7, cost: 500,
  },
  velites: {
    id: 'velites', name: 'Velites', cls: 'missile', visual: 'skirmisher', men: 80, ranks: 2, ...foot, spacing: 1.6,
    walk: 2.1, run: 5.0, attack: 3, charge: 2, defense: 2, armor: 1, shield: 2, hp: 1, morale: 40,
    discipline: 'normal', stamina: 0.9, reach: 0.7, cost: 220,
    missile: { kind: 'javelin', range: 50, damage: 11, ammo: 6, reload: 4.5, speed: 22 },
  },
  equites: {
    id: 'equites', name: 'Equites', cls: 'cavalry', visual: 'cavalry', men: 54, ranks: 3, ...horse,
    walk: 3.2, run: 9.0, attack: 6, charge: 8, defense: 4, armor: 4, shield: 3, hp: 1, morale: 55,
    discipline: 'normal', stamina: 0.9, reach: 1.2, cost: 450,
  },

  // ---------------- Gauls ----------------
  gaul_chieftain: {
    id: 'gaul_chieftain', name: "Chieftain's Warriors", cls: 'general', visual: 'general', men: 32, ranks: 2, ...horse,
    walk: 3.2, run: 9.8, attack: 9, charge: 12, defense: 5, armor: 5, shield: 4, hp: 2, morale: 80,
    discipline: 'normal', stamina: 0.8, reach: 1.3, cost: 900,
  },
  warband: {
    id: 'warband', name: 'Warband', cls: 'infantry', visual: 'sword', men: 200, ranks: 6, ...foot,
    walk: 2.0, run: 4.8, attack: 9, charge: 7, defense: 3, armor: 1, shield: 2, hp: 1, morale: 62,
    discipline: 'impetuous', stamina: 0.9, reach: 0.8, cost: 280,
  },
  gaul_spear: {
    id: 'gaul_spear', name: 'Spear Warriors', cls: 'spear', visual: 'spear', men: 160, ranks: 6, ...foot,
    walk: 1.9, run: 4.5, attack: 6, charge: 4, defense: 6, armor: 3, shield: 3, hp: 1, morale: 56,
    discipline: 'normal', stamina: 1, bonusVsCav: 6, reach: 1.7, cost: 300,
  },
  gaul_archers: {
    id: 'gaul_archers', name: 'Forester Archers', cls: 'missile', visual: 'archer', men: 80, ranks: 2, ...foot, spacing: 1.5,
    walk: 2.0, run: 4.6, attack: 3, charge: 1, defense: 2, armor: 1, shield: 0, hp: 1, morale: 38,
    discipline: 'normal', stamina: 1, reach: 0.7, cost: 250,
    missile: { kind: 'arrow', range: 150, damage: 7, ammo: 26, reload: 7, speed: 46 },
  },
  gaul_cavalry: {
    id: 'gaul_cavalry', name: 'Noble Horse', cls: 'cavalry', visual: 'cavalry', men: 54, ranks: 3, ...horse,
    walk: 3.3, run: 9.6, attack: 7, charge: 9, defense: 3, armor: 3, shield: 3, hp: 1, morale: 54,
    discipline: 'normal', stamina: 0.9, reach: 1.2, cost: 450,
  },
};

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
    { unit: 'gaul_archers', dx: -55, dz: -26 },
    { unit: 'gaul_archers', dx: 55, dz: -26 },
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
