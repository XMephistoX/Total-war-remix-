// Campaign rules: cultures, rosters, buildings and the economy formulas. Pure data and math.

import { UNITS } from '../sim/data';

export type Culture =
  | 'roman' | 'punic' | 'celtic' | 'germanic' | 'iberian' | 'greek' | 'hellenistic'
  | 'thracian' | 'nomad' | 'eastern' | 'numidian' | 'mixed';

export type Chain = 'farms' | 'market' | 'port' | 'roads' | 'temple' | 'barracks' | 'stables' | 'walls';

export interface ChainDef {
  id: Chain;
  names: string[];
  cost: number[];
  turns: number[];
  icon: string;
  help: string;
}

export const CHAINS: ChainDef[] = [
  { id: 'farms', names: ['Farms', 'Irrigation', 'Great Estates'], cost: [400, 1000, 2200], turns: [1, 2, 3], icon: '🌾', help: 'More food: faster growth and farm income.' },
  { id: 'market', names: ['Market', 'Forum', 'Great Forum'], cost: [500, 1200, 2600], turns: [1, 2, 3], icon: '⚖', help: 'More trade income.' },
  { id: 'port', names: ['Port', 'Harbour', 'Great Harbour'], cost: [500, 1300, 2600], turns: [1, 2, 3], icon: '⚓', help: 'Sea trade. Armies can sail from here to other ports.' },
  { id: 'roads', names: ['Roads', 'Paved Roads'], cost: [400, 1100], turns: [1, 2], icon: '🛤', help: 'Trade and faster marching in the province.' },
  { id: 'temple', names: ['Shrine', 'Temple', 'Great Temple'], cost: [400, 1100, 2500], turns: [1, 2, 3], icon: '🏛', help: 'Public order and a little growth.' },
  { id: 'barracks', names: ['Muster Field', 'Barracks', 'Army Barracks'], cost: [300, 900, 2200], turns: [1, 2, 3], icon: '⚔', help: 'Recruit better infantry and missile troops.' },
  { id: 'stables', names: ['Stables', 'Cavalry Stables', 'Royal Stables'], cost: [400, 1100, 2400], turns: [1, 2, 3], icon: '🐎', help: 'Recruit cavalry.' },
  { id: 'walls', names: ['Palisade', 'Stone Walls', 'Great Walls'], cost: [400, 1200, 2600], turns: [1, 2, 3], icon: '🧱', help: 'Defenders fight much harder when attacked.' },
];
export const CHAIN = Object.fromEntries(CHAINS.map((c) => [c.id, c])) as Record<Chain, ChainDef>;

export const LEVEL_NAMES = ['Village', 'Town', 'Large Town', 'City', 'Large City', 'Huge City'];
const LEVEL_POP = [0, 2000, 6000, 12000, 24000, 40000];

export function settlementLevel(pop: number): number {
  let l = 0;
  for (let i = 0; i < LEVEL_POP.length; i++) if (pop >= LEVEL_POP[i]) l = i;
  return l;
}

/** Highest building level allowed by settlement size (building level 3 needs a city). */
export function maxBuildLevel(pop: number): number {
  return Math.min(3, settlementLevel(pop));
}

export interface RecruitDef {
  unit: string;
  chain: 'barracks' | 'stables';
  level: number;
  only?: string[]; // settlement ids (e.g. Spartans only at Sparta)
  marian?: 'before' | 'after';
}

const r = (unit: string, chain: 'barracks' | 'stables', level: number, extra: Partial<RecruitDef> = {}): RecruitDef => ({ unit, chain, level, ...extra });

export const ROSTERS: Record<Culture, RecruitDef[]> = {
  roman: [
    r('velites', 'barracks', 1, { marian: 'before' }), r('hastati', 'barracks', 1, { marian: 'before' }),
    r('principes', 'barracks', 2, { marian: 'before' }), r('triarii', 'barracks', 2, { marian: 'before' }),
    r('aux_infantry', 'barracks', 1, { marian: 'after' }), r('aux_archers', 'barracks', 1, { marian: 'after' }),
    r('legionaries', 'barracks', 2, { marian: 'after' }), r('first_cohort', 'barracks', 3, { marian: 'after' }),
    r('equites', 'stables', 1, { marian: 'before' }), r('legion_cav', 'stables', 1, { marian: 'after' }),
    r('rome_general', 'stables', 2),
  ],
  celtic: [r('warband', 'barracks', 1), r('gaul_slingers', 'barracks', 1), r('gaul_spear', 'barracks', 1), r('gaul_cavalry', 'stables', 1), r('gaul_chieftain', 'stables', 2)],
  germanic: [r('germ_spear', 'barracks', 1), r('germ_skirm', 'barracks', 1), r('germ_warband', 'barracks', 1), r('germ_cav', 'stables', 1), r('germ_general', 'stables', 2)],
  iberian: [r('caetrati', 'barracks', 1), r('iber_spear', 'barracks', 1), r('scutarii', 'barracks', 2), r('balearic_slingers', 'barracks', 2), r('iber_cav', 'stables', 1), r('iber_general', 'stables', 2)],
  punic: [r('libyan_spear', 'barracks', 1), r('balearic_slingers', 'barracks', 1), r('sacred_band', 'barracks', 3), r('numidian_cav', 'stables', 1), r('cart_cav', 'stables', 2), r('cart_general', 'stables', 2)],
  greek: [r('hoplites', 'barracks', 1), r('peltasts', 'barracks', 1), r('cretan_archers', 'barracks', 2), r('spartans', 'barracks', 2, { only: ['sparta'] }), r('greek_cav', 'stables', 1), r('greek_general', 'stables', 2)],
  hellenistic: [r('phalangites', 'barracks', 1), r('thureophoroi', 'barracks', 1), r('hell_archers', 'barracks', 1), r('peltasts', 'barracks', 1), r('hypaspists', 'barracks', 3), r('greek_cav', 'stables', 1), r('companions', 'stables', 2), r('hell_general', 'stables', 2)],
  thracian: [r('thrac_warband', 'barracks', 1), r('thrac_peltasts', 'barracks', 1), r('falxmen', 'barracks', 2), r('thrac_cav', 'stables', 1), r('thrac_general', 'stables', 2)],
  nomad: [r('nomad_spear', 'barracks', 1), r('nomad_archers', 'barracks', 1), r('horse_archers', 'stables', 1), r('nomad_nobles', 'stables', 2), r('nomad_general', 'stables', 2)],
  eastern: [r('east_spear', 'barracks', 1), r('east_archers', 'barracks', 1), r('east_phalanx', 'barracks', 2), r('east_cav', 'stables', 1), r('cataphracts', 'stables', 3), r('east_general', 'stables', 2)],
  numidian: [r('numid_javelins', 'barracks', 1), r('numid_infantry', 'barracks', 1), r('numidian_cav', 'stables', 1), r('numid_general', 'stables', 2)],
  mixed: [],
};

/** Extra units for single factions. */
export const FACTION_EXTRAS: Record<string, RecruitDef[]> = {
  britons: [r('brit_chariots', 'stables', 1)],
};

/** Native culture of independent settlements (otherwise the starting owner's culture). */
export const NATIVE: Record<string, Culture> = {
  tingis: 'numidian', volubilis: 'numidian', iol: 'numidian', siwa: 'numidian', messana: 'greek',
  patavium: 'celtic', genua: 'celtic', segusio: 'celtic', octodurus: 'celtic', deva: 'celtic', eblana: 'celtic',
  boiohaemum: 'celtic', vindobona: 'celtic', manching: 'celtic', tylis: 'celtic', ankyra: 'celtic', singidunum: 'celtic',
  olisipo: 'iberian', bracara: 'iberian', asturica: 'iberian', pompaelo: 'iberian',
  thermon: 'greek', aigion: 'greek', gortyn: 'greek', lysimachia: 'greek', olbia: 'greek', pantikapaion: 'greek',
  phanagoria: 'greek', trapezus: 'greek', pergamon: 'greek',
  scodra: 'thracian', salona: 'thracian', segestica: 'thracian', dardania: 'thracian', nikomedeia: 'thracian',
  tyras: 'germanic', mazaka: 'eastern', phasis: 'eastern', mtskheta: 'eastern', petra: 'eastern',
};

/** Starting armies by culture (unit ids). The first unit leads the army. */
export const START_ARMY: Record<Culture, string[]> = {
  roman: ['rome_general', 'hastati', 'hastati', 'hastati', 'principes', 'principes', 'triarii', 'velites', 'velites', 'equites'],
  celtic: ['gaul_chieftain', 'warband', 'warband', 'warband', 'warband', 'gaul_spear', 'gaul_slingers', 'gaul_cavalry'],
  germanic: ['germ_general', 'germ_warband', 'germ_warband', 'germ_spear', 'germ_spear', 'germ_skirm', 'germ_cav'],
  iberian: ['iber_general', 'scutarii', 'scutarii', 'iber_spear', 'caetrati', 'caetrati', 'iber_cav'],
  punic: ['cart_general', 'libyan_spear', 'libyan_spear', 'libyan_spear', 'balearic_slingers', 'numidian_cav', 'numidian_cav', 'cart_cav'],
  greek: ['greek_general', 'hoplites', 'hoplites', 'hoplites', 'hoplites', 'peltasts', 'cretan_archers', 'greek_cav'],
  hellenistic: ['hell_general', 'phalangites', 'phalangites', 'phalangites', 'thureophoroi', 'peltasts', 'hell_archers', 'companions', 'greek_cav'],
  thracian: ['thrac_general', 'thrac_warband', 'thrac_warband', 'falxmen', 'thrac_peltasts', 'thrac_peltasts', 'thrac_cav'],
  nomad: ['nomad_general', 'horse_archers', 'horse_archers', 'horse_archers', 'nomad_nobles', 'nomad_spear', 'nomad_archers'],
  eastern: ['east_general', 'east_spear', 'east_spear', 'east_phalanx', 'east_archers', 'east_archers', 'east_cav', 'cataphracts'],
  numidian: ['numid_general', 'numidian_cav', 'numidian_cav', 'numidian_cav', 'numid_infantry', 'numid_javelins', 'numid_javelins'],
  mixed: [],
};

/** Garrison by culture for towns that start without an army. */
export const GARRISON: Record<Culture, string[]> = {
  roman: ['hastati', 'velites'], celtic: ['warband', 'gaul_spear'], germanic: ['germ_spear', 'germ_warband'],
  iberian: ['iber_spear', 'caetrati'], punic: ['libyan_spear', 'balearic_slingers'], greek: ['hoplites', 'peltasts'],
  hellenistic: ['phalangites', 'peltasts'], thracian: ['thrac_warband', 'thrac_peltasts'], nomad: ['nomad_spear', 'nomad_archers'],
  eastern: ['east_spear', 'east_archers'], numidian: ['numid_infantry', 'numid_javelins'], mixed: ['hoplites'],
};

export type Tax = 0 | 1 | 2 | 3;
export const TAX_NAMES = ['Low', 'Normal', 'High', 'Very high'];
const TAX_MULT = [0.6, 1, 1.4, 1.8];
const TAX_ORDER = [10, 0, -15, -30];
const TAX_GROWTH = [0.003, 0, -0.004, -0.008];

export const MAX_UNITS = 20;
export const MOVE_FOOT = 70;
export const MOVE_HORSE = 95;
export const SEA_RANGE = 330;

export function upkeep(unit: string): number {
  return Math.round((UNITS[unit]?.cost ?? 300) * 0.2);
}

export function recruitCost(unit: string): number {
  return UNITS[unit]?.cost ?? 300;
}

export interface EconomyInputs {
  pop: number;
  tax: Tax;
  buildings: Partial<Record<Chain, number>>;
  capital: boolean;
  distToCapital: number; // map pixels
  garrisonMen: number;
  foreign: boolean; // native culture differs from the owner's
  unrest: number; // recent conquest, decays
}

export interface EconomyReport {
  tax: number;
  trade: number;
  farms: number;
  corruption: number;
  income: number;
  growth: number; // fraction per turn
  order: number; // percent
  orderParts: [string, number][];
}

export function economy(e: EconomyInputs): EconomyReport {
  const b = e.buildings;
  const tax = e.pop * 0.035 * TAX_MULT[e.tax];
  const trade = e.pop * 0.012 * (1 + 0.25 * (b.market ?? 0) + 0.15 * (b.roads ?? 0)) + (b.port ?? 0) * (120 + e.pop * 0.008);
  const farms = (b.farms ?? 0) * e.pop * 0.008;
  const gross = tax + trade + farms;
  const corruption = e.capital ? 0.02 : Math.min(0.6, 0.04 + e.distToCapital / 1400);
  const parts: [string, number][] = [
    ['Base', 80],
    ['Taxes', TAX_ORDER[e.tax]],
    ['Temples', (b.temple ?? 0) * 12],
    ['Garrison', Math.min(30, Math.round(e.garrisonMen / 40))],
    ['Squalor', -Math.round(e.pop / 1500)],
    ['Distance', e.capital ? 15 : -Math.round(e.distToCapital / 12)],
  ];
  if (e.foreign) parts.push(['Foreign rule', -15]);
  if (e.unrest > 0) parts.push(['Recently conquered', -Math.round(e.unrest)]);
  const order = Math.max(0, Math.min(150, parts.reduce((a, p) => a + p[1], 0)));
  let growth = 0.004 + (b.farms ?? 0) * 0.004 + (b.temple ?? 0) * 0.001 + TAX_GROWTH[e.tax] - e.pop / 8e6;
  if (order < 70) growth = Math.min(growth, 0);
  growth = Math.max(-0.01, Math.min(0.03, growth));
  const riot = order < 70 ? 0.5 : 1;
  const income = Math.round(gross * (1 - corruption) * riot);
  return { tax: Math.round(tax), trade: Math.round(trade), farms: Math.round(farms), corruption, income, growth, order, orderParts: parts };
}

/** Rough fighting value of a unit for auto-resolve and the AI. */
export function unitStrength(unit: string, men: number): number {
  const d = UNITS[unit];
  if (!d) return men * 10;
  const melee = d.attack + d.defense + d.armor + d.shield * 0.6 + d.charge * 0.35;
  const missile = d.missile ? d.missile.damage * 0.5 * Math.min(1, d.missile.ammo / 10) : 0;
  const per = (melee + missile) * (0.6 + d.morale / 150) * d.hp * (d.mounted ? 1.5 : 1);
  return men * per;
}
