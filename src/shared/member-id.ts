/**
 * Member IDs are assembled, never typed whole: the official picks a batch year
 * and enters the member number, and the ID is composed as RCPAS/2026/135.
 *
 * Kept outside schemas.ts so the browser can share the exact same rule without
 * pulling zod into the client bundle.
 */
export const MEMBER_CODE_PATTERN = /^RCPAS\/\d{4}\/\d+$/;
export const MEMBER_CODE_FORMAT_MESSAGE =
  'Member ID must look like RCPAS/2026/135 — choose a batch year and enter the member number.';

const MEMBER_CODE_PARTS = /^RCPAS\/(\d{4})\/(\d*)$/;

/** Batch years offered in the picker: next year back 20, newest first. */
export function memberIdYears(now: Date = new Date()): number[] {
  return Array.from({ length: 22 }, (_, i) => now.getFullYear() + 1 - i);
}

export function composeMemberId(year: string, number: string): string {
  return 'RCPAS/' + year + '/' + number;
}

/**
 * Splits an existing ID into its picker values. Returns null for anything that
 * does not fit the template, so callers can tell "not assembled yet" apart from
 * a genuinely parsed ID instead of silently rewriting it.
 */
export function parseMemberId(code: string | null | undefined): { year: string; number: string } | null {
  const parts = MEMBER_CODE_PARTS.exec(String(code ?? '').trim());
  return parts ? { year: parts[1], number: parts[2] } : null;
}

/** Member numbers are digits only; anything else is dropped rather than rejected. */
export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}
