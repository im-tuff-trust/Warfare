// Vehicle specifications. Dimensions in metres, armor in mm with slopes in degrees from
// vertical, speeds in km/h. Vehicle-local axes: +Z forward, +Y up, +X = vehicle LEFT.

export type Nation = 'GER' | 'USSR' | 'USA';
export type TankClass = 'light' | 'medium' | 'heavy';
export type AirClass = 'fighter' | 'bomber';
export type VehicleClass = TankClass | AirClass;
export type Role = 'commander' | 'driver' | 'gunner' | 'loader' | 'radio';
export type SeatPos = 'driver' | 'radio' | 'gunner' | 'commander' | 'loader';

export const ROLE_NAMES: Record<Role, string> = {
  commander: 'Commander', driver: 'Driver', gunner: 'Gunner', loader: 'Loader', radio: 'Radio Operator',
};

export const NATION_NAMES: Record<Nation, string> = { GER: 'Germany', USSR: 'Soviet Union', USA: 'United States' };

export interface HullShape {
  L: number; W: number; H: number; // hull length, width (incl. tracks), roof height above ground
  clr: number; // ground clearance (floor height)
  yNose: number; // height of the nose (junction of upper/lower front plates)
  aUp: number; // upper front plate slope (deg from vertical)
  aLow: number; // lower front plate slope
  yRear: number; aRear: number; aRearLow: number;
  trackTop: number; // height of top of tracks (side hits below = running gear)
  trackW: number; wheels: number; wheelR: number;
  sponson?: boolean; // upper hull overhangs tracks
}

export interface TurretShape {
  z: number; // turret ring centre z (hull local)
  w: number; l: number; h: number; // base footprint and height
  shape: 'box' | 'hex' | 'round' | 'cast';
  taper: number; // top size fraction (1 = vertical sides)
  front: number; // fraction of l in front of the ring centre
  mantletW: number; // mantlet width (m)
  gunY: number; // trunnion height above turret base
}

export interface ArmorTable {
  upperFront: number; lowerFront: number; side: number; rear: number; roof: number; floor: number;
  turretFront: number; mantlet: number; turretSide: number; turretRear: number; turretRoof: number;
}

export interface CrewSeatSpec { roles: Role[]; seat: SeatPos; }

export interface RackSpec { x: number; z: number; w: number; l: number; h: number; y?: number; turret?: boolean; rounds: number; }

export interface TankSpec {
  kind: 'tank';
  id: string; name: string; nation: Nation; cls: TankClass; year: number; blurb: string;
  mass: number; power: number; maxSpeed: number; reverse: number; hullTraverse: number; turretTraverse: number;
  elev: [number, number];
  hull: HullShape; turret: TurretShape; armor: ArmorTable;
  gun: { name: string; caliber: number; length: number; reload: number; ammo: string[]; clip?: { size: number; interval: number }; dispersion: number; aimTime: number; zoom: number };
  crew: CrewSeatSpec[];
  layout: { trans: 'front' | 'rear'; driver: 'left' | 'right'; gunnerSide: 'left' | 'right'; ammo: RackSpec[]; fuel: { x: number; z: number; w: number; l: number; h: number }[]; diesel: boolean };
  structure: number;
  colors: { base: number; dark: number; camo?: number; mark: 'cross' | 'star' | 'redstar' };
  ammoCount: number;
}

export interface AircraftSpec {
  kind: 'aircraft';
  id: string; name: string; nation: Nation; cls: AirClass; year: number; blurb: string;
  maxSpeed: number; // km/h at full throttle, level
  minSpeed: number; // stall, km/h
  climb: number; turn: number; roll: number; // turn (deg/s pitch), roll (deg/s)
  hp: number;
  guns: { ammo: string; count: number; rate: number; rounds: number; offset: [number, number, number][] }[];
  bombs: { ammo: string; count: number }[];
  rockets?: { ammo: string; count: number };
  gunner?: boolean; // rear gunner
  span: number; length: number; engines: 1 | 2; inverted?: boolean;
  colors: { base: number; under: number; mark: 'cross' | 'star' | 'redstar' };
  crewNames: string[];
}

export type VehicleSpec = TankSpec | AircraftSpec;

const sideL = 1, sideR = -1;
void sideL; void sideR;

export const TANKS: TankSpec[] = [
  // ---------------- LIGHT ----------------
  {
    kind: 'tank', id: 'm5_stuart', name: 'M5A1 Stuart', nation: 'USA', cls: 'light', year: 1942,
    blurb: 'Fast American scout. Twin Cadillac V8s and a quick-firing 37 mm gun; thin armor.',
    mass: 15.4, power: 296, maxSpeed: 58, reverse: 14, hullTraverse: 46, turretTraverse: 32, elev: [-12, 20],
    hull: { L: 4.84, W: 2.29, H: 1.62, clr: 0.36, yNose: 0.95, aUp: 48, aLow: 22, yRear: 1.2, aRear: 15, aRearLow: 30, trackTop: 0.78, trackW: 0.3, wheels: 4, wheelR: 0.3 },
    turret: { z: -0.1, w: 1.42, l: 1.6, h: 0.62, shape: 'hex', taper: 0.86, front: 0.55, mantletW: 0.6, gunY: 0.3 },
    armor: { upperFront: 29, lowerFront: 44, side: 28, rear: 25, roof: 13, floor: 10, turretFront: 44, mantlet: 51, turretSide: 32, turretRear: 32, turretRoof: 13 },
    gun: { name: '37 mm M6', caliber: 37, length: 1.9, reload: 2.6, ammo: ['37_m51', '37_m63'], dispersion: 1.2, aimTime: 1.6, zoom: 3.5 },
    crew: [
      { roles: ['commander', 'loader'], seat: 'loader' },
      { roles: ['gunner'], seat: 'gunner' },
      { roles: ['driver'], seat: 'driver' },
      { roles: ['radio'], seat: 'radio' },
    ],
    layout: { trans: 'front', driver: 'left', gunnerSide: 'left', diesel: false,
      ammo: [{ x: -0.55, z: -0.05, w: 0.35, l: 0.5, h: 0.45, rounds: 70 }, { x: 0.55, z: -0.1, w: 0.3, l: 0.4, h: 0.4, rounds: 53 }],
      fuel: [{ x: 0.55, z: -0.55, w: 0.3, l: 0.35, h: 0.5 }, { x: -0.55, z: -0.55, w: 0.3, l: 0.35, h: 0.5 }] },
    structure: 80, ammoCount: 123,
    colors: { base: 0x4f5634, dark: 0x30331f, mark: 'star' },
  },
  {
    kind: 'tank', id: 't70', name: 'T-70', nation: 'USSR', cls: 'light', year: 1942,
    blurb: 'Small Soviet light tank. A two-man crew: the commander also aims and loads the 45 mm gun.',
    mass: 9.2, power: 140, maxSpeed: 45, reverse: 12, hullTraverse: 48, turretTraverse: 20, elev: [-8, 20],
    hull: { L: 4.29, W: 2.32, H: 1.42, clr: 0.3, yNose: 0.8, aUp: 60, aLow: 30, yRear: 1.05, aRear: 20, aRearLow: 40, trackTop: 0.7, trackW: 0.28, wheels: 5, wheelR: 0.25 },
    turret: { z: 0.05, w: 1.3, l: 1.45, h: 0.6, shape: 'hex', taper: 0.78, front: 0.5, mantletW: 0.45, gunY: 0.28 },
    armor: { upperFront: 35, lowerFront: 45, side: 15, rear: 25, roof: 10, floor: 10, turretFront: 35, mantlet: 60, turretSide: 35, turretRear: 35, turretRoof: 10 },
    gun: { name: '45 mm 20-K', caliber: 45, length: 2.1, reload: 3.8, ammo: ['45_br240', '45_br240p', '45_o240'], dispersion: 1.4, aimTime: 1.9, zoom: 2.5 },
    crew: [
      { roles: ['commander', 'gunner', 'loader', 'radio'], seat: 'gunner' },
      { roles: ['driver'], seat: 'driver' },
    ],
    layout: { trans: 'front', driver: 'left', gunnerSide: 'left', diesel: false,
      ammo: [{ x: -0.5, z: -0.1, w: 0.4, l: 0.55, h: 0.4, rounds: 90 }],
      fuel: [{ x: -0.55, z: -0.6, w: 0.35, l: 0.4, h: 0.45 }] },
    structure: 70, ammoCount: 90,
    colors: { base: 0x4a5a2c, dark: 0x2c361a, mark: 'redstar' },
  },
  {
    kind: 'tank', id: 'pz2_luchs', name: 'Pz.Kpfw. II Ausf. L "Luchs"', nation: 'GER', cls: 'light', year: 1943,
    blurb: 'German reconnaissance tank. 20 mm autocannon fires 10-round clips; very fast on roads.',
    mass: 11.8, power: 180, maxSpeed: 60, reverse: 14, hullTraverse: 44, turretTraverse: 26, elev: [-9, 18],
    hull: { L: 4.63, W: 2.48, H: 1.58, clr: 0.4, yNose: 0.95, aUp: 22, aLow: 30, yRear: 1.15, aRear: 10, aRearLow: 30, trackTop: 0.78, trackW: 0.3, wheels: 5, wheelR: 0.33, sponson: true },
    turret: { z: 0.0, w: 1.55, l: 1.7, h: 0.62, shape: 'hex', taper: 0.84, front: 0.52, mantletW: 0.5, gunY: 0.3 },
    armor: { upperFront: 30, lowerFront: 30, side: 20, rear: 20, roof: 10, floor: 10, turretFront: 30, mantlet: 30, turretSide: 20, turretRear: 20, turretRoof: 12 },
    gun: { name: '2 cm KwK 38', caliber: 20, length: 1.6, reload: 4.6, ammo: ['20_pzgr40', '20_pzgr', '20_sprgr'], clip: { size: 10, interval: 0.22 }, dispersion: 1.6, aimTime: 1.2, zoom: 2.5 },
    crew: [
      { roles: ['commander', 'loader'], seat: 'commander' },
      { roles: ['gunner'], seat: 'gunner' },
      { roles: ['driver'], seat: 'driver' },
      { roles: ['radio'], seat: 'radio' },
    ],
    layout: { trans: 'front', driver: 'left', gunnerSide: 'left', diesel: false,
      ammo: [{ x: -0.55, z: 0.0, w: 0.35, l: 0.6, h: 0.4, rounds: 330 }],
      fuel: [{ x: 0.5, z: -0.55, w: 0.35, l: 0.35, h: 0.5 }] },
    structure: 75, ammoCount: 330,
    colors: { base: 0x8c7a4c, dark: 0x4f442a, camo: 0x5b6438, mark: 'cross' },
  },
  // ---------------- MEDIUM ----------------
  {
    kind: 'tank', id: 'pz4_h', name: 'Pz.Kpfw. IV Ausf. H', nation: 'GER', cls: 'medium', year: 1943,
    blurb: 'Workhorse of the Panzerwaffe. Accurate long 75 mm KwK 40 and 80 mm frontal hull armor.',
    mass: 25.0, power: 300, maxSpeed: 40, reverse: 9, hullTraverse: 34, turretTraverse: 18, elev: [-8, 20],
    hull: { L: 5.89, W: 2.88, H: 1.85, clr: 0.4, yNose: 1.0, aUp: 12, aLow: 14, yRear: 1.3, aRear: 10, aRearLow: 20, trackTop: 0.85, trackW: 0.4, wheels: 8, wheelR: 0.28, sponson: true },
    turret: { z: 0.05, w: 1.75, l: 2.0, h: 0.72, shape: 'hex', taper: 0.8, front: 0.5, mantletW: 0.8, gunY: 0.33 },
    armor: { upperFront: 80, lowerFront: 80, side: 30, rear: 20, roof: 12, floor: 10, turretFront: 50, mantlet: 50, turretSide: 30, turretRear: 30, turretRoof: 16 },
    gun: { name: '7.5 cm KwK 40 L/48', caliber: 75, length: 3.6, reload: 6.2, ammo: ['75_pzgr39', '75_pzgr40', '75_sprgr34'], dispersion: 0.8, aimTime: 2.3, zoom: 4.2 },
    crew: [
      { roles: ['commander'], seat: 'commander' },
      { roles: ['gunner'], seat: 'gunner' },
      { roles: ['loader'], seat: 'loader' },
      { roles: ['driver'], seat: 'driver' },
      { roles: ['radio'], seat: 'radio' },
    ],
    layout: { trans: 'front', driver: 'left', gunnerSide: 'left', diesel: false,
      ammo: [{ x: -0.6, z: 0.05, w: 0.38, l: 0.7, h: 0.45, rounds: 32 }, { x: 0.62, z: -0.05, w: 0.32, l: 0.5, h: 0.4, rounds: 26 }, { x: -0.35, z: 0.45, w: 0.3, l: 0.35, h: 0.35, rounds: 29 }],
      fuel: [{ x: 0.0, z: -0.42, w: 0.9, l: 0.12, h: 0.35, }] },
    structure: 100, ammoCount: 87,
    colors: { base: 0x9a8a5a, dark: 0x5c5236, camo: 0x55603a, mark: 'cross' },
  },
  {
    kind: 'tank', id: 't34_76', name: 'T-34 (1942)', nation: 'USSR', cls: 'medium', year: 1942,
    blurb: 'Revolutionary sloped armor and a diesel V-2 engine. Commander doubles as gunner.',
    mass: 30.9, power: 500, maxSpeed: 54, reverse: 10, hullTraverse: 38, turretTraverse: 24, elev: [-5, 28],
    hull: { L: 5.92, W: 3.0, H: 1.65, clr: 0.4, yNose: 0.82, aUp: 60, aLow: 53, yRear: 1.15, aRear: 47, aRearLow: 45, trackTop: 0.9, trackW: 0.5, wheels: 5, wheelR: 0.42, sponson: true },
    turret: { z: 0.55, w: 1.95, l: 2.15, h: 0.72, shape: 'hex', taper: 0.72, front: 0.55, mantletW: 0.7, gunY: 0.32 },
    armor: { upperFront: 45, lowerFront: 45, side: 45, rear: 40, roof: 20, floor: 15, turretFront: 52, mantlet: 52, turretSide: 52, turretRear: 52, turretRoof: 15 },
    gun: { name: '76 mm F-34', caliber: 76, length: 3.1, reload: 6.6, ammo: ['76_br350a', '76_br350p', '76_of350'], dispersion: 1.0, aimTime: 2.6, zoom: 3.5 },
    crew: [
      { roles: ['commander', 'gunner'], seat: 'gunner' },
      { roles: ['loader'], seat: 'loader' },
      { roles: ['driver'], seat: 'driver' },
      { roles: ['radio'], seat: 'radio' },
    ],
    layout: { trans: 'rear', driver: 'left', gunnerSide: 'left', diesel: true,
      ammo: [{ x: 0, z: 0.12, w: 1.1, l: 0.6, h: 0.22, y: 0.5, rounds: 77 }, { x: -0.58, z: 0.38, w: 0.3, l: 0.3, h: 0.4, rounds: 23 }],
      fuel: [{ x: 0.66, z: 0.15, w: 0.2, l: 0.8, h: 0.5 }, { x: -0.66, z: 0.15, w: 0.2, l: 0.8, h: 0.5 }] },
    structure: 100, ammoCount: 100,
    colors: { base: 0x4b5a2e, dark: 0x2c3619, mark: 'redstar' },
  },
  {
    kind: 'tank', id: 'm4_sherman', name: 'M4A1 Sherman', nation: 'USA', cls: 'medium', year: 1942,
    blurb: 'Reliable American medium. Fast turret traverse with gyrostabilized gun; tall profile.',
    mass: 30.3, power: 400, maxSpeed: 42, reverse: 12, hullTraverse: 36, turretTraverse: 26, elev: [-10, 25],
    hull: { L: 5.84, W: 2.62, H: 1.95, clr: 0.43, yNose: 1.05, aUp: 56, aLow: 45, yRear: 1.4, aRear: 12, aRearLow: 25, trackTop: 0.98, trackW: 0.42, wheels: 6, wheelR: 0.3, sponson: true },
    turret: { z: 0.0, w: 1.85, l: 2.05, h: 0.75, shape: 'cast', taper: 0.75, front: 0.5, mantletW: 0.85, gunY: 0.32 },
    armor: { upperFront: 51, lowerFront: 51, side: 38, rear: 38, roof: 19, floor: 13, turretFront: 76, mantlet: 89, turretSide: 51, turretRear: 51, turretRoof: 25 },
    gun: { name: '75 mm M3', caliber: 75, length: 2.9, reload: 5.6, ammo: ['75_m61', '75_m72', '75_m48'], dispersion: 1.0, aimTime: 2.0, zoom: 3.0 },
    crew: [
      { roles: ['commander'], seat: 'commander' },
      { roles: ['gunner'], seat: 'gunner' },
      { roles: ['loader'], seat: 'loader' },
      { roles: ['driver'], seat: 'driver' },
      { roles: ['radio'], seat: 'radio' },
    ],
    layout: { trans: 'front', driver: 'left', gunnerSide: 'right', diesel: false,
      ammo: [{ x: 0.62, z: 0.12, w: 0.3, l: 0.55, h: 0.5, rounds: 30 }, { x: -0.62, z: 0.12, w: 0.3, l: 0.55, h: 0.5, rounds: 30 }, { x: 0.3, z: 0.42, w: 0.3, l: 0.3, h: 0.35, rounds: 30 }],
      fuel: [{ x: 0.6, z: -0.55, w: 0.3, l: 0.4, h: 0.6 }, { x: -0.6, z: -0.55, w: 0.3, l: 0.4, h: 0.6 }] },
    structure: 100, ammoCount: 90,
    colors: { base: 0x4f5634, dark: 0x30331f, mark: 'star' },
  },
  // ---------------- HEAVY ----------------
  {
    kind: 'tank', id: 'tiger_1', name: 'Pz.Kpfw. VI Tiger I Ausf. E', nation: 'GER', cls: 'heavy', year: 1943,
    blurb: 'Legendary heavy tank. 100 mm frontal armor and the lethal 8.8 cm KwK 36. Slow turret.',
    mass: 57.0, power: 700, maxSpeed: 40, reverse: 9, hullTraverse: 24, turretTraverse: 12, elev: [-8, 15],
    hull: { L: 6.32, W: 3.56, H: 1.92, clr: 0.47, yNose: 1.2, aUp: 9, aLow: 24, yRear: 1.4, aRear: 8, aRearLow: 20, trackTop: 1.05, trackW: 0.72, wheels: 8, wheelR: 0.4, sponson: true },
    turret: { z: 0.1, w: 2.35, l: 2.7, h: 0.88, shape: 'box', taper: 0.93, front: 0.42, mantletW: 1.2, gunY: 0.42 },
    armor: { upperFront: 100, lowerFront: 100, side: 80, rear: 80, roof: 25, floor: 25, turretFront: 100, mantlet: 120, turretSide: 80, turretRear: 80, turretRoof: 25 },
    gun: { name: '8.8 cm KwK 36 L/56', caliber: 88, length: 4.9, reload: 8.0, ammo: ['88_pzgr39', '88_pzgr40', '88_sprgr'], dispersion: 0.7, aimTime: 2.6, zoom: 5.0 },
    crew: [
      { roles: ['commander'], seat: 'commander' },
      { roles: ['gunner'], seat: 'gunner' },
      { roles: ['loader'], seat: 'loader' },
      { roles: ['driver'], seat: 'driver' },
      { roles: ['radio'], seat: 'radio' },
    ],
    layout: { trans: 'front', driver: 'left', gunnerSide: 'left', diesel: false,
      ammo: [{ x: 0.66, z: 0.05, w: 0.3, l: 0.8, h: 0.55, rounds: 32 }, { x: -0.66, z: 0.05, w: 0.3, l: 0.8, h: 0.55, rounds: 32 }, { x: -0.35, z: 0.45, w: 0.3, l: 0.25, h: 0.35, rounds: 28 }],
      fuel: [{ x: 0.6, z: -0.6, w: 0.3, l: 0.3, h: 0.55 }, { x: -0.6, z: -0.6, w: 0.3, l: 0.3, h: 0.55 }] },
    structure: 130, ammoCount: 92,
    colors: { base: 0x9a8a5a, dark: 0x5c5236, camo: 0x6a4a30, mark: 'cross' },
  },
  {
    kind: 'tank', id: 'kv1', name: 'KV-1 (ZiS-5)', nation: 'USSR', cls: 'heavy', year: 1941,
    blurb: 'Soviet breakthrough tank, nearly immune to early German guns. Heavy, slow and stubborn.',
    mass: 47.5, power: 600, maxSpeed: 35, reverse: 8, hullTraverse: 26, turretTraverse: 14, elev: [-5, 25],
    hull: { L: 6.75, W: 3.32, H: 1.9, clr: 0.44, yNose: 0.95, aUp: 30, aLow: 30, yRear: 1.25, aRear: 30, aRearLow: 50, trackTop: 0.98, trackW: 0.7, wheels: 6, wheelR: 0.36, sponson: true },
    turret: { z: 0.4, w: 2.2, l: 2.5, h: 0.9, shape: 'box', taper: 0.85, front: 0.48, mantletW: 0.9, gunY: 0.4 },
    armor: { upperFront: 75, lowerFront: 75, side: 75, rear: 60, roof: 30, floor: 30, turretFront: 95, mantlet: 100, turretSide: 95, turretRear: 75, turretRoof: 30 },
    gun: { name: '76 mm ZiS-5', caliber: 76, length: 3.2, reload: 7.2, ammo: ['76_br350a', '76_br350p', '76_of350'], dispersion: 1.0, aimTime: 2.7, zoom: 3.5 },
    crew: [
      { roles: ['commander'], seat: 'commander' },
      { roles: ['gunner'], seat: 'gunner' },
      { roles: ['loader'], seat: 'loader' },
      { roles: ['driver'], seat: 'driver' },
      { roles: ['radio'], seat: 'radio' },
    ],
    layout: { trans: 'rear', driver: 'left', gunnerSide: 'left', diesel: true,
      ammo: [{ x: 0, z: 0.15, w: 1.2, l: 0.55, h: 0.22, y: 0.55, rounds: 74 }, { x: 0.6, z: 0.4, w: 0.3, l: 0.35, h: 0.45, rounds: 40 }],
      fuel: [{ x: 0.65, z: -0.1, w: 0.25, l: 0.5, h: 0.5 }, { x: -0.65, z: -0.1, w: 0.25, l: 0.5, h: 0.5 }] },
    structure: 125, ammoCount: 114,
    colors: { base: 0x4a5a2c, dark: 0x2c361a, mark: 'redstar' },
  },
  {
    kind: 'tank', id: 'm26_pershing', name: 'M26 Pershing', nation: 'USA', cls: 'heavy', year: 1945,
    blurb: 'Late-war American heavy. 90 mm gun with HVAP rounds that can defeat a Tiger from the front.',
    mass: 41.9, power: 500, maxSpeed: 40, reverse: 13, hullTraverse: 30, turretTraverse: 20, elev: [-10, 20],
    hull: { L: 6.33, W: 3.51, H: 1.85, clr: 0.44, yNose: 1.0, aUp: 46, aLow: 53, yRear: 1.3, aRear: 10, aRearLow: 25, trackTop: 1.0, trackW: 0.6, wheels: 6, wheelR: 0.33, sponson: true },
    turret: { z: 0.05, w: 2.3, l: 2.7, h: 0.82, shape: 'cast', taper: 0.78, front: 0.45, mantletW: 1.0, gunY: 0.36 },
    armor: { upperFront: 102, lowerFront: 76, side: 76, rear: 51, roof: 22, floor: 25, turretFront: 102, mantlet: 114, turretSide: 76, turretRear: 76, turretRoof: 25 },
    gun: { name: '90 mm M3', caliber: 90, length: 4.4, reload: 7.4, ammo: ['90_m82', '90_m304', '90_m71'], dispersion: 0.75, aimTime: 2.4, zoom: 4.0 },
    crew: [
      { roles: ['commander'], seat: 'commander' },
      { roles: ['gunner'], seat: 'gunner' },
      { roles: ['loader'], seat: 'loader' },
      { roles: ['driver'], seat: 'driver' },
      { roles: ['radio'], seat: 'radio' },
    ],
    layout: { trans: 'rear', driver: 'left', gunnerSide: 'right', diesel: false,
      ammo: [{ x: 0, z: 0.15, w: 1.2, l: 0.6, h: 0.22, y: 0.55, rounds: 50 }, { x: -0.6, z: 0.35, w: 0.3, l: 0.3, h: 0.4, rounds: 20 }],
      fuel: [{ x: 0.6, z: -0.2, w: 0.3, l: 0.35, h: 0.55 }, { x: -0.6, z: -0.2, w: 0.3, l: 0.35, h: 0.55 }] },
    structure: 125, ammoCount: 70,
    colors: { base: 0x4f5634, dark: 0x30331f, mark: 'star' },
  },
];

export const AIRCRAFT: AircraftSpec[] = [
  {
    kind: 'aircraft', id: 'bf109_g6', name: 'Bf 109 G-6', nation: 'GER', cls: 'fighter', year: 1943,
    blurb: 'Agile Messerschmitt fighter. Engine-mounted 20 mm cannon and twin 13 mm MG 131.',
    maxSpeed: 630, minSpeed: 170, climb: 19, turn: 58, roll: 150, hp: 100,
    guns: [{ ammo: 'cn_20', count: 1, rate: 11, rounds: 150, offset: [[0, 0, 2.4]] }, { ammo: 'mg_13', count: 2, rate: 14, rounds: 300, offset: [[0.25, 0.4, 1.6], [-0.25, 0.4, 1.6]] }],
    bombs: [{ ammo: 'bomb_sc50', count: 2 }], span: 9.9, length: 9.0, engines: 1, inverted: true,
    colors: { base: 0x7d8584, under: 0xa8b4bb, mark: 'cross' }, crewNames: ['Pilot'],
  },
  {
    kind: 'aircraft', id: 'yak9', name: 'Yak-9', nation: 'USSR', cls: 'fighter', year: 1943,
    blurb: 'Light Yakovlev fighter, superb at low altitude. Hub-firing 20 mm ShVAK and a 12.7 mm UBS.',
    maxSpeed: 600, minSpeed: 160, climb: 17, turn: 62, roll: 140, hp: 95,
    guns: [{ ammo: 'cn_20', count: 1, rate: 12, rounds: 120, offset: [[0, 0, 2.4]] }, { ammo: 'mg_127', count: 1, rate: 13, rounds: 200, offset: [[0.2, 0.4, 1.6]] }],
    bombs: [{ ammo: 'bomb_fab100', count: 2 }], span: 9.74, length: 8.5, engines: 1, inverted: true,
    colors: { base: 0x6f7d5a, under: 0x9fb0c0, mark: 'redstar' }, crewNames: ['Pilot'],
  },
  {
    kind: 'aircraft', id: 'p51d', name: 'P-51D Mustang', nation: 'USA', cls: 'fighter', year: 1944,
    blurb: 'Long-range escort fighter with six .50 cal Brownings and wing hardpoints for 500 lb bombs.',
    maxSpeed: 700, minSpeed: 175, climb: 16, turn: 54, roll: 135, hp: 100,
    guns: [{ ammo: 'mg_127', count: 6, rate: 13, rounds: 400, offset: [[1.6, 0, 1], [1.9, 0, 1], [2.2, 0, 1], [-1.6, 0, 1], [-1.9, 0, 1], [-2.2, 0, 1]] }],
    bombs: [{ ammo: 'bomb_an_m64', count: 2 }], rockets: { ammo: 'rkt_hvar', count: 6 }, span: 11.3, length: 9.8, engines: 1,
    colors: { base: 0xb7bcc0, under: 0xb7bcc0, mark: 'star' }, crewNames: ['Pilot'],
  },
  {
    kind: 'aircraft', id: 'ju87_d', name: 'Ju 87 D-5 Stuka', nation: 'GER', cls: 'bomber', year: 1943,
    blurb: 'Dive bomber with the screaming siren. Precision 500 kg bomb and a rear gunner.',
    maxSpeed: 400, minSpeed: 140, climb: 9, turn: 40, roll: 85, hp: 140,
    guns: [{ ammo: 'cn_20', count: 2, rate: 8, rounds: 250, offset: [[2.2, 0, 1.2], [-2.2, 0, 1.2]] }],
    bombs: [{ ammo: 'bomb_sc500', count: 1 }, { ammo: 'bomb_sc50', count: 4 }], gunner: true, span: 15, length: 11.5, engines: 1,
    colors: { base: 0x5b6648, under: 0x9fb2c2, mark: 'cross' }, crewNames: ['Pilot', 'Rear Gunner'],
  },
  {
    kind: 'aircraft', id: 'il2', name: 'Il-2M Shturmovik', nation: 'USSR', cls: 'bomber', year: 1943,
    blurb: 'The "flying tank". Armored attack aircraft with 23 mm cannons, rockets and bombs.',
    maxSpeed: 410, minSpeed: 150, climb: 8, turn: 38, roll: 80, hp: 200,
    guns: [{ ammo: 'cn_23', count: 2, rate: 9, rounds: 300, offset: [[1.8, 0, 1.2], [-1.8, 0, 1.2]] }],
    bombs: [{ ammo: 'bomb_fab100', count: 4 }], rockets: { ammo: 'rkt_rs82', count: 8 }, gunner: true, span: 14.6, length: 11.6, engines: 1,
    colors: { base: 0x5f6b3e, under: 0x9fb2c2, mark: 'redstar' }, crewNames: ['Pilot', 'Rear Gunner'],
  },
  {
    kind: 'aircraft', id: 'b25j', name: 'B-25J Mitchell', nation: 'USA', cls: 'bomber', year: 1944,
    blurb: 'Twin-engine medium bomber. Heavy nose firepower and a 3,000 lb bomb load.',
    maxSpeed: 440, minSpeed: 170, climb: 7, turn: 30, roll: 60, hp: 260,
    guns: [{ ammo: 'mg_127', count: 4, rate: 12, rounds: 400, offset: [[0.3, -0.2, 7], [-0.3, -0.2, 7], [0.2, 0.2, 7], [-0.2, 0.2, 7]] }],
    bombs: [{ ammo: 'bomb_an_m64', count: 6 }], gunner: true, span: 20.6, length: 16.1, engines: 2,
    colors: { base: 0x5a5f3c, under: 0x8e959a, mark: 'star' }, crewNames: ['Pilot', 'Bombardier', 'Top Gunner'],
  },
];

export const ALL_VEHICLES: VehicleSpec[] = [...TANKS, ...AIRCRAFT];

export function getVehicle(id: string): VehicleSpec {
  const v = ALL_VEHICLES.find((x) => x.id === id);
  if (!v) throw new Error('Unknown vehicle ' + id);
  return v;
}

export const CLASS_LABEL: Record<VehicleClass, string> = {
  light: 'Light Tank', medium: 'Medium Tank', heavy: 'Heavy Tank', fighter: 'Fighter', bomber: 'Bomber',
};
