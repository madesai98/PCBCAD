/**
 * Text normalisation helpers for part numbers and distributor strings.
 */

/** Normalise an MPN for comparison: upper case, no whitespace. */
export function normMpn(s: string): string {
  return s.toUpperCase().replace(/\s+/g, '');
}

/**
 * MPN without trailing packaging / plating suffixes in brackets, e.g.
 * 'B4B-PH-K-S(LF)(SN)' → 'B4B-PH-K-S', 'SM04B-SRSS-TB (LF)(SN)' → 'SM04B-SRSS-TB'.
 */
export function baseMpn(s: string): string {
  return normMpn(s).replace(/(\([^()]*\)|\[[^[\]]*\])+$/g, '');
}

/** True for LCSC part codes like 'C2040' (case-insensitive). */
export function isLcscCode(s: string): boolean {
  return /^C\d{1,10}$/i.test(s.trim());
}

/** Canonical LCSC code ('c2040' → 'C2040'). */
export function lcscCode(s: string): string {
  return s.trim().toUpperCase();
}

/** Lower-case search tokens (alphanumeric runs, '.' kept inside numbers). */
export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9.+µ%-]+/i)
    .map((t) => t.replace(/^[-.]+|[-.]+$/g, ''))
    .filter(Boolean);
}

/** Collapse whitespace and trim. */
export function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
