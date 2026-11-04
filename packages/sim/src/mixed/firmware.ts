/**
 * Firmware image parsing: Intel HEX, UF2, ELF32 (PT_LOAD segments by physical address) and raw
 * binaries. Browser-safe.
 */
import type { FirmwareFormat, MemorySegment } from './types';

const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

function bytesToText(bytes: Uint8Array): string {
  if (textDecoder) return textDecoder.decode(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** Merge (address-sorted) chunks into contiguous segments. */
function mergeChunks(chunks: { address: number; data: Uint8Array }[]): MemorySegment[] {
  chunks.sort((a, b) => a.address - b.address);
  const out: MemorySegment[] = [];
  let cur: { address: number; parts: Uint8Array[]; end: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const len = cur.end - cur.address;
    const data = new Uint8Array(len);
    let off = 0;
    for (const p of cur.parts) {
      data.set(p, off);
      off += p.length;
    }
    out.push({ address: cur.address, data });
    cur = null;
  };
  for (const c of chunks) {
    if (cur && c.address === cur.end) {
      cur.parts.push(c.data);
      cur.end += c.data.length;
    } else {
      flush();
      cur = { address: c.address, parts: [c.data], end: c.address + c.data.length };
    }
  }
  flush();
  return out;
}

/** Parse Intel HEX text (record types 00, 01, 02, 03, 04, 05). Checksums are verified. */
export function parseIntelHex(input: string | Uint8Array): { segments: MemorySegment[]; entry?: number } {
  const text = typeof input === 'string' ? input : bytesToText(input);
  const chunks: { address: number; data: Uint8Array }[] = [];
  let base = 0;
  let entry: number | undefined;
  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (!line) continue;
    if (line[0] !== ':') throw new Error(`Intel HEX line ${ln + 1}: missing ':'`);
    const hex = line.slice(1);
    if (hex.length < 10 || hex.length % 2) throw new Error(`Intel HEX line ${ln + 1}: malformed record`);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      const v = parseInt(hex.substr(i * 2, 2), 16);
      if (Number.isNaN(v)) throw new Error(`Intel HEX line ${ln + 1}: bad hex digit`);
      bytes[i] = v;
    }
    const count = bytes[0];
    if (bytes.length !== count + 5) throw new Error(`Intel HEX line ${ln + 1}: length mismatch`);
    let sum = 0;
    for (const b of bytes) sum = (sum + b) & 0xff;
    if (sum !== 0) throw new Error(`Intel HEX line ${ln + 1}: checksum error`);
    const addr = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    const data = bytes.subarray(4, 4 + count);
    switch (type) {
      case 0x00:
        chunks.push({ address: base + addr, data: data.slice() });
        break;
      case 0x01:
        ln = lines.length;
        break;
      case 0x02:
        base = ((data[0] << 8) | data[1]) * 16;
        break;
      case 0x04:
        base = ((data[0] << 8) | data[1]) * 65536;
        break;
      case 0x03:
        entry = ((data[0] << 8) | data[1]) * 16 + ((data[2] << 8) | data[3]);
        break;
      case 0x05:
        entry = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
        break;
      default:
        throw new Error(`Intel HEX line ${ln + 1}: unknown record type ${type}`);
    }
  }
  return { segments: mergeChunks(chunks), entry };
}

export const UF2_FAMILY_RP2040 = 0xe48bff56;

/** Parse a UF2 image (512-byte blocks). Blocks flagged "not main flash" are skipped. */
export function parseUf2(bytes: Uint8Array, opts: { familyId?: number } = {}): { segments: MemorySegment[]; families: number[] } {
  if (bytes.length % 512) throw new Error('UF2: size is not a multiple of 512 bytes');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: { address: number; data: Uint8Array }[] = [];
  const families = new Set<number>();
  for (let off = 0; off < bytes.length; off += 512) {
    const m0 = dv.getUint32(off, true);
    const m1 = dv.getUint32(off + 4, true);
    const mEnd = dv.getUint32(off + 508, true);
    if (m0 !== 0x0a324655 || m1 !== 0x9e5d5157 || mEnd !== 0x0ab16f30) throw new Error(`UF2: bad magic in block ${off / 512}`);
    const flags = dv.getUint32(off + 8, true);
    const target = dv.getUint32(off + 12, true);
    const size = dv.getUint32(off + 16, true);
    const family = dv.getUint32(off + 28, true);
    if (flags & 0x00000001) continue; // not main flash
    if (flags & 0x00002000) {
      families.add(family);
      if (opts.familyId !== undefined && family !== opts.familyId) continue;
    }
    if (size > 476) throw new Error(`UF2: payload too large in block ${off / 512}`);
    chunks.push({ address: target, data: bytes.slice(off + 32, off + 32 + size) });
  }
  return { segments: mergeChunks(chunks), families: Array.from(families) };
}

/** Parse ELF32 little-endian: PT_LOAD segments at their physical (load) addresses. */
export function parseElf(bytes: Uint8Array): { segments: MemorySegment[]; entry: number; machine: number } {
  if (bytes.length < 52 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) throw new Error('ELF: bad magic');
  if (bytes[4] !== 1) throw new Error('ELF: only 32-bit ELF is supported');
  if (bytes[5] !== 1) throw new Error('ELF: only little-endian ELF is supported');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const machine = dv.getUint16(18, true);
  const entry = dv.getUint32(24, true);
  const phoff = dv.getUint32(28, true);
  const phentsize = dv.getUint16(42, true);
  const phnum = dv.getUint16(44, true);
  const chunks: { address: number; data: Uint8Array }[] = [];
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (o + 32 > bytes.length) throw new Error('ELF: truncated program header');
    const type = dv.getUint32(o, true);
    if (type !== 1) continue; // PT_LOAD
    const offset = dv.getUint32(o + 4, true);
    const paddr = dv.getUint32(o + 12, true);
    const filesz = dv.getUint32(o + 16, true);
    if (!filesz) continue;
    if (offset + filesz > bytes.length) throw new Error('ELF: segment beyond end of file');
    chunks.push({ address: paddr, data: bytes.slice(offset, offset + filesz) });
  }
  return { segments: mergeChunks(chunks), entry, machine };
}

/**
 * Decode any supported firmware format into memory segments. Raw binaries are placed at
 * `binBase` (default 0).
 */
export function decodeFirmware(bytes: Uint8Array, format: FirmwareFormat, opts: { binBase?: number; uf2Family?: number } = {}): MemorySegment[] {
  switch (format) {
    case 'hex':
      return parseIntelHex(bytes).segments;
    case 'uf2':
      return parseUf2(bytes, { familyId: opts.uf2Family }).segments;
    case 'elf':
      return parseElf(bytes).segments;
    case 'bin':
      return [{ address: opts.binBase ?? 0, data: bytes }];
    default:
      throw new Error(`Unsupported firmware format '${String(format)}'`);
  }
}
