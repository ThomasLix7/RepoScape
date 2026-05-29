export function detectCycleEdges(
  nodes: string[],
  edges: { source: string; target: string }[]
): Map<string, number> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }

  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let idx = 0;
  const cycleEdges = new Map<string, number>();

  interface DFSFrame {
    u: string;
    neighbors: string[];
    nextNeighborIndex: number;
  }

  const visited = new Set<string>();

  for (const startNode of nodes) {
    if (visited.has(startNode)) continue;

    const dfsStack: DFSFrame[] = [
      {
        u: startNode,
        neighbors: adj.get(startNode) || [],
        nextNeighborIndex: 0,
      },
    ];

    while (dfsStack.length > 0) {
      const frame = dfsStack[dfsStack.length - 1];
      const u = frame.u;

      if (frame.nextNeighborIndex === 0) {
        visited.add(u);
        index.set(u, idx);
        lowlink.set(u, idx);
        idx++;
        stack.push(u);
        onStack.add(u);
      }

      if (frame.nextNeighborIndex < frame.neighbors.length) {
        const v = frame.neighbors[frame.nextNeighborIndex];
        frame.nextNeighborIndex++;

        if (!visited.has(v)) {
          dfsStack.push({
            u: v,
            neighbors: adj.get(v) || [],
            nextNeighborIndex: 0,
          });
        } else if (onStack.has(v)) {
          lowlink.set(u, Math.min(lowlink.get(u)!, index.get(v)!));
        }
      } else {
        dfsStack.pop();
        if (dfsStack.length > 0) {
          const parentFrame = dfsStack[dfsStack.length - 1];
          const p = parentFrame.u;
          lowlink.set(p, Math.min(lowlink.get(p)!, lowlink.get(u)!));
        }

        if (lowlink.get(u) === index.get(u)) {
          const component: string[] = [];
          while (true) {
            const w = stack.pop()!;
            onStack.delete(w);
            component.push(w);
            if (w === u) break;
          }

          if (component.length > 1) {
            const compSet = new Set(component);
            const riskScore = Math.min(1.0, 0.4 + 0.1 * component.length);
            for (const src of component) {
              const neighbors = adj.get(src) || [];
              for (const dst of neighbors) {
                if (compSet.has(dst)) {
                  cycleEdges.set(`${src}->${dst}`, riskScore);
                }
              }
            }
          }
        }
      }
    }
  }
  return cycleEdges;
}
