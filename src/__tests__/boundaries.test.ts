import { describe, it, expect } from 'vitest';
import {
  globToRegExp,
  compileRulePattern,
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

  it('except suppresses an otherwise-matching edge (to-side)', () => {
    const withExcept = parseArchitectureRules({
      boundaries: [
        { from: 'src/ui/**', to: 'src/db/**', except: ['src/db/types/**'], severity: 'error' },
      ],
    });
    const blocked = detectBoundaryViolations(
      [{ source: 'n1', target: 'n2', fromFile: 'src/ui/App.tsx', toFile: 'src/db/client.ts' }],
      withExcept
    );
    expect(blocked).toHaveLength(1);
    const excepted = detectBoundaryViolations(
      [{ source: 'n1', target: 'n2', fromFile: 'src/ui/App.tsx', toFile: 'src/db/types/row.ts' }],
      withExcept
    );
    expect(excepted).toEqual([]);
  });
});

describe('compileRulePattern', () => {
  it('regex kind is used verbatim and unanchored', () => {
    const re = compileRulePattern('^src/db', 'regex');
    expect(re.test('src/db/client.ts')).toBe(true); // unanchored: prefix match
    expect(re.test('packages/src/db.ts')).toBe(false); // ^ still applies
  });

  it('glob kind stays anchored', () => {
    expect(compileRulePattern('src/db/**', 'glob').test('src/db/client.ts')).toBe(true);
    expect(compileRulePattern('src/db/**', 'glob').test('x/src/db/client.ts')).toBe(false);
  });
});

describe('parseArchitectureRules — pathKind / except validation', () => {
  it('keeps a regex rule and matches it unanchored', () => {
    const parsed = parseArchitectureRules({
      boundaries: [{ from: '^src/ui', to: '^src/db', pathKind: 'regex', severity: 'error' }],
    });
    expect(parsed.boundaries).toHaveLength(1);
    const v = detectBoundaryViolations(
      [{ source: 'n1', target: 'n2', fromFile: 'src/ui/App.tsx', toFile: 'src/db/client.ts' }],
      parsed
    );
    expect(v).toHaveLength(1);
  });

  it('drops a rule whose regex fails to compile but keeps siblings', () => {
    const parsed = parseArchitectureRules({
      boundaries: [
        { from: '(', to: '^src/db', pathKind: 'regex' }, // unbalanced paren → invalid
        { from: '^src/ui', to: '^src/db', pathKind: 'regex' },
      ],
    });
    expect(parsed.boundaries).toHaveLength(1);
    expect(parsed.boundaries[0].from).toBe('^src/ui');
  });

  it('drops rules with a bad pathKind or malformed except', () => {
    const parsed = parseArchitectureRules({
      boundaries: [
        { from: 'a/**', to: 'b/**', pathKind: 'bogus' },
        { from: 'a/**', to: 'b/**', except: [1, 2] },
        { from: 'a/**', to: 'b/**', except: 'c/**' }, // string coerced to [string]
      ],
    });
    expect(parsed.boundaries).toHaveLength(1);
    expect(parsed.boundaries[0].except).toEqual(['c/**']);
  });
});
