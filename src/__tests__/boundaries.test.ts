import { describe, it, expect } from 'vitest';
import {
  globToRegExp,
  detectBoundaryViolations,
  parseArchitectureRules,
} from '../server/boundaries.js';

describe('globToRegExp', () => {
  it('** spans path separators, * does not', () => {
    expect(globToRegExp('src/hud/**').test('src/hud/components/App.tsx')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/sub/a.ts')).toBe(false);
  });

  it('escapes regex metacharacters in literal segments', () => {
    expect(globToRegExp('a.b/c').test('a.b/c')).toBe(true);
    expect(globToRegExp('a.b/c').test('aXb/c')).toBe(false);
  });
});

describe('parseArchitectureRules', () => {
  it('returns empty boundaries for malformed input', () => {
    expect(parseArchitectureRules(null).boundaries).toEqual([]);
    expect(parseArchitectureRules({}).boundaries).toEqual([]);
    expect(parseArchitectureRules({ boundaries: 'nope' }).boundaries).toEqual([]);
  });

  it('drops invalid rules but keeps valid ones', () => {
    const parsed = parseArchitectureRules({
      boundaries: [
        { from: 'a/**', to: 'b/**', severity: 'error', reason: 'no' },
        { from: 'a/**' }, // missing to
        { from: 'a/**', to: 'b/**', severity: 'bogus' }, // bad severity
        { from: 'c/**', to: 'd/**' }, // severity optional
      ],
    });
    expect(parsed.boundaries).toHaveLength(2);
    expect(parsed.boundaries[0].reason).toBe('no');
  });
});

describe('detectBoundaryViolations', () => {
  const rules = parseArchitectureRules({
    boundaries: [
      { from: 'src/hud/**', to: 'src/server/**', severity: 'error', reason: 'view→server forbidden' },
      { from: 'src/util/**', to: 'src/legacy/**', severity: 'warn' },
    ],
  });

  it('flags a forbidden import with error severity (score 0.9)', () => {
    const v = detectBoundaryViolations(
      [{ source: 'n1', target: 'n2', fromFile: 'src/hud/components/App.tsx', toFile: 'src/server/compiler.ts' }],
      rules
    );
    expect(v).toHaveLength(1);
    expect(v[0].score).toBe(0.9);
    expect(v[0].reason).toBe('view→server forbidden');
  });

  it('warn severity maps to score 0.5 with a default reason', () => {
    const v = detectBoundaryViolations(
      [{ source: 'n1', target: 'n2', fromFile: 'src/util/x.ts', toFile: 'src/legacy/y.ts' }],
      rules
    );
    expect(v).toHaveLength(1);
    expect(v[0].score).toBe(0.5);
    expect(v[0].reason).toContain('src/util/**');
  });

  it('does not flag allowed imports', () => {
    const v = detectBoundaryViolations(
      [{ source: 'n1', target: 'n2', fromFile: 'src/server/a.ts', toFile: 'src/server/b.ts' }],
      rules
    );
    expect(v).toEqual([]);
  });

  it('first matching rule wins (one violation per edge)', () => {
    const overlapping = parseArchitectureRules({
      boundaries: [
        { from: 'src/**', to: 'src/server/**', severity: 'warn' },
        { from: 'src/hud/**', to: 'src/server/**', severity: 'error' },
      ],
    });
    const v = detectBoundaryViolations(
      [{ source: 'n1', target: 'n2', fromFile: 'src/hud/App.tsx', toFile: 'src/server/compiler.ts' }],
      overlapping
    );
    expect(v).toHaveLength(1);
    expect(v[0].score).toBe(0.5); // first rule (warn) wins
  });
});
