import { GraphEdge } from './connection.js';

function unorderedEdgePairKey(edge: Pick<GraphEdge, 'source' | 'target'>): string {
  return edge.source < edge.target
    ? `${edge.source}\u0000${edge.target}`
    : `${edge.target}\u0000${edge.source}`;
}

export function suppressPhysicalEdgesCoveredBySuspicious(
  edges: GraphEdge[],
  showSuspicious: boolean
): GraphEdge[] {
  if (!showSuspicious) return edges;

  const suspiciousPairs = new Set<string>();
  for (const edge of edges) {
    if (edge.type === 'SUSPICIOUS') {
      suspiciousPairs.add(unorderedEdgePairKey(edge));
    }
  }
  if (suspiciousPairs.size === 0) return edges;

  return edges.filter((edge) => (
    edge.type !== 'PHYSICAL' || !suspiciousPairs.has(unorderedEdgePairKey(edge))
  ));
}
