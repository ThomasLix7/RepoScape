import { describe, it, expect } from 'vitest';
import { runLouvainClustering, stabilizeCommunities } from '../server/community.js';
import { buildClusteringEdges } from '../server/compiler.js';
import { GraphEdge } from '../server/types.js';

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

describe('buildClusteringEdges', () => {
  it('includes cognitive code edges at reduced weight', () => {
    const edges: GraphEdge[] = [
      { source: 'a', target: 'b', relation: 'imports', type: 'PHYSICAL', score: 1 },
      { source: 'doc', target: 'concept', relation: 'contains', type: 'COGNITIVE', score: 1 },
      { source: 'concept', target: 'a', relation: 'implements', type: 'COGNITIVE', score: 0.9 },
    ];

    const clusteringEdges = buildClusteringEdges(edges);

    expect(clusteringEdges).toHaveLength(3);
    expect(clusteringEdges.find((e) => e.relation === 'imports')?.score).toBe(1);
    expect(clusteringEdges.find((e) => e.relation === 'contains')?.score).toBe(1);
    expect(clusteringEdges.find((e) => e.relation === 'implements')?.score).toBeCloseTo(0.27);
  });

  it('keeps strongly connected code communities split across weak cognitive bridges', () => {
    const physicalClique = (ids: string[]): GraphEdge[] => {
      const edges: GraphEdge[] = [];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          edges.push({
            source: ids[i],
            target: ids[j],
            relation: 'calls',
            type: 'PHYSICAL',
            score: 1,
          });
        }
      }
      return edges;
    };

    const edges: GraphEdge[] = [
      ...physicalClique(['a0', 'a1', 'a2']),
      ...physicalClique(['b0', 'b1', 'b2']),
      { source: 'concept_shared', target: 'a0', relation: 'implements', type: 'COGNITIVE', score: 0.9 },
      { source: 'concept_shared', target: 'b0', relation: 'implements', type: 'COGNITIVE', score: 0.9 },
    ];

    const communities = runLouvainClustering(
      ['a0', 'a1', 'a2', 'b0', 'b1', 'b2', 'concept_shared'],
      buildClusteringEdges(edges)
    );

    expect(communities.get('a0')).toBe(communities.get('a1'));
    expect(communities.get('b0')).toBe(communities.get('b1'));
    expect(communities.get('a0')).not.toBe(communities.get('b0'));
  });
});
