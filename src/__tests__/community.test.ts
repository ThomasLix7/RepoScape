import { describe, it, expect } from 'vitest';
import { stabilizeCommunities } from '../server/community.js';

describe('stabilizeCommunities', () => {
  it('should map new communities to old ones when they overlap', () => {
    const old = new Map([
      ['a', 0],
      ['b', 0],
      ['c', 1],
      ['d', 1],
    ]);
    const newC = new Map([
      ['a', 5],
      ['b', 5],
      ['c', 7],
      ['d', 7],
    ]);
    const result = stabilizeCommunities(newC, old);
    // Should map 5->0 and 7->1 (or vice versa)
    expect(result.get('a')).toBe(result.get('b'));
    expect(result.get('c')).toBe(result.get('d'));
    expect(result.get('a')).not.toBe(result.get('c'));
  });

  it('should assign new IDs to completely new communities', () => {
    const old = new Map([
      ['a', 0],
      ['b', 1],
    ]);
    const newC = new Map([
      ['c', 10],
      ['d', 10],
    ]);
    const result = stabilizeCommunities(newC, old);
    expect(result.get('c')).toBe(result.get('d'));
  });

  it('should handle empty old communities', () => {
    const old = new Map<string, number>();
    const newC = new Map([
      ['a', 0],
      ['b', 1],
    ]);
    const result = stabilizeCommunities(newC, old);
    expect(result.size).toBe(2);
    expect(result.get('a')).not.toBe(result.get('b'));
  });

  it('should handle empty new communities', () => {
    const old = new Map([['a', 0]]);
    const newC = new Map<string, number>();
    const result = stabilizeCommunities(newC, old);
    expect(result.size).toBe(0);
  });

  it('should preserve IDs when communities are identical', () => {
    const old = new Map([
      ['a', 0],
      ['b', 1],
    ]);
    const newC = new Map([
      ['a', 0],
      ['b', 1],
    ]);
    const result = stabilizeCommunities(newC, old);
    expect(result.get('a')).toBe(0);
    expect(result.get('b')).toBe(1);
  });
});
