import { describe, it, expect } from 'vitest';
import { parseSharePercent, sharePercent } from '../rights';
describe('explicit split percentage entry', () => {
  it('keeps unknown distinct from zero and converts exact decimal basis points', () => {
    expect(parseSharePercent('')).toBeNull(); expect(parseSharePercent('0')).toBe(0);
    expect(parseSharePercent('33.33')).toBe(3333); expect(parseSharePercent('100.00')).toBe(10000);
    expect(sharePercent(null)).toBe(''); expect(sharePercent(1)).toBe('0.01');
  });
  it('rejects invalid or overly precise input without rounding into a different share', () => {
    for (const value of ['-1', '101', '1.001', 'NaN', 'Infinity', '1e2', '0x50', '5%', ' 5']) expect(() => parseSharePercent(value)).toThrow();
  });
});
