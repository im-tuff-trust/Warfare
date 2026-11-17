// Ammunition definitions. Penetration values are flat-plate (0°) RHA millimetres,
// approximating published WWII-era data. Values between 100 m and 1000 m are interpolated.

export type AmmoKind = 'AP' | 'APHE' | 'APCR' | 'HE' | 'MG' | 'BOMB' | 'ROCKET';

export interface AmmoSpec {
  id: string;
  name: string;
  short: string;
  kind: AmmoKind;
  caliber: number; // mm
  velocity: number; // m/s muzzle velocity
  pen100: number; // mm @ 100 m, 0°
  pen1000: number; // mm @ 1000 m, 0°
  explosive: number; // kg TNT-equivalent filler
  damage: number; // structural damage on full penetration
  tracer: number; // hex color of tracer
  drag: number; // simple velocity loss per second (fraction)
}

const A = (a: AmmoSpec) => a;

export const AMMO: Record<string, AmmoSpec> = {
  // --- 20 mm KwK 38 (Panzer II Luchs)
  '20_pzgr': A({ id: '20_pzgr', name: 'Pzgr. (APHE)', short: 'APHE', kind: 'APHE', caliber: 20, velocity: 780, pen100: 33, pen1000: 16, explosive: 0.003, damage: 6, tracer: 0xff6a30, drag: 0.08 }),
  '20_pzgr40': A({ id: '20_pzgr40', name: 'Pzgr. 40 (APCR)', short: 'APCR', kind: 'APCR', caliber: 20, velocity: 1050, pen100: 49, pen1000: 18, explosive: 0, damage: 5, tracer: 0xffd040, drag: 0.1 }),
  '20_sprgr': A({ id: '20_sprgr', name: 'Sprgr. (HE)', short: 'HE', kind: 'HE', caliber: 20, velocity: 900, pen100: 4, pen1000: 4, explosive: 0.006, damage: 3, tracer: 0xff4020, drag: 0.08 }),
  // --- 37 mm M6 (M5 Stuart)
  '37_m51': A({ id: '37_m51', name: 'M51 APCBC', short: 'AP', kind: 'AP', caliber: 37, velocity: 884, pen100: 66, pen1000: 44, explosive: 0, damage: 14, tracer: 0xff5030, drag: 0.04 }),
  '37_m63': A({ id: '37_m63', name: 'M63 HE', short: 'HE', kind: 'HE', caliber: 37, velocity: 792, pen100: 6, pen1000: 6, explosive: 0.04, damage: 6, tracer: 0xff8030, drag: 0.05 }),
  // --- 45 mm 20-K (T-70)
  '45_br240': A({ id: '45_br240', name: 'BR-240 APHE', short: 'APHE', kind: 'APHE', caliber: 45, velocity: 760, pen100: 62, pen1000: 38, explosive: 0.018, damage: 18, tracer: 0xff4030, drag: 0.045 }),
  '45_br240p': A({ id: '45_br240p', name: 'BR-240P APCR', short: 'APCR', kind: 'APCR', caliber: 45, velocity: 985, pen100: 86, pen1000: 40, explosive: 0, damage: 12, tracer: 0xffd040, drag: 0.07 }),
  '45_o240': A({ id: '45_o240', name: 'O-240 HE', short: 'HE', kind: 'HE', caliber: 45, velocity: 335, pen100: 7, pen1000: 7, explosive: 0.12, damage: 9, tracer: 0xff7030, drag: 0.03 }),
  // --- 75 mm KwK 40 L/48 (Panzer IV H)
  '75_pzgr39': A({ id: '75_pzgr39', name: 'PzGr. 39 APCBC-HE', short: 'APHE', kind: 'APHE', caliber: 75, velocity: 790, pen100: 135, pen1000: 101, explosive: 0.018, damage: 32, tracer: 0xff4020, drag: 0.03 }),
  '75_pzgr40': A({ id: '75_pzgr40', name: 'PzGr. 40 APCR', short: 'APCR', kind: 'APCR', caliber: 75, velocity: 990, pen100: 171, pen1000: 88, explosive: 0, damage: 22, tracer: 0xffd040, drag: 0.06 }),
  '75_sprgr34': A({ id: '75_sprgr34', name: 'SprGr. 34 HE', short: 'HE', kind: 'HE', caliber: 75, velocity: 550, pen100: 10, pen1000: 10, explosive: 0.69, damage: 18, tracer: 0xff8030, drag: 0.025 }),
  // --- 76 mm F-34 / ZiS-5 (T-34, KV-1)
  '76_br350a': A({ id: '76_br350a', name: 'BR-350A APHE', short: 'APHE', kind: 'APHE', caliber: 76, velocity: 662, pen100: 87, pen1000: 66, explosive: 0.155, damage: 34, tracer: 0xff4020, drag: 0.03 }),
  '76_br350p': A({ id: '76_br350p', name: 'BR-350P APCR', short: 'APCR', kind: 'APCR', caliber: 76, velocity: 965, pen100: 111, pen1000: 55, explosive: 0, damage: 20, tracer: 0xffd040, drag: 0.06 }),
  '76_of350': A({ id: '76_of350', name: 'OF-350 HE-Frag', short: 'HE', kind: 'HE', caliber: 76, velocity: 680, pen100: 10, pen1000: 10, explosive: 0.71, damage: 18, tracer: 0xff8030, drag: 0.025 }),
  // --- 75 mm M3 (M4 Sherman)
  '75_m61': A({ id: '75_m61', name: 'M61 APCBC-HE', short: 'APHE', kind: 'APHE', caliber: 75, velocity: 619, pen100: 104, pen1000: 85, explosive: 0.065, damage: 30, tracer: 0xff4020, drag: 0.03 }),
  '75_m72': A({ id: '75_m72', name: 'M72 AP', short: 'AP', kind: 'AP', caliber: 75, velocity: 619, pen100: 108, pen1000: 80, explosive: 0, damage: 26, tracer: 0xff6030, drag: 0.03 }),
  '75_m48': A({ id: '75_m48', name: 'M48 HE', short: 'HE', kind: 'HE', caliber: 75, velocity: 463, pen100: 10, pen1000: 10, explosive: 0.67, damage: 18, tracer: 0xff8030, drag: 0.025 }),
  // --- 88 mm KwK 36 L/56 (Tiger I)
  '88_pzgr39': A({ id: '88_pzgr39', name: 'PzGr. 39 APCBC-HE', short: 'APHE', kind: 'APHE', caliber: 88, velocity: 773, pen100: 165, pen1000: 138, explosive: 0.06, damage: 42, tracer: 0xff4020, drag: 0.028 }),
  '88_pzgr40': A({ id: '88_pzgr40', name: 'PzGr. 40 APCR', short: 'APCR', kind: 'APCR', caliber: 88, velocity: 930, pen100: 210, pen1000: 135, explosive: 0, damage: 26, tracer: 0xffd040, drag: 0.055 }),
  '88_sprgr': A({ id: '88_sprgr', name: 'SprGr. HE', short: 'HE', kind: 'HE', caliber: 88, velocity: 820, pen100: 13, pen1000: 13, explosive: 0.9, damage: 22, tracer: 0xff8030, drag: 0.025 }),
  // --- 90 mm M3 (M26 Pershing)
  '90_m82': A({ id: '90_m82', name: 'M82 APCBC-HE', short: 'APHE', kind: 'APHE', caliber: 90, velocity: 808, pen100: 165, pen1000: 140, explosive: 0.064, damage: 42, tracer: 0xff4020, drag: 0.028 }),
  '90_m304': A({ id: '90_m304', name: 'M304 HVAP', short: 'APCR', kind: 'APCR', caliber: 90, velocity: 1021, pen100: 240, pen1000: 165, explosive: 0, damage: 28, tracer: 0xffd040, drag: 0.05 }),
  '90_m71': A({ id: '90_m71', name: 'M71 HE', short: 'HE', kind: 'HE', caliber: 90, velocity: 823, pen100: 13, pen1000: 13, explosive: 0.95, damage: 22, tracer: 0xff8030, drag: 0.025 }),

  // --- Aircraft guns
  'mg_792': A({ id: 'mg_792', name: '7.92 mm MG', short: 'MG', kind: 'MG', caliber: 7.92, velocity: 760, pen100: 9, pen1000: 3, explosive: 0, damage: 0.6, tracer: 0xffe080, drag: 0.15 }),
  'mg_127': A({ id: 'mg_127', name: '12.7 mm HMG', short: 'MG', kind: 'MG', caliber: 12.7, velocity: 860, pen100: 22, pen1000: 9, explosive: 0, damage: 1.2, tracer: 0xffe080, drag: 0.1 }),
  'mg_13': A({ id: 'mg_13', name: '13 mm MG 131', short: 'MG', kind: 'MG', caliber: 13, velocity: 750, pen100: 20, pen1000: 8, explosive: 0, damage: 1.2, tracer: 0xffe080, drag: 0.1 }),
  'cn_20': A({ id: 'cn_20', name: '20 mm cannon', short: 'CN', kind: 'MG', caliber: 20, velocity: 800, pen100: 24, pen1000: 12, explosive: 0.02, damage: 3.2, tracer: 0xff9040, drag: 0.09 }),
  'cn_23': A({ id: 'cn_23', name: '23 mm VYa cannon', short: 'CN', kind: 'MG', caliber: 23, velocity: 905, pen100: 32, pen1000: 18, explosive: 0.015, damage: 4, tracer: 0xff9040, drag: 0.08 }),

  // --- Ordnance
  'bomb_sc500': A({ id: 'bomb_sc500', name: 'SC 500 bomb', short: 'BOMB', kind: 'BOMB', caliber: 470, velocity: 0, pen100: 0, pen1000: 0, explosive: 220, damage: 200, tracer: 0, drag: 0.005 }),
  'bomb_sc50': A({ id: 'bomb_sc50', name: 'SC 50 bomb', short: 'BOMB', kind: 'BOMB', caliber: 200, velocity: 0, pen100: 0, pen1000: 0, explosive: 25, damage: 80, tracer: 0, drag: 0.005 }),
  'bomb_fab100': A({ id: 'bomb_fab100', name: 'FAB-100 bomb', short: 'BOMB', kind: 'BOMB', caliber: 270, velocity: 0, pen100: 0, pen1000: 0, explosive: 50, damage: 110, tracer: 0, drag: 0.005 }),
  'bomb_an_m64': A({ id: 'bomb_an_m64', name: 'AN-M64 500 lb', short: 'BOMB', kind: 'BOMB', caliber: 360, velocity: 0, pen100: 0, pen1000: 0, explosive: 120, damage: 160, tracer: 0, drag: 0.005 }),
  'rkt_rs82': A({ id: 'rkt_rs82', name: 'RS-82 rocket', short: 'RKT', kind: 'ROCKET', caliber: 82, velocity: 340, pen100: 25, pen1000: 25, explosive: 0.36, damage: 30, tracer: 0xffb060, drag: 0 }),
  'rkt_hvar': A({ id: 'rkt_hvar', name: 'HVAR rocket', short: 'RKT', kind: 'ROCKET', caliber: 127, velocity: 420, pen100: 45, pen1000: 45, explosive: 2.2, damage: 45, tracer: 0xffb060, drag: 0 }),
};

/** Flat-plate penetration at the given distance (m). */
export function penAt(a: AmmoSpec, dist: number): number {
  if (a.kind === 'HE' || a.kind === 'ROCKET' || a.kind === 'BOMB') return a.pen100;
  const t = Math.min(Math.max((dist - 100) / 900, 0), 1.4);
  return Math.max(1, a.pen100 + (a.pen1000 - a.pen100) * t);
}

/** Normalization (deg) an armor-piercing cap gives at oblique impact; APCR "de-normalizes". */
export function normalizationOf(a: AmmoSpec): number {
  switch (a.kind) {
    case 'APHE': return 4;
    case 'AP': return 4;
    case 'APCR': return -2;
    default: return 0;
  }
}

/** Impact angle above which the shell ricochets (deg from plate normal). */
export function ricochetAngleOf(a: AmmoSpec): number {
  switch (a.kind) {
    case 'APCR': return 66;
    case 'AP': return 72;
    case 'APHE': return 70;
    case 'HE': return 79;
    case 'MG': return 70;
    default: return 85;
  }
}
