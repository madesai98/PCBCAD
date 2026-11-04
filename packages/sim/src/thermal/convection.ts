/**
 * Air properties and heat-transfer coefficient correlations for PCB faces.
 *
 * All functions use SI units: lengths in m, temperatures in °C (converted internally), h in
 * W/(m²·K). Correlations (Incropera & DeWitt, Fundamentals of Heat and Mass Transfer, ch. 7 & 9):
 *  - Horizontal plate, hot face up / cold face down:  Nu = 0.54 Ra^1/4 (Ra ≤ 1e7), 0.15 Ra^1/3 above
 *  - Horizontal plate, hot face down / cold face up:  Nu = 0.27 Ra^1/4
 *    (characteristic length L = A/P for both)
 *  - Vertical plate (Churchill–Chu), L = height:
 *      Ra ≤ 1e9: Nu = 0.68 + 0.670 Ra^1/4 / [1 + (0.492/Pr)^(9/16)]^(4/9)
 *      Ra > 1e9: Nu = {0.825 + 0.387 Ra^1/6 / [1 + (0.492/Pr)^(9/16)]^(8/27)}²
 *  - Forced flow parallel to a flat plate, L = flow length:
 *      Re ≤ 5e5: Nu = 0.664 Re^1/2 Pr^1/3 (laminar), above: Nu = (0.037 Re^4/5 − 871) Pr^1/3 (mixed)
 *  - Radiation, linearised: h_r = ε σ (Ts² + T∞²)(Ts + T∞) (K).
 * The correlations above are applied below their nominal lower Ra bound (1e4) for small boards;
 * this extrapolation is standard practice for PCB estimates (typ. ±25 %).
 */

export const STEFAN_BOLTZMANN = 5.670374419e-8;
const G = 9.80665;
const K0 = 273.15;

export interface AirProperties {
  /** Thermal conductivity, W/(m·K). */
  k: number;
  /** Kinematic viscosity, m²/s. */
  nu: number;
  /** Thermal diffusivity, m²/s. */
  alpha: number;
  /** Prandtl number. */
  pr: number;
  /** Volumetric expansion coefficient (ideal gas, 1/T), 1/K. */
  beta: number;
  /** Density, kg/m³. */
  rho: number;
}

/**
 * Dry air at 1 atm and `tC` °C: Sutherland's law for viscosity (μ0 = 1.716e-5 Pa·s, S = 110.4 K)
 * and conductivity (k0 = 0.0241 W/m·K, S = 194 K), ideal-gas density, cp = 1006 J/(kg·K).
 * Within ±2 % of tabulated values from −20 to 150 °C.
 */
export function airProperties(tC: number): AirProperties {
  const T = Math.max(150, tC + K0);
  const mu = 1.716e-5 * Math.pow(T / K0, 1.5) * ((K0 + 110.4) / (T + 110.4));
  const k = 0.0241 * Math.pow(T / K0, 1.5) * ((K0 + 194) / (T + 194));
  const rho = 101325 / (287.05 * T);
  const cp = 1006;
  const nu = mu / rho;
  const alpha = k / (rho * cp);
  return { k, nu, alpha, pr: nu / alpha, beta: 1 / T, rho };
}

export type FaceKind = 'top' | 'bottom';

/**
 * Natural-convection coefficient of one face of a flat board.
 * @param orientation  'horizontal' (board flat, top face up) or 'vertical'
 * @param face         which face
 * @param deltaT       mean surface temperature minus air temperature (K); sign selects the
 *                     hot-up / hot-down correlation for horizontal plates
 * @param tAir         air temperature (°C)
 * @param lengthM      characteristic length (m): A/P for horizontal, height for vertical plates
 */
export function naturalConvectionH(orientation: 'horizontal' | 'vertical', face: FaceKind, deltaT: number, tAir: number, lengthM: number): number {
  const dT = Math.max(Math.abs(deltaT), 1e-3);
  const L = Math.max(lengthM, 1e-4);
  const air = airProperties(tAir + 0.5 * dT * Math.sign(deltaT || 1));
  const Ra = (G * air.beta * dT * L * L * L) / (air.nu * air.alpha);
  let Nu: number;
  if (orientation === 'vertical') {
    const psi = 1 + Math.pow(0.492 / air.pr, 9 / 16);
    if (Ra <= 1e9) Nu = 0.68 + (0.67 * Math.pow(Ra, 0.25)) / Math.pow(psi, 4 / 9);
    else {
      const s = 0.825 + (0.387 * Math.pow(Ra, 1 / 6)) / Math.pow(psi, 8 / 27);
      Nu = s * s;
    }
  } else {
    // Hot face up (or cold face down) → buoyant plume leaves freely; otherwise the stagnant
    // layer under the plate must spill over the edges.
    const upward = (face === 'top') === deltaT >= 0;
    if (upward) Nu = Ra <= 1e7 ? 0.54 * Math.pow(Ra, 0.25) : 0.15 * Math.pow(Ra, 1 / 3);
    else Nu = 0.27 * Math.pow(Ra, 0.25);
  }
  return (Nu * air.k) / L;
}

/**
 * Forced-convection average coefficient for flow parallel to a flat plate.
 * @param velocity  free-stream air velocity (m/s)
 * @param lengthM   plate length in the flow direction (m)
 * @param tFilm     film temperature (°C)
 */
export function forcedConvectionH(velocity: number, lengthM: number, tFilm: number): number {
  const V = Math.max(velocity, 0);
  const L = Math.max(lengthM, 1e-4);
  const air = airProperties(tFilm);
  const Re = (V * L) / air.nu;
  const pr3 = Math.cbrt(air.pr);
  const Nu = Re <= 5e5 ? 0.664 * Math.sqrt(Re) * pr3 : (0.037 * Math.pow(Re, 0.8) - 871) * pr3;
  return (Math.max(Nu, 0) * air.k) / L;
}

/** Mixed convection: Churchill's cube-root combination of forced and natural coefficients. */
export function mixedConvectionH(hForced: number, hNatural: number): number {
  return Math.cbrt(hForced * hForced * hForced + hNatural * hNatural * hNatural);
}

/** Linearised radiative coefficient (W/m²K) between a surface at tS and surroundings at tInf (°C). */
export function radiationH(emissivity: number, tS: number, tInf: number): number {
  const a = tS + K0;
  const b = tInf + K0;
  return emissivity * STEFAN_BOLTZMANN * (a * a + b * b) * (a + b);
}

/** Exact radiative flux (W/m²) from a surface at tS to surroundings at tInf (°C). */
export function radiationFlux(emissivity: number, tS: number, tInf: number): number {
  const a = tS + K0;
  const b = tInf + K0;
  return emissivity * STEFAN_BOLTZMANN * (a * a * a * a - b * b * b * b);
}
