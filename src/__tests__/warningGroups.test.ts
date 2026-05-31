import { describe, expect, it } from 'vitest';
import { GraphEdge } from '../hud/connection.js';
import { groupWarningEdges } from '../hud/warningGroups.js';

const cycle = (source: string, target: string, score = 0.7): GraphEdge => ({
  source,
  target,
  relation: 'circular_dependency',
  type: 'SUSPICIOUS',
  score,
});

describe('groupWarningEdges', () => {
  it('groups a two-node circular dependency into one cycle card', () => {
    const groups = groupWarningEdges([cycle('A', 'B'), cycle('B', 'A')]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      type: 'cycle',
      nodeIds: ['A', 'B'],
      cycleNodes: ['A', 'B', 'A'],
    });
  });

  it('groups a longer circular dependency into one cycle card', () => {
    const groups = groupWarningEdges([cycle('A', 'B'), cycle('B', 'C'), cycle('C', 'A')]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      type: 'cycle',
      nodeIds: ['A', 'B', 'C'],
      cycleNodes: ['A', 'B', 'C', 'A'],
    });
  });

  it('does not split a strongly connected component when it has extra internal edges', () => {
    const groups = groupWarningEdges([
      cycle('A', 'B'),
      cycle('B', 'C'),
      cycle('C', 'A'),
      cycle('A', 'C'),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe('cycle');
    if (groups[0].type === 'cycle') {
      expect(groups[0].nodeIds).toEqual(['A', 'B', 'C']);
      expect(groups[0].edges.map(edge => `${edge.source}->${edge.target}`).sort()).toEqual([
        'A->B',
        'A->C',
        'B->C',
        'C->A',
      ]);
    }
  });

  it('keeps separate strongly connected components as separate cycle cards', () => {
    const groups = groupWarningEdges([
      cycle('A', 'B'),
      cycle('B', 'A'),
      cycle('C', 'D'),
      cycle('D', 'C'),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map(group => group.key).sort()).toEqual(['cycle_A_B', 'cycle_C_D']);
  });

  it('keeps boundary warnings as single-edge cards', () => {
    const boundary: GraphEdge = {
      source: 'A',
      target: 'B',
      relation: 'violates_boundary',
      type: 'SUSPICIOUS',
      score: 0.9,
    };

    expect(groupWarningEdges([boundary])).toEqual([
      {
        type: 'boundary',
        key: 'sus_A->B_violates_boundary',
        edges: [boundary],
        score: 0.9,
      },
    ]);
  });
});
