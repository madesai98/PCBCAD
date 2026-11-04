import type { NumArray, PackedArray } from './types/common';

/* Environment-agnostic base64 <-> bytes (Node Buffer when present, otherwise btoa/atob). */

declare const Buffer: any;

function bytesToB64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH) as unknown as number[]);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(b64, 'base64');
    const out = new Uint8Array(buf.length);
    out.set(buf);
    return out;
  }
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

type Typed = Float32Array | Float64Array | Uint8Array | Uint16Array | Uint32Array | Int32Array;

const CTORS = {
  f32: Float32Array,
  f64: Float64Array,
  u8: Uint8Array,
  u16: Uint16Array,
  u32: Uint32Array,
  i32: Int32Array,
} as const;

export function pack(arr: Typed | number[], dtype?: PackedArray['dtype']): PackedArray {
  let typed: Typed;
  let dt: PackedArray['dtype'];
  if (Array.isArray(arr)) {
    dt = dtype ?? 'f32';
    typed = new CTORS[dt](arr);
  } else {
    dt =
      dtype ??
      (arr instanceof Float32Array
        ? 'f32'
        : arr instanceof Float64Array
          ? 'f64'
          : arr instanceof Uint8Array
            ? 'u8'
            : arr instanceof Uint16Array
              ? 'u16'
              : arr instanceof Uint32Array
                ? 'u32'
                : 'i32');
    typed = arr.constructor === CTORS[dt] ? arr : new CTORS[dt](arr as ArrayLike<number>);
  }
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  return { dtype: dt, length: typed.length, b64: bytesToB64(bytes) };
}

export function isPacked(a: unknown): a is PackedArray {
  return !!a && typeof a === 'object' && !Array.isArray(a) && typeof (a as PackedArray).b64 === 'string';
}

export function unpack(p: PackedArray): Typed {
  const bytes = b64ToBytes(p.b64);
  const Ctor = CTORS[p.dtype];
  // copy to aligned buffer
  const aligned = new Uint8Array(bytes.length);
  aligned.set(bytes);
  return new Ctor(aligned.buffer, 0, p.length);
}

/** Read any NumArray as Float32Array. */
export function toFloat32(a: NumArray | undefined | null): Float32Array {
  if (!a) return new Float32Array(0);
  if (isPacked(a)) {
    const t = unpack(a);
    return t instanceof Float32Array ? t : new Float32Array(t);
  }
  return new Float32Array(a);
}

/** Read any NumArray as a numeric array-like (no copy if already typed). */
export function toNumbers(a: NumArray | undefined | null): ArrayLike<number> {
  if (!a) return [];
  return isPacked(a) ? unpack(a) : a;
}

export function toUint32(a: NumArray | undefined | null): Uint32Array {
  if (!a) return new Uint32Array(0);
  if (isPacked(a)) {
    const t = unpack(a);
    return t instanceof Uint32Array ? t : new Uint32Array(t);
  }
  return new Uint32Array(a);
}

export function toUint8(a: NumArray | undefined | null): Uint8Array {
  if (!a) return new Uint8Array(0);
  if (isPacked(a)) {
    const t = unpack(a);
    return t instanceof Uint8Array ? t : new Uint8Array(t);
  }
  return new Uint8Array(a);
}
