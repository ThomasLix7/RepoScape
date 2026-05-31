import { GraphEdge } from './connection.js';

export type WarningGroup =
  | {
      type: 'cycle';
      key: string;
      edges: GraphEdge[];
      nodeIds: string[];
      cycleNodes: string[];
      score: number;
    }
  | {
      type: 'boundary' | 'other';
      key: string;
      edges: [GraphEdge];
      score: number;
    };

function edgeKey(edge: GraphEdge): string {
  return `${edge.source}->${edge.target}_${edge.relation}`;
}

function findPath(start: string, target: string, adj: Map<string, string[]>, allowed: Set<string>): string[] {
  if (start === target) return [start];

  const queue = [start];
  const previous = new Map<string, string | null>([[start, null]]);

  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    for (const next of adj.get(current) ?? []) {
      if (!allowed.has(next) || previous.has(next)) continue;
      previous.set(next, current);
      if (next === target) {
        const path = [target];
        let cursor: string | null = current;
        while (cursor) {
          path.push(cursor);
          cursor = previous.get(cursor) ?? null;
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }

  return [start];
}

function closedWalkForComponent(nodes: string[], adj: Map<string, string[]>): string[] {
  const sortedNodes = [...nodes].sort();
  const allowed = new Set(sortedNodes);
  const start = sortedNodes[0];
  const walk = [start];
  let current = start;

  for (const target of sortedNodes.slice(1)) {
    const path = findPath(current, target, adj, allowed);
    walk.push(...path.slice(1));
    current = target;
  }

  const returnPath = findPath(current, start, adj, allowed);
  walk.push(...returnPath.slice(1));
  return walk;
}

function stronglyConnectedComponents(edges: GraphEdge[]): string[][] {
  const adj = new Map<string, string[]>();
  const nodes = new Set<string>();

  for (const edge of edges) {
    nodes.add(edge.source);
    nodes.add(edge.target);
    if (!adj.has(edge.source)) adj.set(edge.source, []);
    adj.get(edge.source)!.push(edge.target);
  }

  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;

  const visit = (node: string) => {
    index.set(node, nextIndex);
    lowlink.set(node, nextIndex);
    nextIndex++;
    stack.push(node);
    onStack.add(node);

    for (const next of adj.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        lowlink.set(node, Math.min(lowlink.get(node)!, lowlink.get(next)!));
      } else if (onStack.has(next)) {
        lowlink.set(node, Math.min(lowlink.get(node)!, index.get(next)!));
      }
    }

    if (lowlink.get(node) === index.get(node)) {
      const component: string[] = [];
      while (true) {
        const current = stack.pop()!;
        onStack.delete(current);
        component.push(current);
        if (current === node) break;
      }
      components.push(component);
    }
  };

  for (const node of Array.from(nodes).sort()) {
    if (!index.has(node)) visit(node);
  }

  return components;
}

export function groupWarningEdges(warningEdges: GraphEdge[]): WarningGroup[] {
  const result: WarningGroup[] = [];
  const circularEdges = warningEdges.filter((edge) => edge.relation === 'circular_dependency');

  for (const edge of warningEdges) {
    if (edge.relation === 'circular_dependency') continue;
    result.push({
      type: edge.relation === 'violates_boundary' ? 'boundary' : 'other',
      key: `sus_${edgeKey(edge)}`,
      edges: [edge],
      score: edge.score,
    });
  }

  if (circularEdges.length > 0) {
    const adj = new Map<string, string[]>();
    for (const edge of circularEdges) {
      if (!adj.has(edge.source)) adj.set(edge.source, []);
      adj.get(edge.source)!.push(edge.target);
    }

    for (const component of stronglyConnectedComponents(circularEdges)) {
      const nodeSet = new Set(component);
      const componentEdges = circularEdges.filter((edge) => nodeSet.has(edge.source) && nodeSet.has(edge.target));
      const hasCycle = component.length > 1 || componentEdges.some((edge) => edge.source === edge.target);
      if (!hasCycle || componentEdges.length === 0) continue;

      const nodeIds = [...nodeSet].sort();
      const cycleNodes = closedWalkForComponent(nodeIds, adj);
      result.push({
        type: 'cycle',
        key: `cycle_${nodeIds.join('_')}`,
        edges: componentEdges,
        nodeIds,
        cycleNodes,
        score: Math.max(...componentEdges.map((edge) => edge.score)),
      });
    }
  }

  return result.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}
