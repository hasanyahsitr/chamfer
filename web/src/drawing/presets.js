// Standard ISO / NEMA / EIA industrial reference drawings (verified 0 DRC errors + 3D extrudable).
import { flawedCncBracketExample } from './linter.js';

export function buildSlottedPlateBlueprint() {
  return {
    format: 'cad-lab.drawing',
    schema_version: 1,
    units: 'mm',
    name: 'M6-SLOTTED-PLATE',
    layers: [
      { id: '0', name: '0-PROFILE', color: '#dce2ea', visible: true, locked: false },
      { id: 'slot', name: 'SLOT-CUT', color: '#5aa9e6', visible: true, locked: false },
      { id: 'dims', name: 'DIMENSIONS', color: '#e09b24', visible: true, locked: false },
    ],
    entities: [
      {
        id: 'outer',
        type: 'polyline',
        layer: '0',
        points: [
          [0, 0],
          [100, 0],
          [100, 60],
          [0, 60],
        ],
        closed: true,
      },
      { id: 'bolt-bl', type: 'circle', layer: '0', center: [12, 12], radius: 3.25 },
      { id: 'bolt-tl', type: 'circle', layer: '0', center: [12, 48], radius: 3.25 },
      { id: 'bolt-br', type: 'circle', layer: '0', center: [88, 12], radius: 3.25 },
      { id: 'bolt-tr', type: 'circle', layer: '0', center: [88, 48], radius: 3.25 },
      {
        id: 'slot-top',
        type: 'line',
        layer: 'slot',
        points: [
          [35, 38],
          [65, 38],
        ],
      },
      {
        id: 'slot-bot',
        type: 'line',
        layer: 'slot',
        points: [
          [35, 22],
          [65, 22],
        ],
      },
      {
        id: 'slot-arc-l',
        type: 'arc',
        layer: 'slot',
        center: [35, 30],
        radius: 8,
        start_angle: 90,
        end_angle: 270,
      },
      {
        id: 'slot-arc-r',
        type: 'arc',
        layer: 'slot',
        center: [65, 30],
        radius: 8,
        start_angle: 270,
        end_angle: 90,
      },
      {
        id: 'dim-width',
        type: 'dim',
        layer: 'dims',
        p1: [0, 0],
        p2: [100, 0],
        dim_point: [50, -10],
      },
      {
        id: 'dim-height',
        type: 'dim',
        layer: 'dims',
        p1: [100, 0],
        p2: [100, 60],
        dim_point: [112, 30],
      },
      {
        id: 'dim-bolts',
        type: 'dim',
        layer: 'dims',
        p1: [12, 48],
        p2: [88, 48],
        dim_point: [50, 69],
      },
      {
        id: 'dim-slot',
        type: 'dim',
        layer: 'dims',
        p1: [35, 38],
        p2: [65, 38],
        dim_point: [50, 46],
      },
    ],
  };
}

export function buildNema17MountBlueprint() {
  return {
    format: 'cad-lab.drawing',
    schema_version: 1,
    units: 'mm',
    name: 'NEMA17-MOTOR-MOUNT',
    layers: [
      { id: '0', name: '0', color: '#d4d8de', visible: true, locked: false },
      { id: '0-profile', name: '0-PROFILE', color: '#dce2ea', visible: true, locked: false },
      { id: 'cutouts', name: 'CUTOUTS', color: '#5aa9e6', visible: true, locked: false },
      { id: 'dimensions', name: 'DIMENSIONS', color: '#e09b24', visible: true, locked: false },
    ],
    entities: [
      {
        id: 'frame',
        layer: '0-profile',
        type: 'polyline',
        points: [
          [0, 3.5],
          [3.5, 0],
          [38.8, 0],
          [42.3, 3.5],
          [42.3, 38.8],
          [38.8, 42.3],
          [3.5, 42.3],
          [0, 38.8],
        ],
        closed: true,
      },
      { id: 'pilot-bore', layer: 'cutouts', type: 'circle', center: [21.15, 21.15], radius: 11 },
      { id: 'm3-bl', layer: 'cutouts', type: 'circle', center: [5.65, 5.65], radius: 1.7 },
      { id: 'm3-br', layer: 'cutouts', type: 'circle', center: [36.65, 5.65], radius: 1.7 },
      { id: 'm3-tl', layer: 'cutouts', type: 'circle', center: [5.65, 36.65], radius: 1.7 },
      { id: 'm3-tr', layer: 'cutouts', type: 'circle', center: [36.65, 36.65], radius: 1.7 },
      {
        id: 'dim-frame',
        layer: 'dimensions',
        type: 'dim',
        p1: [0, 0],
        p2: [42.3, 0],
        dim_point: [21.15, -6.5],
      },
      {
        id: 'dim-pitch',
        layer: 'dimensions',
        type: 'dim',
        p1: [5.65, 36.65],
        p2: [36.65, 36.65],
        dim_point: [21.15, 48],
      },
      {
        id: 'note-spec',
        layer: 'dimensions',
        type: 'text',
        position: [1.5, -12],
        height: 2.1,
        rotation: 0,
        text: 'NEMA-17 // 4xM3 PITCH 31.0 // PILOT D22',
      },
    ],
  };
}

export function buildIsoDn50FlangeBlueprint() {
  return {
    format: 'cad-lab.drawing',
    schema_version: 1,
    units: 'mm',
    name: 'ISO-DN50-PN16-FLANGE',
    layers: [
      { id: '0', name: '0', color: '#d4d8de', visible: true, locked: false },
      { id: '0-profile', name: '0-PROFILE', color: '#dce2ea', visible: true, locked: false },
      {
        id: 'bore-and-bolts',
        name: 'BORE-AND-BOLTS',
        color: '#5aa9e6',
        visible: true,
        locked: false,
      },
      { id: 'dimensions', name: 'DIMENSIONS', color: '#e09b24', visible: true, locked: false },
    ],
    entities: [
      { id: 'flange-od', layer: '0-profile', type: 'circle', center: [0, 0], radius: 82.5 },
      { id: 'pipe-id', layer: 'bore-and-bolts', type: 'circle', center: [0, 0], radius: 30.75 },
      {
        id: 'bolt-1',
        layer: 'bore-and-bolts',
        type: 'circle',
        center: [44.194174, 44.194174],
        radius: 9,
      },
      {
        id: 'bolt-2',
        layer: 'bore-and-bolts',
        type: 'circle',
        center: [-44.194174, 44.194174],
        radius: 9,
      },
      {
        id: 'bolt-3',
        layer: 'bore-and-bolts',
        type: 'circle',
        center: [-44.194174, -44.194174],
        radius: 9,
      },
      {
        id: 'bolt-4',
        layer: 'bore-and-bolts',
        type: 'circle',
        center: [44.194174, -44.194174],
        radius: 9,
      },
      {
        id: 'dim-od',
        layer: 'dimensions',
        type: 'dim',
        p1: [-82.5, 0],
        p2: [82.5, 0],
        dim_point: [0, -96],
      },
      {
        id: 'dim-id',
        layer: 'dimensions',
        type: 'dim',
        p1: [-30.75, 0],
        p2: [30.75, 0],
        dim_point: [0, 96],
      },
      {
        id: 'note',
        layer: 'dimensions',
        type: 'text',
        position: [-54, -110],
        height: 3.4,
        rotation: 0,
        text: 'EN 1092-1 DN50 PN16 // OD165 ID61.5 // 4xD18 PCD125',
      },
    ],
  };
}

export function buildEia1uRackPanelBlueprint() {
  const vents = [];
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 8; c++) {
      vents.push({
        id: `vent-r${r + 1}c${c + 1}`,
        layer: 'vents',
        type: 'circle',
        center: [151.3 + c * 25, 14.225 + r * 16],
        radius: 4,
      });
    }
  }
  return {
    format: 'cad-lab.drawing',
    schema_version: 1,
    units: 'mm',
    name: 'EIA-19IN-1U-PANEL',
    layers: [
      { id: '0', name: '0', color: '#d4d8de', visible: true, locked: false },
      { id: '0-chassis', name: '0-CHASSIS', color: '#dce2ea', visible: true, locked: false },
      { id: 'ear-mounts', name: 'EAR-MOUNTS', color: '#5aa9e6', visible: true, locked: false },
      { id: 'vents', name: 'VENTS', color: '#6bcf8e', visible: true, locked: false },
      { id: 'dimensions', name: 'DIMENSIONS', color: '#e09b24', visible: true, locked: false },
    ],
    entities: [
      {
        id: 'panel',
        layer: '0-chassis',
        type: 'polyline',
        points: [
          [0, 1.5],
          [1.5, 0],
          [481.1, 0],
          [482.6, 1.5],
          [482.6, 42.95],
          [481.1, 44.45],
          [1.5, 44.45],
          [0, 42.95],
        ],
        closed: true,
      },
      { id: 'ear-bl', layer: 'ear-mounts', type: 'circle', center: [8.5, 6.35], radius: 3.2 },
      { id: 'ear-tl', layer: 'ear-mounts', type: 'circle', center: [8.5, 38.1], radius: 3.2 },
      { id: 'ear-br', layer: 'ear-mounts', type: 'circle', center: [474.1, 6.35], radius: 3.2 },
      { id: 'ear-tr', layer: 'ear-mounts', type: 'circle', center: [474.1, 38.1], radius: 3.2 },
      ...vents,
      {
        id: 'dim-total-w',
        layer: 'dimensions',
        type: 'dim',
        p1: [0, 0],
        p2: [482.6, 0],
        dim_point: [241.3, -14],
      },
      {
        id: 'dim-1u-h',
        layer: 'dimensions',
        type: 'dim',
        p1: [482.6, 0],
        p2: [482.6, 44.45],
        dim_point: [500, 22.225],
      },
      {
        id: 'dim-mount-pitch',
        layer: 'dimensions',
        type: 'dim',
        p1: [8.5, 38.1],
        p2: [474.1, 38.1],
        dim_point: [241.3, 56],
      },
      {
        id: 'title',
        layer: 'dimensions',
        type: 'text',
        position: [148, -26],
        height: 4,
        rotation: 0,
        text: 'EIA-310 19-INCH 1U PANEL (482.6 x 44.45 MM)',
      },
    ],
  };
}

export const PRESET_BUILDERS = {
  slotted: buildSlottedPlateBlueprint,
  nema17: buildNema17MountBlueprint,
  dn50: buildIsoDn50FlangeBlueprint,
  rack1u: buildEia1uRackPanelBlueprint,
  fault: flawedCncBracketExample,
};
