import { describe, it, expect } from 'vitest';
import { unwrapReexports, identifyHubNodes } from '../server/resolver.js';

describe('unwrapReexports', () => {
  it('should return same symbol when no mapping exists', () => {
    const globalExports = new Map();
    const result = unwrapReexports('foo', 'src/index.ts', globalExports);
    expect(result).toEqual({ filePath: 'src/index.ts', symbol: 'foo' });
  });

  it('should follow simple re-export', () => {
    const globalExports = new Map([
      ['src/index.ts', new Map([['foo', 'src/foo.ts']])],
    ]);
    const result = unwrapReexports('foo', 'src/index.ts', globalExports);
    expect(result).toEqual({ filePath: 'src/foo.ts', symbol: 'foo' });
  });

  it('should follow renamed re-export', () => {
    const globalExports = new Map([
      ['src/index.ts', new Map([['bar', { sourceFile: 'src/foo.ts', originalSymbol: 'foo' }]])],
    ]);
    const result = unwrapReexports('bar', 'src/index.ts', globalExports);
    expect(result).toEqual({ filePath: 'src/foo.ts', symbol: 'foo' });
  });

  it('should handle circular exports without infinite loop', () => {
    const globalExports = new Map([
      ['src/a.ts', new Map([['x', 'src/b.ts']])],
      ['src/b.ts', new Map([['x', 'src/a.ts']])],
    ]);
    const result = unwrapReexports('x', 'src/a.ts', globalExports);
    expect(result.filePath).toBe('src/a.ts');
    expect(result.symbol).toBe('x');
  });
});

describe('identifyHubNodes', () => {
  it('should return empty set for small graphs', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ];
    const result = identifyHubNodes(nodes, edges);
    expect(result.size).toBe(0);
  });

  it('should identify hub node with many connections', () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({ id: `n${i}` }));
    const edges = [];
    for (let i = 1; i < 100; i++) {
      edges.push({ source: 'n0', target: `n${i}` });
      edges.push({ source: `n${i}`, target: 'n0' });
    }
    const result = identifyHubNodes(nodes, edges);
    expect(result.has('n0')).toBe(true);
  });
});
