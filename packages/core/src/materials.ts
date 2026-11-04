import type { ManufacturingProcess } from './types/mech';

/**
 * Engineering materials library. Values are typical datasheet values at 23 °C for common
 * commercial grades (dry-as-molded for polyamides). Units:
 *   density kg/m³ · E, yield, UTS in MPa · elongation % · k W/(m·K) · cp J/(kg·K) · CTE 1/K · temps °C
 */
export interface Material {
  id: string;
  name: string;
  family: 'thermoplastic' | 'elastomer' | 'thermoset' | 'metal' | 'composite' | 'gas' | 'ceramic';
  /** Representative grade, for traceability. */
  grade?: string;
  density: number;
  E: number;
  nu: number;
  yieldStrength: number;
  tensileStrength: number;
  elongation: number;
  thermalConductivity: number;
  /** Optional anisotropic conductivity (e.g. FR4). */
  kInPlane?: number;
  kThroughPlane?: number;
  specificHeat: number;
  cte: number;
  maxServiceTemp: number;
  /** Heat deflection temperature at 1.8 MPa (plastics). */
  hdt?: number;
  emissivity: number;
  /** Dynamic viscosity (Pa·s) for fluids. */
  viscosity?: number;
  processes: ManufacturingProcess[];
  color: string;
  /** Approximate raw material cost (USD/kg). */
  costPerKg?: number;
  molding?: {
    /** Linear mold shrinkage (%). */
    shrinkage: number;
    minWall: number;
    nominalWall: number;
    maxWall: number;
    /** Minimum draft for a polished (SPI-A/B) surface (deg). Add ~1° per 0.025 mm texture depth. */
    minDraft: number;
    meltTemp: number;
    moldTemp: number;
    /** Max rib thickness as a fraction of nominal wall (sink-mark limit). */
    ribRatio: number;
    /** Approximate max flow length / wall thickness ratio. */
    flowRatio: number;
  };
  sheet?: {
    /** Minimum inside bend radius as a multiple of thickness. */
    minBendRadiusFactor: number;
    kFactor: number;
    /** Commonly stocked thicknesses (mm). */
    gauges: number[];
  };
}

export const MATERIALS: Material[] = [
  /* ---------------------------------------- Thermoplastics --------------------------------------- */
  {
    id: 'abs',
    name: 'ABS',
    family: 'thermoplastic',
    grade: 'General purpose injection grade (e.g. Chi Mei PA-757)',
    density: 1050,
    E: 2300,
    nu: 0.35,
    yieldStrength: 43,
    tensileStrength: 43,
    elongation: 20,
    thermalConductivity: 0.17,
    specificHeat: 1400,
    cte: 85e-6,
    maxServiceTemp: 80,
    hdt: 88,
    emissivity: 0.9,
    processes: ['injection-molding', 'fdm-printing', 'cnc-machining'],
    color: '#2b2d31',
    costPerKg: 2.5,
    molding: { shrinkage: 0.5, minWall: 1.0, nominalWall: 2.0, maxWall: 3.5, minDraft: 0.5, meltTemp: 230, moldTemp: 60, ribRatio: 0.6, flowRatio: 190 },
  },
  {
    id: 'pc',
    name: 'Polycarbonate (PC)',
    family: 'thermoplastic',
    grade: 'Makrolon 2405 class',
    density: 1200,
    E: 2400,
    nu: 0.37,
    yieldStrength: 65,
    tensileStrength: 65,
    elongation: 110,
    thermalConductivity: 0.2,
    specificHeat: 1200,
    cte: 65e-6,
    maxServiceTemp: 115,
    hdt: 128,
    emissivity: 0.9,
    processes: ['injection-molding', 'cnc-machining', 'fdm-printing'],
    color: '#d7dde3',
    costPerKg: 3.5,
    molding: { shrinkage: 0.6, minWall: 1.0, nominalWall: 2.5, maxWall: 4.0, minDraft: 1.0, meltTemp: 290, moldTemp: 90, ribRatio: 0.6, flowRatio: 120 },
  },
  {
    id: 'pc-abs',
    name: 'PC/ABS',
    family: 'thermoplastic',
    grade: 'Bayblend T85 class',
    density: 1140,
    E: 2300,
    nu: 0.36,
    yieldStrength: 53,
    tensileStrength: 50,
    elongation: 50,
    thermalConductivity: 0.18,
    specificHeat: 1300,
    cte: 75e-6,
    maxServiceTemp: 100,
    hdt: 105,
    emissivity: 0.9,
    processes: ['injection-molding'],
    color: '#33363b',
    costPerKg: 3.2,
    molding: { shrinkage: 0.6, minWall: 1.0, nominalWall: 2.2, maxWall: 3.8, minDraft: 0.75, meltTemp: 260, moldTemp: 70, ribRatio: 0.6, flowRatio: 150 },
  },
  {
    id: 'asa',
    name: 'ASA (UV-stable)',
    family: 'thermoplastic',
    grade: 'Luran S 777K class',
    density: 1070,
    E: 2200,
    nu: 0.35,
    yieldStrength: 45,
    tensileStrength: 45,
    elongation: 25,
    thermalConductivity: 0.17,
    specificHeat: 1300,
    cte: 90e-6,
    maxServiceTemp: 85,
    hdt: 95,
    emissivity: 0.9,
    processes: ['injection-molding', 'fdm-printing'],
    color: '#e9e6df',
    costPerKg: 3.0,
    molding: { shrinkage: 0.5, minWall: 1.0, nominalWall: 2.0, maxWall: 3.5, minDraft: 0.5, meltTemp: 250, moldTemp: 60, ribRatio: 0.6, flowRatio: 180 },
  },
  {
    id: 'pa66-gf30',
    name: 'PA66-GF30 (Nylon 66, 30% glass)',
    family: 'composite',
    grade: 'Zytel 70G30 class, dry as molded',
    density: 1370,
    E: 9500,
    nu: 0.35,
    yieldStrength: 185,
    tensileStrength: 185,
    elongation: 3,
    thermalConductivity: 0.3,
    specificHeat: 1500,
    cte: 25e-6,
    maxServiceTemp: 150,
    hdt: 250,
    emissivity: 0.9,
    processes: ['injection-molding'],
    color: '#1d1f22',
    costPerKg: 3.8,
    molding: { shrinkage: 0.6, minWall: 0.8, nominalWall: 2.0, maxWall: 4.0, minDraft: 0.5, meltTemp: 290, moldTemp: 85, ribRatio: 0.5, flowRatio: 150 },
  },
  {
    id: 'pbt-gf30',
    name: 'PBT-GF30',
    family: 'composite',
    grade: 'Ultradur B4300 G6 class',
    density: 1530,
    E: 10000,
    nu: 0.36,
    yieldStrength: 140,
    tensileStrength: 140,
    elongation: 2.5,
    thermalConductivity: 0.29,
    specificHeat: 1200,
    cte: 25e-6,
    maxServiceTemp: 140,
    hdt: 205,
    emissivity: 0.9,
    processes: ['injection-molding'],
    color: '#202225',
    costPerKg: 4.0,
    molding: { shrinkage: 0.5, minWall: 0.8, nominalWall: 2.0, maxWall: 3.5, minDraft: 0.5, meltTemp: 255, moldTemp: 80, ribRatio: 0.5, flowRatio: 150 },
  },
  {
    id: 'pp',
    name: 'Polypropylene (PP)',
    family: 'thermoplastic',
    grade: 'Homopolymer, MFI 12',
    density: 905,
    E: 1500,
    nu: 0.42,
    yieldStrength: 33,
    tensileStrength: 33,
    elongation: 150,
    thermalConductivity: 0.22,
    specificHeat: 1900,
    cte: 120e-6,
    maxServiceTemp: 100,
    hdt: 60,
    emissivity: 0.9,
    processes: ['injection-molding'],
    color: '#f2f0ea',
    costPerKg: 1.6,
    molding: { shrinkage: 1.6, minWall: 0.8, nominalWall: 1.8, maxWall: 3.8, minDraft: 1.0, meltTemp: 230, moldTemp: 40, ribRatio: 0.6, flowRatio: 250 },
  },
  {
    id: 'pom',
    name: 'Acetal (POM-C)',
    family: 'thermoplastic',
    grade: 'Hostaform C9021 class',
    density: 1410,
    E: 2850,
    nu: 0.37,
    yieldStrength: 65,
    tensileStrength: 65,
    elongation: 30,
    thermalConductivity: 0.31,
    specificHeat: 1470,
    cte: 110e-6,
    maxServiceTemp: 100,
    hdt: 104,
    emissivity: 0.9,
    processes: ['injection-molding', 'cnc-machining'],
    color: '#f5f5f0',
    costPerKg: 3.0,
    molding: { shrinkage: 2.0, minWall: 0.8, nominalWall: 2.0, maxWall: 3.0, minDraft: 0.5, meltTemp: 205, moldTemp: 90, ribRatio: 0.5, flowRatio: 150 },
  },
  {
    id: 'tpu-90a',
    name: 'TPU 90A (overmold, gaskets)',
    family: 'elastomer',
    density: 1200,
    E: 25,
    nu: 0.48,
    yieldStrength: 15,
    tensileStrength: 35,
    elongation: 500,
    thermalConductivity: 0.19,
    specificHeat: 1800,
    cte: 150e-6,
    maxServiceTemp: 80,
    emissivity: 0.9,
    processes: ['injection-molding', 'fdm-printing'],
    color: '#3a3d42',
    costPerKg: 6,
    molding: { shrinkage: 1.2, minWall: 0.8, nominalWall: 2.0, maxWall: 4.0, minDraft: 1.5, meltTemp: 210, moldTemp: 35, ribRatio: 0.6, flowRatio: 120 },
  },
  {
    id: 'nylon-66',
    name: 'Nylon 66 (unfilled)',
    family: 'thermoplastic',
    density: 1140,
    E: 3000,
    nu: 0.39,
    yieldStrength: 82,
    tensileStrength: 82,
    elongation: 30,
    thermalConductivity: 0.25,
    specificHeat: 1670,
    cte: 80e-6,
    maxServiceTemp: 120,
    hdt: 75,
    emissivity: 0.9,
    processes: ['injection-molding', 'cnc-machining'],
    color: '#f3efe2',
    costPerKg: 3.2,
    molding: { shrinkage: 1.5, minWall: 0.8, nominalWall: 2.0, maxWall: 3.0, minDraft: 0.5, meltTemp: 285, moldTemp: 80, ribRatio: 0.5, flowRatio: 200 },
  },
  {
    id: 'pla',
    name: 'PLA (FDM)',
    family: 'thermoplastic',
    density: 1240,
    E: 3500,
    nu: 0.36,
    yieldStrength: 60,
    tensileStrength: 60,
    elongation: 6,
    thermalConductivity: 0.13,
    specificHeat: 1800,
    cte: 68e-6,
    maxServiceTemp: 50,
    hdt: 55,
    emissivity: 0.9,
    processes: ['fdm-printing'],
    color: '#5b8def',
    costPerKg: 20,
  },
  {
    id: 'petg',
    name: 'PETG (FDM)',
    family: 'thermoplastic',
    density: 1270,
    E: 2100,
    nu: 0.38,
    yieldStrength: 50,
    tensileStrength: 50,
    elongation: 20,
    thermalConductivity: 0.2,
    specificHeat: 1300,
    cte: 70e-6,
    maxServiceTemp: 70,
    hdt: 70,
    emissivity: 0.9,
    processes: ['fdm-printing'],
    color: '#3f7f7a',
    costPerKg: 22,
  },
  {
    id: 'pa12-sls',
    name: 'PA12 (SLS)',
    family: 'thermoplastic',
    grade: 'PA 2200 class',
    density: 930,
    E: 1700,
    nu: 0.39,
    yieldStrength: 48,
    tensileStrength: 48,
    elongation: 15,
    thermalConductivity: 0.22,
    specificHeat: 1700,
    cte: 110e-6,
    maxServiceTemp: 110,
    hdt: 86,
    emissivity: 0.9,
    processes: ['sls-printing'],
    color: '#e8e4dc',
    costPerKg: 60,
  },
  {
    id: 'resin-tough',
    name: 'Tough resin (SLA)',
    family: 'thermoset',
    density: 1150,
    E: 2200,
    nu: 0.38,
    yieldStrength: 46,
    tensileStrength: 46,
    elongation: 48,
    thermalConductivity: 0.2,
    specificHeat: 1500,
    cte: 90e-6,
    maxServiceTemp: 50,
    hdt: 53,
    emissivity: 0.9,
    processes: ['sla-printing'],
    color: '#9aa3ad',
    costPerKg: 150,
  },
  /* ------------------------------------------- Metals -------------------------------------------- */
  {
    id: 'al-5052-h32',
    name: 'Aluminium 5052-H32',
    family: 'metal',
    density: 2680,
    E: 70300,
    nu: 0.33,
    yieldStrength: 193,
    tensileStrength: 228,
    elongation: 12,
    thermalConductivity: 138,
    specificHeat: 880,
    cte: 23.8e-6,
    maxServiceTemp: 150,
    emissivity: 0.1,
    processes: ['sheet-metal', 'cnc-machining'],
    color: '#c9ced6',
    costPerKg: 4.5,
    sheet: { minBendRadiusFactor: 1.0, kFactor: 0.43, gauges: [0.5, 0.8, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0] },
  },
  {
    id: 'al-6061-t6',
    name: 'Aluminium 6061-T6',
    family: 'metal',
    density: 2700,
    E: 68900,
    nu: 0.33,
    yieldStrength: 276,
    tensileStrength: 310,
    elongation: 12,
    thermalConductivity: 167,
    specificHeat: 896,
    cte: 23.6e-6,
    maxServiceTemp: 150,
    emissivity: 0.1,
    processes: ['cnc-machining', 'extrusion', 'sheet-metal'],
    color: '#c3c9d1',
    costPerKg: 5,
    sheet: { minBendRadiusFactor: 2.0, kFactor: 0.45, gauges: [0.8, 1.0, 1.6, 2.0, 3.0] },
  },
  {
    id: 'spcc',
    name: 'Cold-rolled steel SPCC (≈1008)',
    family: 'metal',
    density: 7850,
    E: 205000,
    nu: 0.29,
    yieldStrength: 210,
    tensileStrength: 330,
    elongation: 35,
    thermalConductivity: 53,
    specificHeat: 481,
    cte: 12.2e-6,
    maxServiceTemp: 400,
    emissivity: 0.3,
    processes: ['sheet-metal'],
    color: '#8d949c',
    costPerKg: 1.2,
    sheet: { minBendRadiusFactor: 0.5, kFactor: 0.44, gauges: [0.5, 0.8, 1.0, 1.2, 1.5, 2.0, 3.0] },
  },
  {
    id: 'sgcc',
    name: 'Galvanised steel SGCC',
    family: 'metal',
    density: 7850,
    E: 205000,
    nu: 0.29,
    yieldStrength: 205,
    tensileStrength: 340,
    elongation: 30,
    thermalConductivity: 52,
    specificHeat: 481,
    cte: 12.2e-6,
    maxServiceTemp: 200,
    emissivity: 0.25,
    processes: ['sheet-metal'],
    color: '#a7adb3',
    costPerKg: 1.4,
    sheet: { minBendRadiusFactor: 0.5, kFactor: 0.44, gauges: [0.5, 0.8, 1.0, 1.2, 1.5, 2.0] },
  },
  {
    id: 'ss-304',
    name: 'Stainless steel 304 (annealed)',
    family: 'metal',
    density: 8000,
    E: 193000,
    nu: 0.29,
    yieldStrength: 215,
    tensileStrength: 505,
    elongation: 40,
    thermalConductivity: 16.2,
    specificHeat: 500,
    cte: 17.3e-6,
    maxServiceTemp: 400,
    emissivity: 0.3,
    processes: ['sheet-metal', 'cnc-machining'],
    color: '#b8bcc2',
    costPerKg: 4.0,
    sheet: { minBendRadiusFactor: 0.5, kFactor: 0.45, gauges: [0.5, 0.8, 1.0, 1.2, 1.5, 2.0] },
  },
  {
    id: 'a380',
    name: 'Aluminium A380 (die cast)',
    family: 'metal',
    density: 2710,
    E: 71000,
    nu: 0.33,
    yieldStrength: 160,
    tensileStrength: 324,
    elongation: 3.5,
    thermalConductivity: 96,
    specificHeat: 963,
    cte: 21.8e-6,
    maxServiceTemp: 200,
    emissivity: 0.2,
    processes: ['die-casting'],
    color: '#aeb4bb',
    costPerKg: 3.0,
  },
  {
    id: 'zamak3',
    name: 'Zinc alloy Zamak 3 (die cast)',
    family: 'metal',
    density: 6600,
    E: 96000,
    nu: 0.27,
    yieldStrength: 208,
    tensileStrength: 283,
    elongation: 10,
    thermalConductivity: 113,
    specificHeat: 419,
    cte: 27.4e-6,
    maxServiceTemp: 100,
    emissivity: 0.25,
    processes: ['die-casting'],
    color: '#9fa6ad',
    costPerKg: 3.2,
  },
  {
    id: 'brass',
    name: 'Brass CW614N (free-cutting)',
    family: 'metal',
    density: 8500,
    E: 97000,
    nu: 0.31,
    yieldStrength: 310,
    tensileStrength: 385,
    elongation: 15,
    thermalConductivity: 115,
    specificHeat: 380,
    cte: 20.5e-6,
    maxServiceTemp: 200,
    emissivity: 0.1,
    processes: ['cnc-machining', 'purchased'],
    color: '#c9a13b',
    costPerKg: 7,
  },
  {
    id: 'copper',
    name: 'Copper C110 (H02)',
    family: 'metal',
    density: 8890,
    E: 117000,
    nu: 0.34,
    yieldStrength: 250,
    tensileStrength: 290,
    elongation: 15,
    thermalConductivity: 388,
    specificHeat: 385,
    cte: 17e-6,
    maxServiceTemp: 200,
    emissivity: 0.05,
    processes: ['sheet-metal', 'cnc-machining', 'purchased'],
    color: '#c87533',
    costPerKg: 10,
    sheet: { minBendRadiusFactor: 0.5, kFactor: 0.42, gauges: [0.2, 0.3, 0.5, 0.8, 1.0, 1.5, 2.0] },
  },
  {
    id: 'steel-zinc',
    name: 'Carbon steel class 8.8, zinc plated',
    family: 'metal',
    density: 7850,
    E: 205000,
    nu: 0.29,
    yieldStrength: 640,
    tensileStrength: 800,
    elongation: 12,
    thermalConductivity: 45,
    specificHeat: 470,
    cte: 11.5e-6,
    maxServiceTemp: 300,
    emissivity: 0.25,
    processes: ['purchased'],
    color: '#9ea4aa',
  },
  {
    id: 'ss-a2',
    name: 'Stainless A2-70 (fasteners)',
    family: 'metal',
    density: 7900,
    E: 193000,
    nu: 0.29,
    yieldStrength: 450,
    tensileStrength: 700,
    elongation: 30,
    thermalConductivity: 16,
    specificHeat: 500,
    cte: 17.3e-6,
    maxServiceTemp: 400,
    emissivity: 0.3,
    processes: ['purchased'],
    color: '#c2c6cc',
  },
  /* -------------------------------------- PCB / electronics -------------------------------------- */
  {
    id: 'fr4',
    name: 'FR-4 (Tg 140)',
    family: 'composite',
    density: 1850,
    E: 24000,
    nu: 0.136,
    yieldStrength: 250,
    tensileStrength: 310,
    elongation: 2,
    thermalConductivity: 0.3,
    kInPlane: 0.8,
    kThroughPlane: 0.3,
    specificHeat: 1150,
    cte: 14e-6,
    maxServiceTemp: 130,
    emissivity: 0.9,
    processes: ['purchased'],
    color: '#1f6b3a',
  },
  {
    id: 'epoxy-mold',
    name: 'Epoxy mold compound (IC bodies)',
    family: 'thermoset',
    density: 1900,
    E: 24000,
    nu: 0.3,
    yieldStrength: 120,
    tensileStrength: 120,
    elongation: 1,
    thermalConductivity: 0.7,
    specificHeat: 900,
    cte: 12e-6,
    maxServiceTemp: 150,
    emissivity: 0.9,
    processes: ['purchased'],
    color: '#161616',
  },
  {
    id: 'solder-sac305',
    name: 'Solder SAC305',
    family: 'metal',
    density: 7400,
    E: 51000,
    nu: 0.36,
    yieldStrength: 32,
    tensileStrength: 45,
    elongation: 30,
    thermalConductivity: 58,
    specificHeat: 230,
    cte: 21e-6,
    maxServiceTemp: 150,
    emissivity: 0.1,
    processes: ['purchased'],
    color: '#bfc3c7',
  },
  {
    id: 'silicone-thermal-pad',
    name: 'Silicone thermal pad (3 W/mK)',
    family: 'elastomer',
    density: 3000,
    E: 1,
    nu: 0.49,
    yieldStrength: 0.5,
    tensileStrength: 0.5,
    elongation: 100,
    thermalConductivity: 3,
    specificHeat: 1000,
    cte: 200e-6,
    maxServiceTemp: 200,
    emissivity: 0.9,
    processes: ['purchased'],
    color: '#6a8fbf',
  },
  {
    id: 'air',
    name: 'Air (1 atm, 30 °C)',
    family: 'gas',
    density: 1.16,
    E: 0,
    nu: 0,
    yieldStrength: 0,
    tensileStrength: 0,
    elongation: 0,
    thermalConductivity: 0.0263,
    specificHeat: 1007,
    cte: 3.3e-3,
    maxServiceTemp: 1000,
    emissivity: 0,
    viscosity: 1.86e-5,
    processes: [],
    color: '#ffffff',
  },
];

const BY_ID = new Map(MATERIALS.map((m) => [m.id, m]));

export function getMaterial(id: string): Material | undefined {
  return BY_ID.get(id);
}

export function requireMaterial(id: string): Material {
  const m = BY_ID.get(id);
  if (!m) throw new Error(`Unknown material '${id}'. Known: ${MATERIALS.map((x) => x.id).join(', ')}`);
  return m;
}

export interface ProcessInfo {
  id: ManufacturingProcess;
  name: string;
  description: string;
  /** Typical general tolerance (± mm). */
  tolerance: number;
  /** Typical tooling / NRE notes. */
  tooling: string;
  /** Suitable production volume. */
  volume: string;
}

export const PROCESSES: ProcessInfo[] = [
  { id: 'injection-molding', name: 'Injection molding', description: 'Steel/aluminium tool, thermoplastic resin injected under pressure. Requires draft, uniform walls, no undercuts without slides.', tolerance: 0.1, tooling: 'Mold tool $3k–$30k+', volume: '1k – millions' },
  { id: 'sheet-metal', name: 'Sheet metal (laser + press brake)', description: 'Laser/punch cut flat pattern then bent. Constant thickness, bend radius and hole-to-bend rules apply.', tolerance: 0.2, tooling: 'Little/no tooling', volume: '1 – 100k' },
  { id: 'cnc-machining', name: 'CNC machining', description: 'Subtractive machining from stock. Nominal wrought properties.', tolerance: 0.05, tooling: 'Fixtures only', volume: '1 – 1k' },
  { id: 'fdm-printing', name: 'FDM 3D printing', description: 'Extruded layers; anisotropic (weak between layers).', tolerance: 0.3, tooling: 'None', volume: '1 – 100' },
  { id: 'sla-printing', name: 'SLA 3D printing', description: 'Photopolymer resin; near isotropic, lower heat resistance.', tolerance: 0.1, tooling: 'None', volume: '1 – 500' },
  { id: 'sls-printing', name: 'SLS 3D printing', description: 'Sintered nylon powder; good isotropy, slightly porous.', tolerance: 0.25, tooling: 'None', volume: '1 – 5k' },
  { id: 'die-casting', name: 'Die casting', description: 'High-pressure metal casting; porosity lowers strength and ductility.', tolerance: 0.1, tooling: 'Die $10k–$100k', volume: '5k – millions' },
  { id: 'extrusion', name: 'Extrusion', description: 'Constant cross-section profile cut to length.', tolerance: 0.15, tooling: 'Die $1k–$5k', volume: '100 – millions' },
  { id: 'purchased', name: 'Purchased', description: 'Off-the-shelf item from a distributor.', tolerance: 0, tooling: 'None', volume: 'any' },
];

export interface EffectiveMaterial {
  materialId: string;
  name: string;
  process: ManufacturingProcess;
  density: number;
  E: number;
  nu: number;
  yieldStrength: number;
  tensileStrength: number;
  elongation: number;
  thermalConductivity: number;
  specificHeat: number;
  cte: number;
  maxServiceTemp: number;
  emissivity: number;
  /** Strength across weld/knit lines (molding) or between layers (printing), MPa. */
  weakPlaneStrength: number;
  /** Human-readable list of adjustments applied for the process. */
  adjustments: string[];
}

const FINISH_EMISSIVITY: Record<string, number> = {
  anodized: 0.8,
  'anodized-black': 0.88,
  'anodized-clear': 0.77,
  'powder-coat': 0.9,
  painted: 0.9,
  'zinc-plated': 0.25,
  'nickel-plated': 0.12,
  bare: -1,
  brushed: -1,
};

/**
 * Material properties as manufactured. The base library values are for isotropic, fully dense
 * test specimens; manufacturing processes change them (fibre orientation, knit lines, layer
 * adhesion, porosity, surface finish). All simulations must use this function.
 */
export function effectiveMaterial(
  materialId: string,
  process: ManufacturingProcess,
  options: Record<string, string | number | boolean> = {},
): EffectiveMaterial {
  const m = requireMaterial(materialId);
  const adj: string[] = [];
  let E = m.E;
  let ys = m.yieldStrength;
  let uts = m.tensileStrength;
  let elong = m.elongation;
  let density = m.density;
  let k = m.thermalConductivity;
  let weak = m.yieldStrength;
  let emissivity = m.emissivity;
  const glassFilled = /gf\d+/i.test(m.id);

  switch (process) {
    case 'injection-molding': {
      if (glassFilled) {
        E *= 0.75;
        ys *= 0.8;
        uts *= 0.8;
        weak = m.tensileStrength * 0.55;
        adj.push('Glass-fibre orientation averaging: E ×0.75, strength ×0.8 (cross-flow regions)');
        adj.push('Knit-line strength ×0.55 for glass-filled resin');
      } else {
        weak = ys * 0.85;
        adj.push('Knit-line strength ×0.85 for unfilled resin');
      }
      const texture = String(options.texture ?? '');
      if (texture) adj.push(`Surface texture ${texture} (affects draft requirement only)`);
      break;
    }
    case 'fdm-printing': {
      const infill = clamp(Number(options.infill ?? 1), 0.1, 1);
      const f = 0.5 + 0.5 * infill;
      E *= 0.8 * f;
      ys *= 0.7 * f;
      uts *= 0.7 * f;
      elong *= 0.5;
      weak = m.tensileStrength * 0.45 * f;
      density *= 0.35 + 0.65 * infill;
      k *= 0.6 + 0.4 * infill;
      adj.push(`FDM (infill ${(infill * 100).toFixed(0)}%): in-plane E ×${(0.8 * f).toFixed(2)}, strength ×${(0.7 * f).toFixed(2)}`);
      adj.push(`Inter-layer (Z) strength ${(0.45 * f).toFixed(2)}× bulk`);
      break;
    }
    case 'sla-printing':
      E *= 0.95;
      ys *= 0.95;
      uts *= 0.95;
      weak = ys * 0.9;
      adj.push('SLA post-cured: E and strength ×0.95');
      break;
    case 'sls-printing':
      weak = ys * 0.9;
      density *= 0.97;
      adj.push('SLS: Z strength ×0.9, ~3% porosity');
      break;
    case 'die-casting':
      ys *= 0.9;
      uts *= 0.9;
      elong *= 0.6;
      weak = ys * 0.8;
      adj.push('Die-cast porosity: strength ×0.9, elongation ×0.6');
      break;
    case 'sheet-metal':
      weak = ys;
      adj.push('Sheet temper as specified; bend-zone work hardening ignored (conservative)');
      break;
    case 'cnc-machining':
    case 'extrusion':
    case 'purchased':
      weak = ys;
      break;
  }

  const finish = options.finish != null ? String(options.finish) : '';
  if (finish && FINISH_EMISSIVITY[finish] !== undefined && FINISH_EMISSIVITY[finish] >= 0) {
    emissivity = FINISH_EMISSIVITY[finish];
    adj.push(`Finish '${finish}': emissivity ${emissivity}`);
  }

  return {
    materialId: m.id,
    name: m.name,
    process,
    density,
    E,
    nu: m.nu,
    yieldStrength: ys,
    tensileStrength: uts,
    elongation: elong,
    thermalConductivity: k,
    specificHeat: m.specificHeat,
    cte: m.cte,
    maxServiceTemp: m.hdt != null ? Math.min(m.maxServiceTemp, m.hdt) : m.maxServiceTemp,
    emissivity,
    weakPlaneStrength: weak,
    adjustments: adj,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
}
