const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** Short random id with a readable prefix, e.g. newId('cmp') -> 'cmp_k3j9x0q2ab'. */
export function newId(prefix: string, length = 10): string {
  const bytes = randomBytes(length);
  let s = '';
  for (let i = 0; i < length; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `${prefix}_${s}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Slugify for file names / ids. */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item'
  );
}
