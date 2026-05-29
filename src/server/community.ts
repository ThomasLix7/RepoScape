// @ts-ignore - graphology types are not compatible with NodeNext module resolution
import Graph from 'graphology';
// @ts-ignore - no type declarations for this module
import louvain from 'graphology-communities-louvain';
import { GraphEdge } from './types.js';

const GraphClass = Graph as any;
const louvainFn = louvain as any;

export function runLouvainClustering(
  nodeIds: string[],
  edges: GraphEdge[]
): Map<string, number> {
  const graph = new GraphClass({ type: 'undirected' });

  for (const id of nodeIds) {
    graph.addNode(id);
  }

  // §7: Aggregate bidirectional edge weights into one undirected edge
  const weightMap = new Map<string, number>();
  for (const edge of edges) {
    const key = [edge.source, edge.target].sort().join('\0');
    weightMap.set(key, (weightMap.get(key) || 0) + (edge.score || 1.0));
  }

  for (const [key, weight] of weightMap.entries()) {
    const [a, b] = key.split('\0');
    try {
      graph.addEdge(a, b, { weight });
    } catch {
      // skip edges with missing nodes
    }
  }

  // Classic LCG seeded random generator to guarantee 100% determinism
  let seed = 42;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const result = louvainFn(graph, {
    resolution: 1.0, // Strictly locked resolution parameter
    rng: rng, // Custom seeded RNG for absolute reproducibility
  });

  return new Map(Object.entries(result) as [string, number][]);
}

export function stabilizeCommunities(
  newCommunities: Map<string, number>,
  oldCommunities: Map<string, number>
): Map<string, number> {
  const newSets = new Map<number, Set<string>>();
  const oldSets = new Map<number, Set<string>>();

  for (const [node, cid] of newCommunities.entries()) {
    if (!newSets.has(cid)) newSets.set(cid, new Set<string>());
    newSets.get(cid)!.add(node);
  }
  for (const [node, cid] of oldCommunities.entries()) {
    if (!oldSets.has(cid)) oldSets.set(cid, new Set<string>());
    oldSets.get(cid)!.add(node);
  }

  // Calculate greedy overlaps using Jaccard Similarity index
  const mappings = new Map<number, number>();
  const usedOld = new Set<number>();

  const overlaps: { score: number; newCid: number; oldCid: number }[] = [];
  for (const [newCid, newSet] of newSets.entries()) {
    for (const [oldCid, oldSet] of oldSets.entries()) {
      const intersection = new Set([...newSet].filter((x) => oldSet.has(x)));
      const union = new Set([...newSet, ...oldSet]);
      const jaccard = intersection.size / union.size;
      if (jaccard > 0) {
        overlaps.push({ score: jaccard, newCid, oldCid });
      }
    }
  }

  overlaps.sort((a, b) => b.score - a.score);
  for (const match of overlaps) {
    if (!mappings.has(match.newCid) && !usedOld.has(match.oldCid)) {
      mappings.set(match.newCid, match.oldCid);
      usedOld.add(match.oldCid);
    }
  }

  let nextCid = 0;
  const stabilized = new Map<string, number>();
  for (const [node, newCid] of newCommunities.entries()) {
    let finalCid = mappings.get(newCid);
    if (finalCid === undefined) {
      while (usedOld.has(nextCid)) nextCid++;
      mappings.set(newCid, nextCid);
      usedOld.add(nextCid);
      finalCid = nextCid;
    }
    stabilized.set(node, finalCid);
  }
  return stabilized;
}
