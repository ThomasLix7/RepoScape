import React, { useRef, useEffect, useState, useCallback } from 'react';
import { connectHUD, GraphNode, GraphEdge, GraphDiff, HUDConnection } from '../connection.js';
import { CanvasRenderer } from './CanvasRenderer.js';
import { Sidebar } from './Sidebar.js';

function getToken(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('token') || '';
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);
  const connectionRef = useRef<HUDConnection | null>(null);

  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [hubNodes, setHubNodes] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('connecting');
  const [attemptsLeft, setAttemptsLeft] = useState(50);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);
  const [showPhysical, setShowPhysical] = useState(true);
  const [showCognitive, setShowCognitive] = useState(true);
  const [showSuspicious, setShowSuspicious] = useState(true);

  // §6.C: Track all focus timers in a ref-backed Set for cleanup
  const focusTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const edgeKey = (e: GraphEdge) => `${e.source}->${e.target}_${e.relation}`;

  const handleDiff = useCallback((diff: GraphDiff) => {
    setNodes((prev) => {
      const map = new Map(prev.map((n) => [n.id, n]));
      for (const id of diff.removedNodes) map.delete(id);
      for (const node of diff.addedNodes) map.set(node.id, node);
      for (const update of diff.updatedNodes) {
        const existing = map.get(update.id!);
        if (existing) map.set(update.id!, { ...existing, ...update });
      }
      return Array.from(map.values());
    });

    setEdges((prev) => {
      const map = new Map(prev.map((e) => [edgeKey(e), e]));
      for (const key of diff.removedEdges) map.delete(key);
      for (const edge of diff.addedEdges) map.set(edgeKey(edge), edge);
      return Array.from(map.values());
    });

    // §4: Update hubNodes from diff
    if (diff.hubNodes) {
      setHubNodes(new Set(diff.hubNodes));
    }

    // §6.A: Wake d3-force simulation on non-empty GraphDiff
    if (rendererRef.current) {
      rendererRef.current.wakeSimulation();
    }
  }, []);

  const handleFullGraph = useCallback(
    (graph: { nodes: GraphNode[]; edges: GraphEdge[]; hubNodes?: string[] }) => {
      setNodes(graph.nodes);
      setEdges(graph.edges);
      if (graph.hubNodes) {
        setHubNodes(new Set(graph.hubNodes));
      }
    },
    []
  );

  const handleStatusChange = useCallback((s: string, left?: number) => {
    setStatus(s);
    if (left !== undefined) setAttemptsLeft(left);
  }, []);

  // §2C: Handle focus events from daemon
  const handleFocus = useCallback((event: { file: string; activity?: string; impacted_nodes?: string[] }) => {
    setNodes((prev) =>
      prev.map((n) => {
        if (n.source_file === event.file) {
          return { ...n, focus: true, activity: event.activity || n.activity, focusTtl: Date.now() + 60000 };
        }
        return n;
      })
    );
    // §6.C: Track timer in ref-backed Set for cleanup
    const timer = setTimeout(() => {
      focusTimersRef.current.delete(timer);
      setNodes((prev) =>
        prev.map((n) => {
          if (n.source_file === event.file && n.focusTtl && Date.now() > n.focusTtl) {
            return { ...n, focus: false };
          }
          return n;
        })
      );
    }, 61000);
    focusTimersRef.current.add(timer);
  }, []);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setStatus('no_token');
      return;
    }

    const conn = connectHUD(token, handleDiff, handleFullGraph, handleStatusChange, handleFocus);
    connectionRef.current = conn;

    return () => conn.close();
  }, [handleDiff, handleFullGraph, handleStatusChange, handleFocus]);

  // §6.C: Cleanup all focus timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of focusTimersRef.current) {
        clearTimeout(timer);
      }
      focusTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!canvasRef.current) return;

    const renderer = new CanvasRenderer(canvasRef.current);
    rendererRef.current = renderer;

    renderer.onNodeClick = (node: GraphNode | null) => {
      setSelectedNode(node);
      setSelectedEdge(null);
    };

    // §4: Handle edge clicks for COGNITIVE audit popup
    renderer.onEdgeClick = (edge: GraphEdge | null) => {
      setSelectedEdge(edge);
      setSelectedNode(null);
    };

    let animId: number;
    let lastTime = performance.now();
    const loop = () => {
      const now = performance.now();
      const dtMs = now - lastTime;
      lastTime = now;

      renderer.render(nodes, edges, {
        showPhysical,
        showCognitive,
        showSuspicious,
        hubNodes,
        dtMs,
      });
      animId = requestAnimationFrame(loop);
    };
    animId = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(animId);
  }, [nodes, edges, showPhysical, showCognitive, showSuspicious, hubNodes]);

  return (
    <div style={{ display: 'flex', width: '100vw', height: '100vh' }}>
      <canvas
        ref={canvasRef}
        style={{ flex: 1, cursor: 'grab' }}
      />
      <Sidebar
        status={status}
        attemptsLeft={attemptsLeft}
        selectedNode={selectedNode}
        selectedEdge={selectedEdge}
        nodeCount={nodes.length}
        edgeCount={edges.length}
        showPhysical={showPhysical}
        showCognitive={showCognitive}
        showSuspicious={showSuspicious}
        onTogglePhysical={() => setShowPhysical(!showPhysical)}
        onToggleCognitive={() => setShowCognitive(!showCognitive)}
        onToggleSuspicious={() => setShowSuspicious(!showSuspicious)}
      />
    </div>
  );
}
