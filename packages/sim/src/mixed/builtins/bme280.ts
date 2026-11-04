/**
 * builtin:bme280 — Bosch BME280 humidity / pressure / temperature sensor (I2C + 4-wire SPI).
 *
 * Register-accurate model: chip id 0xD0 = 0x60, soft reset 0xE0 (0xB6), ctrl_hum 0xF2,
 * status 0xF3 (measuring / im_update), ctrl_meas 0xF4 (sleep / forced / normal), config 0xF5,
 * calibration NVM 0x88..0xA1 and 0xE1..0xE7 with typical values, and raw ADC registers 0xF7..0xFE.
 * The raw ADC values are obtained by inverting the datasheet integer compensation (binary search),
 * so firmware using the Bosch formulas reads back chip.params.temperatureC / pressurePa /
 * humidityPct (exact to the formula resolution: 0.01 °C, 1/256 Pa, 1/1024 %RH).
 * Measurement timing follows datasheet §9.1 (status.measuring is set while converting).
 * I2C address: 0x76 when SDO is low (or unconnected), 0x77 when high.
 */
export const BME280_CODE = String.raw`
// ---- calibration (typical part) ----
const C = { T1: 27504, T2: 26435, T3: -1000,
  P1: 36477, P2: -10685, P3: 3024, P4: 2855, P5: 140, P6: -7, P7: 15500, P8: -14600, P9: 6000,
  H1: 75, H2: 362, H3: 0, H4: 313, H5: 50, H6: 30 };
const imul = Math.imul;
const pin = (chip, names) => { for (const n of names) if (chip.hasPin(n)) return n; return names[names.length - 1]; };

function compT(adc) {
  const a = ((adc >> 3) - (C.T1 << 1)) | 0;
  const var1 = imul(a, C.T2) >> 11;
  const b = ((adc >> 4) - C.T1) | 0;
  const var2 = imul(imul(b, b) >> 12, C.T3) >> 14;
  const tf = (var1 + var2) | 0;
  return [(imul(tf, 5) + 128) >> 8, tf];
}
function compP(adc, tf) {
  let var1 = BigInt(tf) - 128000n;
  let var2 = var1 * var1 * BigInt(C.P6);
  var2 = var2 + ((var1 * BigInt(C.P5)) << 17n);
  var2 = var2 + (BigInt(C.P4) << 35n);
  var1 = ((var1 * var1 * BigInt(C.P3)) >> 8n) + ((var1 * BigInt(C.P2)) << 12n);
  var1 = (((1n << 47n) + var1) * BigInt(C.P1)) >> 33n;
  if (var1 === 0n) return 0;
  let p = 1048576n - BigInt(adc);
  p = (((p << 31n) - var2) * 3125n) / var1;
  var1 = (BigInt(C.P9) * (p >> 13n) * (p >> 13n)) >> 25n;
  var2 = (BigInt(C.P8) * p) >> 19n;
  p = ((p + var1 + var2) >> 8n) + (BigInt(C.P7) << 4n);
  return Number(p);
}
function compH(adc, tf) {
  let v = (tf - 76800) | 0;
  const x = (((((adc << 14) - (C.H4 << 20) - imul(C.H5, v)) | 0) + 16384) | 0) >> 15;
  const y1 = imul(v, C.H6) >> 10;
  const y2 = ((imul(v, C.H3) >> 11) + 32768) | 0;
  const y3 = ((imul(y1, y2) >> 10) + 2097152) | 0;
  const y4 = (imul(y3, C.H2) + 8192) >> 14;
  v = imul(x, y4);
  v = (v - (imul(imul(v >> 15, v >> 15) >> 7, C.H1) >> 4)) | 0;
  if (v < 0) v = 0;
  if (v > 419430400) v = 419430400;
  return v >> 12;
}
// x in [lo, hi] whose f(x) is nearest to target (f non-decreasing; binary search + neighbour check)
function nearest(lo, hi, f, target) {
  const lo0 = lo;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (f(mid) >= target) hi = mid; else lo = mid + 1; }
  if (lo > lo0 && Math.abs(f(lo - 1) - target) <= Math.abs(f(lo) - target)) lo--;
  return lo;
}
function rawFor(env) {
  const tTarget = Math.round(env.t * 100);
  const adcT = nearest(0, (1 << 20) - 1, (x) => compT(x)[0], tTarget);
  const tf = compT(adcT)[1];
  const pTarget = env.p * 256;
  // pressure decreases with adc: search on the negated function
  const adcP = nearest(0, (1 << 20) - 1, (x) => -compP(x, tf), -pTarget);
  const hTarget = Math.min(100, Math.max(0, env.h)) * 1024;
  const adcH = nearest(0, 65535, (x) => compH(x, tf), hTarget);
  return { adcT, adcP, adcH };
}

function resetRegs(s) {
  const r = new Array(256).fill(0);
  const put16 = (a, v) => { r[a] = v & 0xff; r[a + 1] = (v >> 8) & 0xff; };
  put16(0x88, C.T1); put16(0x8a, C.T2); put16(0x8c, C.T3);
  put16(0x8e, C.P1); put16(0x90, C.P2); put16(0x92, C.P3); put16(0x94, C.P4); put16(0x96, C.P5);
  put16(0x98, C.P6); put16(0x9a, C.P7); put16(0x9c, C.P8); put16(0x9e, C.P9);
  r[0xa1] = C.H1;
  put16(0xe1, C.H2); r[0xe3] = C.H3;
  r[0xe4] = (C.H4 >> 4) & 0xff; r[0xe5] = (C.H4 & 0x0f) | ((C.H5 & 0x0f) << 4); r[0xe6] = (C.H5 >> 4) & 0xff;
  r[0xe7] = C.H6 & 0xff;
  r[0xd0] = 0x60;
  r[0xf7] = 0x80; r[0xfa] = 0x80; r[0xfd] = 0x80;
  s.regs = r;
  s.ptr = 0; s.expectReg = true; s.measureEnd = -1; s.osrsH = 0; s.normalStart = -1;
}
const OS = [0, 1, 2, 4, 8, 16, 16, 16];
const STANDBY = [0.0005, 0.0625, 0.125, 0.25, 0.5, 1.0, 0.01, 0.02];
function measTime(s) {
  const ctrl = s.regs[0xf4];
  const ot = OS[(ctrl >> 5) & 7], op = OS[(ctrl >> 2) & 7], oh = OS[s.osrsH];
  return (1.25 + 2.3 * ot + (op ? 2.3 * op + 0.575 : 0) + (oh ? 2.3 * oh + 0.575 : 0)) / 1000;
}
function env(chip) {
  const p = chip.params;
  return {
    t: typeof p.temperatureC === 'number' ? p.temperatureC : 25,
    p: typeof p.pressurePa === 'number' ? p.pressurePa : 101325,
    h: typeof p.humidityPct === 'number' ? p.humidityPct : 50,
  };
}
function latch(chip) {
  const s = chip.state, r = s.regs, ctrl = r[0xf4];
  const raw = rawFor(env(chip));
  const ot = (ctrl >> 5) & 7, op = (ctrl >> 2) & 7;
  const aT = ot ? raw.adcT : 0x80000, aP = op ? raw.adcP : 0x80000, aH = s.osrsH ? raw.adcH : 0x8000;
  r[0xf7] = (aP >> 12) & 0xff; r[0xf8] = (aP >> 4) & 0xff; r[0xf9] = (aP & 0xf) << 4;
  r[0xfa] = (aT >> 12) & 0xff; r[0xfb] = (aT >> 4) & 0xff; r[0xfc] = (aT & 0xf) << 4;
  r[0xfd] = (aH >> 8) & 0xff; r[0xfe] = aH & 0xff;
  s.measurements = (s.measurements || 0) + 1;
}
// bring the model up to chip.time (forced measurement completion, normal-mode cycling)
function update(chip) {
  const s = chip.state, r = s.regs, t = chip.time;
  const mode = r[0xf4] & 3;
  if (s.measureEnd >= 0 && t >= s.measureEnd) {
    latch(chip);
    s.measureEnd = -1;
    if (mode === 1 || mode === 2) r[0xf4] &= ~3; // forced -> sleep
  }
  if (mode === 3 && s.normalStart >= 0 && s.measureEnd < 0) {
    const period = measTime(s) + STANDBY[(r[0xf5] >> 5) & 7];
    const n = Math.floor((t - s.normalStart) / period);
    s.measureEnd = s.normalStart + n * period + measTime(s);
    if (t >= s.measureEnd) { latch(chip); s.measureEnd = s.normalStart + (n + 1) * period + measTime(s); }
  }
  r[0xf3] = (s.measureEnd >= 0 && t < s.measureEnd && (mode !== 3 || t >= s.measureEnd - measTime(s))) ? 0x08 : 0x00;
}
function writeReg(chip, reg, v) {
  const s = chip.state, r = s.regs;
  update(chip);
  if (reg === 0xe0) { if (v === 0xb6) resetRegs(s); return; }
  if (reg === 0xf2) { r[0xf2] = v & 0x07; return; }
  if (reg === 0xf5) { r[0xf5] = v & 0xfd; return; }
  if (reg === 0xf4) {
    r[0xf4] = v;
    s.osrsH = r[0xf2] & 7; // ctrl_hum takes effect after a ctrl_meas write
    const mode = v & 3;
    if (mode === 1 || mode === 2) { s.measureEnd = chip.time + measTime(s); s.normalStart = -1; }
    else if (mode === 3) { s.normalStart = chip.time; s.measureEnd = -1; }
    else { s.normalStart = -1; }
    update(chip);
  }
}
function readReg(chip, reg) {
  update(chip);
  return chip.state.regs[reg & 0xff];
}

return {
  name: 'BME280',
  setup(chip) { resetRegs(chip.state); },
  i2c: {
    sda: ['SDA', 'SDI', 3],
    scl: ['SCL', 'SCK', 4],
    address(chip) {
      const sdo = pin(chip, ['SDO', 5]);
      return chip.read(sdo) ? 0x77 : 0x76;
    },
    start(chip, read) { chip.state.expectReg = !read; },
    write(chip, b) {
      const s = chip.state;
      if (s.expectReg) { s.ptr = b; s.expectReg = false; }
      else { writeReg(chip, s.ptr, b); s.expectReg = true; }
      return true;
    },
    read(chip) {
      const s = chip.state;
      const v = readReg(chip, s.ptr);
      s.ptr = (s.ptr + 1) & 0xff;
      return v;
    },
    stop(chip) { chip.state.expectReg = true; },
  },
  spi: {
    sck: ['SCK', 'SCL', 4], mosi: ['SDI', 'SDA', 3], miso: ['SDO', 5], cs: ['CSB', 'CS', 2],
    select(chip, active) { chip.state.spiPhase = active ? 'cmd' : 'idle'; },
    transfer(chip, b) {
      const s = chip.state;
      if (s.spiPhase === 'cmd') { s.spiRead = (b & 0x80) !== 0; s.ptr = b | 0x80; s.spiPhase = 'data'; return 0xff; }
      if (s.spiRead) { const v = readReg(chip, s.ptr); s.ptr = ((s.ptr + 1) & 0xff) | 0x80; return v; }
      writeReg(chip, s.ptr, b); s.spiPhase = 'cmd'; return 0xff;
    },
  },
};
`;
