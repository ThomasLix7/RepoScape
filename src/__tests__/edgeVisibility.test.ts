import { describe, expect, it } from 'vitest';
import { suppressPhysicalEdgesCoveredBySuspicious } from '../hud/edgeVisibility.js';
import { GraphEdge } from '../hud/connection.js';

describe('suppressPhysicalEdgesCoveredBySuspicious', () => {
  const physical: GraphEdge = {
    source: 'a',
    target: 'b',
    relation: 'imports',
    type: 'PHYSICAL',
    score: 1,
  };

  const suspicious: GraphEdge = {
    source: 'b',
    target: 'a',
    relation: 'circular_dependency',
    type: 'SUSPICIOUS',
    score: 0.6,
  };

  it('hides physical edges on the same node pair while suspicious edges are shown', () => {
    const result = suppressPhysicalEdgesCoveredBySuspicious([physical, suspicious], true);

    expect(result).toEqual([suspicious]);
  });

  it('keeps physical edges when the suspicious layer is hidden', () => {
    const result = suppressPhysicalEdgesCoveredBySuspicious([physical, suspicious], false);

    expect(result).toEqual([physical, suspicious]);
  });
});
