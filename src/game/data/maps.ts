import type { Nation } from './vehicles';

export interface MapTheme {
  sky: number; horizon: number; fog: number; fogNear: number; fogFar: number;
  sun: number; sunIntensity: number; ambient: number; sunDir: [number, number, number];
  ground: number[]; // base palette mixed by noise
  field: number[]; road: number; rock: number; shore: number;
  tree: 'deciduous' | 'pine' | 'palm' | 'birch' | 'dead';
  dust: number;
}

export interface MapDef {
  id: 'normandy' | 'stalingrad' | 'kursk' | 'africa';
  name: string; location: string; date: string; blurb: string;
  allies: Nation; // historical Allied nation for this battlefield
  theme: MapTheme;
  pointNames: [string, string, string];
}

export const MAPS: MapDef[] = [
  {
    id: 'normandy', name: 'Normandy', location: 'Saint-Lô, Normandy, France', date: 'July 1944', allies: 'USA',
    blurb: 'Bocage country: sunken lanes, thick hedgerows, orchards and stone farmhouses around a crossroads village.',
    theme: {
      sky: 0x8fb3d9, horizon: 0xc9d6dc, fog: 0xb9c7cc, fogNear: 250, fogFar: 1300,
      sun: 0xfff1d6, sunIntensity: 2.4, ambient: 0.85, sunDir: [0.5, 0.8, 0.3],
      ground: [0x4d6a2c, 0x5d7a35, 0x6b8340, 0x48602a], field: [0x6f8a3c, 0x8a9a48, 0x5c7a32, 0xa59a55, 0x7b9340],
      road: 0x8a7a5e, rock: 0x7a776a, shore: 0x6e6a4f, tree: 'deciduous', dust: 0x8a7a60,
    },
    pointNames: ['La Ferme Martin', 'Église Saint-Lô', 'Carrefour Est'],
  },
  {
    id: 'stalingrad', name: 'Stalingrad', location: 'Stalingrad, Soviet Union', date: 'October 1942', allies: 'USSR',
    blurb: 'A city reduced to rubble. Gutted apartment blocks, the Red October factory, the rail station and Mamayev Kurgan.',
    theme: {
      sky: 0x9aa3a8, horizon: 0xb4b2aa, fog: 0x9e9a92, fogNear: 180, fogFar: 1100,
      sun: 0xffe2c0, sunIntensity: 1.8, ambient: 0.95, sunDir: [-0.4, 0.6, 0.5],
      ground: [0x6b6358, 0x5d564c, 0x77705f, 0x4f4a42], field: [0x6a6052, 0x5a554e, 0x77705f],
      road: 0x4a4744, rock: 0x6c6a66, shore: 0x5d5a50, tree: 'dead', dust: 0x8a8378,
    },
    pointNames: ['Mamayev Kurgan', 'Station No. 1', 'Red October Factory'],
  },
  {
    id: 'kursk', name: 'Kursk', location: 'Prokhorovka, Kursk Salient, USSR', date: 'July 1943', allies: 'USSR',
    blurb: 'Open steppe of wheat and sunflower fields, birch groves, Hill 252.2 and the Oktyabrsky state farm.',
    theme: {
      sky: 0x86b0de, horizon: 0xd8dccf, fog: 0xc8ccc0, fogNear: 300, fogFar: 1500,
      sun: 0xfff3d9, sunIntensity: 2.6, ambient: 0.8, sunDir: [0.3, 0.85, -0.4],
      ground: [0x6c7f38, 0x7e8a40, 0x8f9448, 0x5f7432], field: [0xc4ad5a, 0xb59a48, 0x9aa548, 0xd4bc68, 0x7d8f3c],
      road: 0x8f7b5a, rock: 0x857f70, shore: 0x7a7458, tree: 'birch', dust: 0x9a8a68,
    },
    pointNames: ['Prokhorovka', 'Hill 252.2', 'Sovkhoz Oktyabrsky'],
  },
  {
    id: 'africa', name: 'North Africa', location: 'Kasserine Pass, Tunisia', date: 'February 1943', allies: 'USA',
    blurb: 'A desert valley between rocky djebels: dunes, a whitewashed town, a palm oasis and an old hilltop fort.',
    theme: {
      sky: 0x8ec0ea, horizon: 0xe6dcc4, fog: 0xe0d2b4, fogNear: 300, fogFar: 1500,
      sun: 0xfff0d0, sunIntensity: 2.9, ambient: 0.9, sunDir: [0.2, 0.9, 0.35],
      ground: [0xcdb07a, 0xc2a46c, 0xd6bc86, 0xb8985e], field: [0xb89a64, 0xa88c58],
      road: 0xa58c64, rock: 0x9a8064, shore: 0xb09a70, tree: 'palm', dust: 0xd8c090,
    },
    pointNames: ['Kasserine Town', 'Oasis', 'Djebel Fort'],
  },
];

export function getMap(id: string): MapDef {
  return MAPS.find((m) => m.id === id) ?? MAPS[0];
}
