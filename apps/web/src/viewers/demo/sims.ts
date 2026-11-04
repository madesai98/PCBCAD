import type {
  AirflowResult,
  Board,
  CircuitTransientResult,
  DesignIssue,
  MixedSignalResult,
  PcbThermalResult,
  SimSummary,
  StructuralResult,
  Vec2,
  Vec3,
  Waveform,
} from '@pcbcad/core';
import { pack, pointInPolygon } from '@pcbcad/core';

const cid = (board: Board, ref: string) => board.components.find((c) => c.ref === ref)?.id ?? ref;
const net = (board: Board, name: string) => board.nets.find((n) => n.name === name)?.id ?? name;

/* -------------------------------------------- PCB thermal ---------------------------------------- */

export function demoThermal(board: Board, ambient = 25): PcbThermalResult {
  const dx = 0.5;
  const nx = 120;
  const ny = 80;
  const src: { ref: string; P: number; sigma: number }[] = [
    { ref: 'U2', P: 0.38, sigma: 3.4 },
    { ref: 'D1', P: 0.075, sigma: 2.6 },
    { ref: 'U1', P: 0.042, sigma: 3.2 },
    { ref: 'F1', P: 0.024, sigma: 2.2 },
    { ref: 'Q1', P: 0.012, sigma: 1.6 },
    { ref: 'R6', P: 0.006, sigma: 1.2 },
  ];
  const at = (ref: string) => {
    const c = board.components.find((x) => x.ref === ref)!;
    return [c.x, c.y] as Vec2;
  };
  const totalP = src.reduce((s, x) => s + x.P, 0);
  const temp = new Float32Array(nx * ny);
  const mask = new Uint8Array(nx * ny);
  let maxT = -Infinity;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * dx;
      const y = (j + 0.5) * dx;
      const inside = pointInPolygon([x, y], board.outline);
      mask[j * nx + i] = inside ? 1 : 0;
      let t = ambient + totalP * 9.5;
      for (const s of src) {
        const [cx, cy] = at(s.ref);
        const r2 = (x - cx) ** 2 + (y - cy) ** 2;
        t += s.P * (58 * Math.exp(-r2 / (2 * s.sigma ** 2)) + 28 / (1 + Math.sqrt(r2) / 4.5));
      }
      // Edges run slightly cooler (fin effect).
      const edge = Math.min(x, y, 60 - x, 40 - y);
      t -= 1.4 * Math.exp(-edge / 3);
      temp[j * nx + i] = t;
      if (inside && t > maxT) maxT = t;
    }
  const sample = (x: number, y: number) => temp[Math.min(ny - 1, Math.max(0, Math.floor(y / dx))) * nx + Math.min(nx - 1, Math.max(0, Math.floor(x / dx)))];
  const comps = src.map((s) => {
    const [x, y] = at(s.ref);
    const tBoard = sample(x, y);
    const thetaJC = s.ref === 'U2' ? 15 : s.ref === 'U1' ? 28 : 40;
    const tCase = tBoard + s.P * 6;
    const tJ = tCase + s.P * thetaJC;
    const tjMax = s.ref === 'U2' ? 125 : 150;
    return { componentId: cid(board, s.ref), ref: s.ref, power: s.P, tBoard, tCase, tJunction: tJ, tjMax, status: (tJ > tjMax * 0.85 ? 'fail' : tJ > tjMax * 0.6 ? 'warn' : 'ok') as 'ok' | 'warn' | 'fail' };
  });
  // Low-power parts for completeness.
  for (const ref of ['U3', 'C1', 'C2']) {
    const [x, y] = at(ref);
    const tb = sample(x, y);
    comps.push({ componentId: cid(board, ref), ref, power: ref === 'U3' ? 0.001 : 0, tBoard: tb, tCase: tb, tJunction: tb + 0.05, tjMax: 85, status: 'ok' });
  }
  const currents: Record<string, number> = { VBUS: 0.21, VBUS_F: 0.21, VIN: 0.21, '+3V3': 0.16, AVCC: 0.004, BUZ_N: 0.36, LED_A: 0.0042, LED: 0.0042, BUZ_PWM: 0.002, Q1_G: 0.0005 };
  const traces: PcbThermalResult['traces'] = [];
  for (const t of board.traces) {
    const n = board.nets.find((x) => x.id === t.netId)?.name ?? '';
    const I = currents[n] ?? 0.0008;
    for (let s = 0; s + 1 < t.points.length; s++) {
      const len = Math.hypot(t.points[s + 1][0] - t.points[s][0], t.points[s + 1][1] - t.points[s][1]);
      const area = t.width * 0.035; // mm² (1 oz)
      const J = I / area;
      const areaMil2 = area / 0.000645;
      const ipc = 0.048 * Math.pow(10, 0.44) * Math.pow(areaMil2, 0.725);
      const rise = Math.pow(I / (0.048 * Math.pow(areaMil2, 0.725)), 1 / 0.44);
      const R = (1.72e-8 * (len / 1000)) / (area * 1e-6);
      traces.push({ traceId: t.id, netId: t.netId, segment: s, current: I, currentDensity: J, tempRise: rise, ipcCapacity: ipc, voltageDrop: I * R, status: J > 50 ? 'fail' : J > 30 ? 'warn' : 'ok' });
    }
  }
  return {
    kind: 'pcb-thermal',
    boardId: board.id,
    ambient,
    convection: { mode: 'natural', hTop: 9.5, hBottom: 4.8 },
    grid: { nx, ny, x0: 0, y0: 0, dx, dy: dx },
    mask: pack(mask),
    layers: [
      { layer: 'top', temperature: pack(temp) },
      { layer: 'bottom', temperature: pack(temp.map((v) => ambient + (v - ambient) * 0.86)) },
    ],
    components: comps,
    traces,
    netDrops: [
      { netId: net(board, '+3V3'), name: '+3V3', maxDrop: 0.0118, current: 0.16 },
      { netId: net(board, 'VIN'), name: 'VIN', maxDrop: 0.0061, current: 0.21 },
    ],
    maxTemp: maxT,
    totalPower: totalP,
  };
}

/* --------------------------------------------- structural ---------------------------------------- */

export function demoStructural(): StructuralResult {
  const h = 1;
  const origin: Vec3 = [-35, -25, 0];
  const nx = 70;
  const ny = 50;
  const nz = 16;
  const W = 70;
  const D = 50;
  const r = 5;
  const wall = 2;
  const bosses: [number, number, number][] = [
    [-26.5, -16.5, 7],
    [26.5, -16.5, 7],
    [-26.5, 16.5, 7],
    [26.5, 16.5, 7],
    [-31, -21, 16],
    [31, -21, 16],
    [-31, 21, 16],
    [31, 21, 16],
  ];
  const insideRR = (x: number, y: number, w: number, d: number, rr: number) => {
    const qx = Math.abs(x) - (w / 2 - rr);
    const qy = Math.abs(y) - (d / 2 - rr);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr <= 0;
  };
  const solid: number[] = [];
  const vm: number[] = [];
  const disp: number[] = [];
  let maxV = 0;
  let maxAt: Vec3 = [0, 0, 0];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const x = origin[0] + (i + 0.5) * h;
        const y = origin[1] + (j + 0.5) * h;
        const z = origin[2] + (k + 0.5) * h;
        if (!insideRR(x, y, W, D, r)) continue;
        const inner = insideRR(x, y, W - 2 * wall, D - 2 * wall, r - wall);
        let s = false;
        if (z < wall) s = true;
        else if (!inner) s = true;
        for (const [bx, by, bh] of bosses) if (z < bh && Math.hypot(x - bx, y - by) < 3.1 && Math.hypot(x - bx, y - by) > 1.6) s = true;
        // USB opening on -x wall and vent slots on -y wall.
        if (s && x < -W / 2 + wall + 0.1 && Math.abs(y) < 4.8 && z > 8.3 && z < 12.1) s = false;
        if (s && y < -D / 2 + wall + 0.1 && z > 4 && z < 12 && Math.abs(((x + 12.8 + 1.6) % 3.2) - 1.6) < 0.8 && Math.abs(x) < 15) s = false;
        if (!s) continue;
        solid.push(i + nx * (j + ny * k));
        // Load case: 40 N pressed on the cover centre, base fixed on the bracket screws.
        let v = 0.6 + 2.4 * (1 - Math.min(1, Math.hypot(x / 35, y / 25))) * (z < wall ? 1 : 0.35);
        for (const [bx, by, bh] of bosses.slice(0, 4)) {
          const d2 = (x - bx) ** 2 + (y - by) ** 2;
          v += 9.5 * Math.exp(-d2 / (2 * 2.2 ** 2)) * Math.exp(-((z - wall) ** 2) / (2 * 1.6 ** 2));
          void bh;
        }
        // Stress concentration at the USB opening corners.
        for (const [cy, cz] of [
          [-4.8, 8.3],
          [4.8, 8.3],
          [-4.8, 12.1],
          [4.8, 12.1],
        ])
          if (x < -W / 2 + wall + 0.5) v += 13 * Math.exp(-((y - cy) ** 2 + (z - cz) ** 2) / (2 * 1.1 ** 2));
        // Long-wall bending near the floor joint.
        if (!inner && z < 5) v += 3.2 * Math.exp(-(x * x) / (2 * 18 ** 2)) * (1 - z / 5);
        v *= 1 + 0.04 * Math.sin(i * 1.7 + j * 2.3 + k * 0.9);
        vm.push(v);
        const dz = -0.042 * (1 - Math.min(1, (x / 35) ** 2 + (y / 25) ** 2));
        disp.push(0, 0, dz);
        if (v > maxV) {
          maxV = v;
          maxAt = [x, y, z];
        }
      }
  const yieldPa = 53 * 0.85;
  return {
    kind: 'structural',
    title: 'Cover press 40 N, base fixed at bracket',
    grid: { nx, ny, nz, h, origin },
    solid: pack(new Uint32Array(solid)),
    vonMises: pack(new Float32Array(vm)),
    displacement: pack(new Float32Array(disp)),
    maxVonMises: maxV,
    maxDisplacement: 0.042,
    minSafetyFactor: yieldPa / maxV,
    maxStressAt: maxAt,
    loads: ['40 N on cover centre (−Z)'],
    fixtures: ['Bracket screws (2× M3)'],
    massGrams: 21.4,
    solver: { iterations: 412, residual: 8.7e-7, dofs: solid.length * 3, converged: true },
    materials: [{ id: 'pc-abs', name: 'PC/ABS', E: 2300, yieldStrength: 53 }],
  };
}

/* ---------------------------------------------- airflow ------------------------------------------ */

export function demoAirflow(ambient = 25): AirflowResult {
  const h = 2;
  const origin: Vec3 = [-35, -25, 0];
  const nx = 35;
  const ny = 25;
  const nz = 12;
  const N = nx * ny * nz;
  const ldo: [number, number] = [-8, 13.5];
  const mcu: [number, number] = [7, -2];
  const vel = (x: number, y: number, z: number): Vec3 => {
    const rl = Math.hypot(x - ldo[0], y - ldo[1]);
    const rm = Math.hypot(x - mcu[0], y - mcu[1]);
    let vz = 0.055 * Math.exp(-(rl * rl) / (2 * 8 ** 2)) + 0.016 * Math.exp(-(rm * rm) / (2 * 7 ** 2));
    if (z > 18) vz *= Math.max(0, (22 - z) / 4);
    const vy = 0.028 + 0.018 * Math.min(1, Math.max(0, (z - 9) / 10)) - 0.012 * Math.exp(-(rl * rl) / (2 * 6 ** 2));
    const vx = 0.012 * Math.sin(((y + 25) / 50) * Math.PI) * Math.tanh(x / 8) - 0.01 * Math.tanh((x - ldo[0]) / 6) * Math.exp(-(rl * rl) / (2 * 10 ** 2));
    return [vx, vy, vz];
  };
  const cells = new Uint8Array(N);
  const temperature = new Float32Array(N);
  const velocity = new Float32Array(N * 3);
  let maxAir = 0;
  let sumAir = 0;
  let nAir = 0;
  let maxSolid = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        const x = origin[0] + (i + 0.5) * h;
        const y = origin[1] + (j + 0.5) * h;
        const z = origin[2] + (k + 0.5) * h;
        const wallCell = i === 0 || j === 0 || i === nx - 1 || j === ny - 1 || k === 0 || k === nz - 1;
        const boardCell = (k === 3 || k === 4) && Math.abs(x) < 30 && Math.abs(y) < 20;
        const vent = (j === 0 && k >= 2 && k <= 5 && Math.abs(x) < 14) || (k === nz - 1 && x < -1 && x > -27 && y > 1 && y < 15);
        cells[c] = vent ? 0 : wallCell ? 1 : boardCell ? 2 : 0;
        const rl = Math.hypot(x - ldo[0], y - ldo[1]);
        const plume = 21 * Math.exp(-(rl * rl) / (2 * 7.5 ** 2)) * Math.exp(-((z - 11) ** 2) / (2 * 6 ** 2));
        const rise = 7 * Math.min(1, z / 22) * (0.5 + 0.5 * Math.min(1, (y + 25) / 50));
        let t = ambient + 2.5 + plume + rise + 3 * Math.exp(-(Math.hypot(x - 7, y + 2) ** 2) / 120);
        if (cells[c] === 2) t += 6 + 18 * Math.exp(-(rl * rl) / 30);
        if (cells[c] === 1) t = ambient + 3 + (t - ambient) * 0.35;
        temperature[c] = t;
        if (cells[c] === 0) {
          const v = vel(x, y, z);
          velocity[c * 3] = v[0];
          velocity[c * 3 + 1] = v[1];
          velocity[c * 3 + 2] = v[2];
          maxAir = Math.max(maxAir, t);
          sumAir += t;
          nAir++;
        } else maxSolid = Math.max(maxSolid, t);
      }
  // Streamlines: RK2 from the side inlet, rising over the regulator and leaving through the cover vents.
  const streamlines: Vec3[][] = [];
  for (const z0 of [11.5, 14, 16.5])
    for (let x0 = -26; x0 <= 26; x0 += 6.5) {
      const line: Vec3[] = [];
      let p: Vec3 = [x0, -23, z0];
      for (let s = 0; s < 260; s++) {
        line.push([+p[0].toFixed(2), +p[1].toFixed(2), +p[2].toFixed(2)]);
        const v1 = vel(p[0], p[1], p[2]);
        const sp = Math.hypot(...v1) || 1e-6;
        const stepLen = 1.1;
        const mid: Vec3 = [p[0] + (v1[0] / sp) * stepLen * 0.5, p[1] + (v1[1] / sp) * stepLen * 0.5, p[2] + (v1[2] / sp) * stepLen * 0.5];
        const v2 = vel(mid[0], mid[1], mid[2]);
        const sp2 = Math.hypot(...v2) || 1e-6;
        p = [p[0] + (v2[0] / sp2) * stepLen, p[1] + (v2[1] / sp2) * stepLen, Math.min(21.5, p[2] + (v2[2] / sp2) * stepLen)];
        if (p[1] > 22.5 || Math.abs(p[0]) > 33) break;
        if (p[2] >= 21.4 && p[0] < -1 && p[0] > -27 && p[1] > 1 && p[1] < 15) {
          line.push([p[0], p[1], 24.5]);
          break;
        }
      }
      if (line.length > 4) streamlines.push(line);
    }
  return {
    kind: 'airflow',
    mode: 'natural',
    ambient,
    grid: { nx, ny, nz, h, origin },
    cells: pack(cells),
    temperature: pack(temperature),
    velocity: pack(velocity),
    streamlines,
    components: [
      { componentId: 'cmp_main_u2', ref: 'U2', power: 0.38, temperature: 58.6 },
      { componentId: 'cmp_main_u1', ref: 'U1', power: 0.042, temperature: 37.9 },
      { componentId: 'cmp_main_u3', ref: 'U3', power: 0.001, temperature: 33.2 },
    ],
    vents: [
      { name: 'Side slots (−Y)', flowM3s: 2.4e-5, direction: 'in' },
      { name: 'Cover slots', flowM3s: 2.4e-5, direction: 'out' },
    ],
    maxAirTemp: maxAir,
    meanAirTemp: sumAir / Math.max(1, nAir),
    maxSolidTemp: maxSolid,
    heatBalance: { input: 0.54, vents: 0.23, walls: 0.31 },
    iterations: 640,
    converged: true,
  };
}

/* ------------------------------------------- transient ------------------------------------------- */

export function demoTransient(board: Board): CircuitTransientResult {
  const n = 2400;
  const T = 0.02;
  const time = new Float64Array(n);
  const vbus = new Float32Array(n);
  const vin = new Float32Array(n);
  const v33 = new Float32Array(n);
  const ibus = new Float32Array(n);
  const pldo = new Float32Array(n);
  const reset = new Float32Array(n);
  const led = new Float32Array(n);
  const buz = new Float32Array(n);
  let v3 = 0;
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * T;
    time[i] = t;
    const tp = t - 0.001;
    const vb = tp <= 0 ? 0 : 5 * (1 - Math.exp(-tp / 0.00045)) + 0.42 * Math.exp(-tp / 0.00028) * Math.sin(2 * Math.PI * 7000 * tp);
    vbus[i] = vb;
    const load = 0.018 + (t > 0.012 ? 0.17 * (Math.floor(t * 4000) % 2) : 0) + (t > 0.008 && t < 0.014 ? 0.004 : 0);
    const inrush = tp > 0 ? 0.95 * Math.exp(-tp / 0.00022) * (1 - Math.exp(-tp / 0.00004)) : 0;
    const iin = Math.max(0, inrush + (vb > 1 ? load : 0));
    ibus[i] = iin;
    const vi = Math.max(0, vb - 0.3 - 0.4 * iin);
    vin[i] = vi;
    const target = Math.max(0, Math.min(3.3, vi - 1.1));
    v3 += (target - v3) * Math.min(1, (T / n) / 0.00032);
    v33[i] = v3 - (t > 0.012 ? 0.035 * (Math.floor(t * 4000) % 2) : 0);
    pldo[i] = Math.max(0, (vi - v33[i]) * (vb > 1 ? load : 0));
    reset[i] = t > 0.0042 ? 1 : 0;
    led[i] = t > 0.008 && t < 0.016 ? 1 : 0;
    buz[i] = t > 0.012 ? Math.floor(t * 4000) % 2 : 0;
  }
  const wf = (name: string, kind: Waveform['kind'], unit: string, data: Float32Array, netName?: string): Waveform => ({ name, kind, unit, netId: netName ? net(board, netName) : undefined, data: pack(data) });
  return {
    kind: 'circuit-transient',
    time: pack(time, 'f64'),
    signals: [
      wf('VBUS', 'voltage', 'V', vbus, 'VBUS'),
      wf('VIN', 'voltage', 'V', vin, 'VIN'),
      wf('+3V3', 'voltage', 'V', v33, '+3V3'),
      wf('I(J1.VBUS)', 'current', 'A', ibus),
      wf('P(U2)', 'power', 'W', pldo),
      wf('~RESET', 'digital', '', reset, 'RESET'),
      wf('PB5 · LED', 'digital', '', led, 'LED'),
      wf('PD6 · BUZ', 'digital', '', buz, 'BUZ_PWM'),
    ],
    avgPower: { [cid(board, 'U2')]: 0.061, [cid(board, 'D1')]: 0.012 },
    netNames: Object.fromEntries(board.nets.map((x) => [x.id, `main/${x.name}`])),
    warnings: ['Inrush peak 0.94 A for 0.3 ms — within USB 2.0 limits'],
  };
}

/* ------------------------------------------ mixed-signal ----------------------------------------- */

function uartFrames(text: string, t0: number, baud: number): [number, number][] {
  const bit = 1 / baud;
  const out: [number, number][] = [];
  let t = t0;
  let level = 1;
  const set = (time: number, l: number) => {
    if (l !== level) {
      out.push([time, l]);
      level = l;
    }
  };
  for (const ch of text) {
    const code = ch.charCodeAt(0) & 0xff;
    set(t, 0);
    for (let b = 0; b < 8; b++) set(t + (b + 1) * bit, (code >> b) & 1);
    set(t + 9 * bit, 1);
    t += 10 * bit + bit * 0.5;
  }
  return out;
}

export function demoMixed(board: Board): MixedSignalResult {
  const duration = 2.0;
  const lines = ['ENV-NODE fw 1.2.0 (avr8js)', 'BME280 id=0x60 OK', 'T=23.41C RH=41.2% P=1013.18hPa', 'T=23.43C RH=41.1% P=1013.20hPa', 'T=23.47C RH=41.1% P=1013.19hPa', 'alarm: buzzer test', 'T=23.52C RH=41.0% P=1013.21hPa'];
  const times = [0.004, 0.012, 0.31, 0.81, 1.31, 1.42, 1.81];
  let tx: [number, number][] = [[0, 1]];
  lines.forEach((l, i) => (tx = tx.concat(uartFrames(l + '\r\n', times[i], 115200))));
  const ledT: [number, number][] = [[0, 0]];
  for (let t = 0.25, on = 1; t < duration; t += 0.25, on ^= 1) ledT.push([t, on]);
  const scl: [number, number][] = [[0, 1]];
  const sda: [number, number][] = [[0, 1]];
  for (const t0 of [0.01, 0.3, 0.8, 1.3, 1.8]) {
    // START, 27 clocked bits, STOP at 100 kHz.
    let t = t0;
    sda.push([t, 0]);
    t += 5e-6;
    scl.push([t, 0]);
    for (let b = 0; b < 27; b++) {
      sda.push([t + 1e-6, (b * 7 + Math.round(t0 * 10)) % 3 === 0 ? 0 : 1]);
      scl.push([t + 5e-6, 1]);
      scl.push([t + 10e-6, 0]);
      t += 10e-6;
    }
    sda.push([t + 1e-6, 0]);
    scl.push([t + 5e-6, 1]);
    sda.push([t + 8e-6, 1]);
  }
  const buz: [number, number][] = [[0, 0]];
  for (let t = 1.42, on = 1; t < 1.62; t += 0.00025, on ^= 1) buz.push([t, on]);
  buz.push([1.62, 0]);
  const rst: [number, number][] = [
    [0, 0],
    [0.0021, 1],
  ];
  const intr: [number, number][] = [
    [0, -1],
    [0.0123, 1],
    [0.29, 0],
    [0.2905, 1],
    [0.79, 0],
    [0.7904, 1],
    [1.29, 0],
    [1.2906, 1],
    [1.79, 0],
    [1.7903, 1],
  ];
  const u1 = cid(board, 'U1');
  const n = 2000;
  const time = new Float64Array(n);
  const v33 = new Float32Array(n);
  const i33 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * duration;
    time[i] = t;
    const buzzing = t > 1.42 && t < 1.62;
    const ledOn = Math.floor(t / 0.25) % 2 === 1;
    const load = 0.0135 + (ledOn ? 0.0042 : 0) + (buzzing ? 0.17 : 0) + 0.0006 * Math.sin(t * 900);
    i33[i] = load;
    v33[i] = 3.3 - load * 0.09 + 0.002 * Math.sin(t * 3100);
  }
  return {
    kind: 'mixed-signal',
    duration,
    wallMs: 1840,
    uart: [{ componentId: u1, ref: 'U1', port: 'USART0 · PD1/TXD', text: lines.map((l) => l + '\r\n').join('') }],
    digital: [
      { name: 'PB5 · LED', componentId: u1, pin: '17', transitions: ledT },
      { name: 'PD1 · TXD', componentId: u1, pin: '31', transitions: tx },
      { name: 'PC5 · SCL', componentId: u1, pin: '28', transitions: scl },
      { name: 'PC4 · SDA', componentId: u1, pin: '27', transitions: sda },
      { name: 'PD6 · BUZ', componentId: u1, pin: '10', transitions: buz },
      { name: 'PD2 · INT', componentId: u1, pin: '32', transitions: intr },
      { name: '~RESET', componentId: u1, pin: '29', transitions: rst },
    ],
    analog: {
      time: pack(time, 'f64'),
      signals: [
        { name: '+3V3', kind: 'voltage', unit: 'V', netId: net(board, '+3V3'), data: pack(v33) },
        { name: 'I(+3V3)', kind: 'current', unit: 'A', data: pack(i33) },
      ],
    },
    indicators: [
      { componentId: cid(board, 'D2'), ref: 'D2', color: '#22c55e', onFraction: 0.5, meanCurrent: 0.0021 },
      { componentId: 'cmp_sat_d1', ref: 'Probe D1', color: '#ef4444', onFraction: 1, meanCurrent: 0.0012 },
      { componentId: cid(board, 'BZ1'), ref: 'BZ1', color: '#f59e0b', onFraction: 0.1, meanCurrent: 0.017 },
    ],
    log: [
      { t: 0.0021, source: 'U1', level: 'info', msg: 'Reset released, firmware env-node-1.2.0.hex started' },
      { t: 0.0123, source: 'I2C', level: 'info', msg: 'BME280 @0x76 chip-id 0x60' },
      { t: 0.3, source: 'I2C', level: 'warn', msg: 'NACK from 0x77 (probe board address strap?) — retried on 0x76' },
      { t: 1.42, source: 'U1', level: 'info', msg: 'Buzzer self-test 2.0 kHz, 200 ms' },
      { t: 1.43, source: 'Q1', level: 'info', msg: 'Peak drain current 172 mA, P = 9 mW' },
      { t: 1.9, source: 'sim', level: 'info', msg: '32.0 M cycles in 1.84 s wall (17.4 MHz effective)' },
    ],
    mcus: [{ componentId: u1, ref: 'U1', emulator: 'avr:atmega328p', firmware: 'env-node-1.2.0.hex', cycles: 32_000_000, clockHz: 16e6, status: 'running' }],
    avgPower: { [u1]: 0.042, [cid(board, 'U2')]: 0.09 },
    warnings: ['I2C bus capacitance near limit with the 15 cm probe cable (4.7 kΩ pull-ups)'],
  };
}

/* --------------------------------------------- issues -------------------------------------------- */

export function demoIssues(board: Board): DesignIssue[] {
  const pad = (ref: string) => {
    const c = board.components.find((x) => x.ref === ref)!;
    return [c.x, c.y] as Vec2;
  };
  const q1 = pad('Q1');
  const d4 = pad('D4');
  return [
    { id: 'iss_unrouted', severity: 'error', category: 'drc', code: 'unrouted', message: 'Net BUZ_N has 1 unrouted connection (Q1.D ↔ D4.A)', target: { boardId: board.id, netIds: [net(board, 'BUZ_N')] }, at: [(q1[0] + d4[0]) / 2, (q1[1] + d4[1]) / 2 + 1.5], suggestion: 'Run auto_route on BUZ_N or add a 0.4 mm trace on the top layer.' },
    { id: 'iss_silk', severity: 'warning', category: 'dfm', code: 'silk-over-pad', message: 'Silkscreen reference R8 overlaps an exposed pad (clipped at fab)', target: { boardId: board.id, componentIds: [cid(board, 'R8')] }, at: [29, 11.4] },
    { id: 'iss_heat', severity: 'warning', category: 'sim', code: 'sensor-self-heating', message: 'BME280 (U3) is 32 mm from U2 dissipating 0.38 W — readings biased ≈ +1.5 °C', target: { boardId: board.id, componentIds: [cid(board, 'U3')] }, suggestion: 'Add a thermal slot or move U3 near the vent.' },
    { id: 'iss_pins', severity: 'info', category: 'erc', code: 'unused-pins', message: '17 MCU pins are unconnected (marked no-connect)', target: { boardId: board.id, componentIds: [cid(board, 'U1')] } },
  ];
}

export function demoSummary(th: PcbThermalResult): SimSummary {
  const hot = [...th.components].sort((a, b) => b.tJunction - a.tJunction)[0];
  return {
    headline: `Max junction ${hot.tJunction.toFixed(1)} °C (${hot.ref}, LDO) — OK`,
    metrics: [
      { label: 'Max board', value: th.maxTemp, unit: '°C', status: 'ok', limit: 85 },
      { label: 'Tj U2', value: hot.tJunction, unit: '°C', status: hot.status, limit: hot.tjMax },
      { label: 'Total power', value: th.totalPower, unit: 'W' },
      { label: 'Peak density', value: Math.max(...th.traces.map((t) => t.currentDensity)), unit: 'A/mm²', status: 'warn', limit: 30 },
    ],
    warnings: ['BUZ_N trace (0.25 mm) carries 0.36 A — widen to ≥ 0.4 mm', 'Sensor U3 sits in the regulator plume'],
    pass: true,
  };
}
