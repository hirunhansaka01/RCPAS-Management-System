import { describe, expect, it } from 'vitest';
import { toCsv } from '../src/server/services/csv';
import { assignmentSchema, eventSchema, memberSchema } from '../src/shared/schemas';
import { composeMemberId, digitsOnly, parseMemberId } from '../src/shared/member-id';
import { hashPassword, verifyPassword } from '../src/server/password';

describe('RCPAS domain safeguards', () => {
  it('guards spreadsheet formula injection in CSV exports', () => {
    const csv = toCsv([{ name: '=HYPERLINK("https://example.com")', status: '+Active', note: '@mention' }]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+Active");
    expect(csv).toContain("'@mention");
  });
  it('rejects events whose end is before their start', () => {
    const result = eventSchema.safeParse({ eventCode:'EVT-1', name:'Coverage', category:'School', startsAt:'2026-10-28T10:00:00Z', endsAt:'2026-10-28T09:00:00Z', venue:'Matara', status:'Upcoming' });
    expect(result.success).toBe(false);
  });
  it('requires unique-looking member fields and limits role payloads', () => {
    const result = memberSchema.safeParse({ memberCode:'', fullName:'A', grade:'', className:'', membershipStart:'not-a-date', status:'Active', roleIds:Array.from({length:13},(_,i)=>i+1) });
    expect(result.success).toBe(false);
  });
  const validMember = (memberCode: string) => ({ memberCode, fullName:'Nimal Perera', grade:'12', className:'A', membershipStart:'2026-01-05', status:'Active' as const });
  it('only accepts member IDs assembled as RCPAS/<batch year>/<number>', () => {
    expect(memberSchema.safeParse(validMember('RCPAS/2026/135')).success).toBe(true);
    expect(memberSchema.safeParse(validMember('RCPAS/2006/7')).success).toBe(true);
    for (const legacy of ['RC-24-101', '2026/135', 'rcpas/2026/135', 'RCPAS/26/135', 'RCPAS/2026/', 'RCPAS/2026/13a']) {
      const result = memberSchema.safeParse(validMember(legacy));
      expect(result.success, `should have rejected ${legacy}`).toBe(false);
    }
  });
  it('composes and parses member IDs exactly as the form does', () => {
    expect(composeMemberId('2026', '135')).toBe('RCPAS/2026/135');
    expect(parseMemberId('RCPAS/2026/135')).toEqual({ year:'2026', number:'135' });
    expect(parseMemberId('RCPAS/2026/')).toEqual({ year:'2026', number:'' });
    expect(parseMemberId('')).toBeNull();
    expect(parseMemberId('RC-24-101')).toBeNull();
    expect(digitsOnly('13a5-')).toBe('135');
  });
  it('requires an explicit responsibility for assignments', () => {
    const result = assignmentSchema.safeParse({ eventId:1, memberId:1, responsibility:'', status:'Proposed' });
    expect(result.success).toBe(false);
  });
  it('hashes passwords without storing or accepting the plaintext', async () => {
    const encoded = await hashPassword('correct horse battery staple');
    expect(encoded).not.toContain('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', encoded)).toBe(true);
    expect(await verifyPassword('wrong password', encoded)).toBe(false);
  });
});
