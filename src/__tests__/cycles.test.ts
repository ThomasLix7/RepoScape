import { describe, it, expect } from 'vitest';
import { detectCycleEdges } from '../server/cycles.js';

describe('detectCycleEdges', () => {
  it('should detect a simple 2-node cycle', () => {
    const nodes = ['A', 'B'];
    const edges = [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'A' },
    ];
    const result = detectCycleEdges(nodes, edges);
    expect(result.size).toBe(2);
    expect(result.has('A->B')).toBe(true);
    expect(result.has('B->A')).toBe(true);
    expect(result.get('A->B')).toBeCloseTo(0.6);
  });

  it('should detect a 3-node cycle', () => {
    const nodes = ['A', 'B', 'C'];
    const edges = [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
      { source: 'C', target: 'A' },
    ];
    const result = detectCycleEdges(nodes, edges);
    expect(result.size).toBe(3);
    expect(result.get('A->B')).toBeCloseTo(0.7);
  });

  it('should return empty for acyclic graph', () => {
    const nodes = ['A', 'B', 'C'];
    const edges = [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
    ];
    const result = detectCycleEdges(nodes, edges);
    expect(result.size).toBe(0);
  });

  it('should handle disconnected nodes', () => {
    const nodes = ['A', 'B', 'C', 'D'];
    const edges = [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'A' },
    ];
    const result = detectCycleEdges(nodes, edges);
    expect(result.size).toBe(2);
  });

  it('should cap risk score at 1.0', () => {
    const nodes = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const edges = [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
      { source: 'C', target: 'D' },
      { source: 'D', target: 'E' },
      { source: 'E', target: 'F' },
      { source: 'F', target: 'G' },
      { source: 'G', target: 'A' },
    ];
    const result = detectCycleEdges(nodes, edges);
    expect(result.size).toBe(7);
    for (const score of result.values()) {
      expect(score).toBeLessThanOrEqual(1.0);
    }
  });
});
