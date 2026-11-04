/**
 * Shared primitive types.
 *
 * UNIT CONVENTIONS (used everywhere in PCBCAD unless a field name says otherwise):
 *  - Lengths / positions: millimetres (mm)
 *  - Angles: degrees, counter-clockwise positive
 *  - Electrical: SI (V, A, Ω, F, H, W, Hz, s)
 *  - Temperature: °C
 *  - Mechanical stress / modulus: MPa (N/mm²); forces: N; mass: g (grams) on parts, kg in physics helpers
 *  - Density: kg/m³; thermal conductivity: W/(m·K); specific heat: J/(kg·K)
 *
 * COORDINATE FRAMES
 *  - Board frame: X right, Y up (Gerber convention), origin at the lower-left of the outline bbox.
 *    Board 3D frame: bottom copper surface at z = 0, top surface at z = stackup.thickness.
 *  - Footprint frame: origin at the component's placement origin (usually body centre), X right, Y up.
 *    World(pad) = T(x,y) · R(rotation) · (side === 'bottom' ? MirrorX : I) · local
 *  - Mechanical part frame: right-handed, Z up. See mech.ts for per-part conventions.
 *  - Assembly frame: right-handed, Z up, mm.
 */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export type Side = 'top' | 'bottom';

/** Copper layers. 2-layer boards use top/bottom; 4-layer adds in1,in2; 6-layer adds in3,in4. */
export type CopperLayer = 'top' | 'bottom' | 'in1' | 'in2' | 'in3' | 'in4';

export interface BBox2 {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface BBox3 {
  min: Vec3;
  max: Vec3;
}

/**
 * A typed array packed as base64 for JSON transport/storage. Use the pack()/unpack() helpers in packed.ts.
 * Large simulation fields (temperature grids, stresses, meshes) are stored this way.
 */
export interface PackedArray {
  dtype: 'f32' | 'f64' | 'u8' | 'u16' | 'u32' | 'i32';
  length: number;
  b64: string;
}

/** Either a plain JSON number array or a packed typed array. Consumers must accept both (use toFloat32 etc.). */
export type NumArray = number[] | PackedArray;

export interface Transform3 {
  /** translation, mm */
  position: Vec3;
  /** Euler angles in degrees, applied in X, then Y, then Z order (intrinsic XYZ == three.js 'XYZ'). */
  rotation: Vec3;
}
