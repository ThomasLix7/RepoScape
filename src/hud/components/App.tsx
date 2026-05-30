import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { connectHUD, GraphNode, GraphEdge, GraphDiff, HUDConnection } from '../connection.js';
import { CanvasRenderer } from './CanvasRenderer.js';
import { Sidebar } from './Sidebar.js';

const INITIAL_TOKEN = new URLSearchParams(window.location.search).get('token') || '';

// Duration (ms) a node stays highlighted after its last "edited" signal.
const FOCUS_TTL_MS = 8000;

function getToken(): string {
  return INITIAL_TOKEN;
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

  const [searchQuery, setSearchQuery] = useState('');

  const [activeFileTypes, setActiveFileTypes] = useState<Set<string>>(
    new Set(['code', 'document', 'concept'])
  );
  const [activeCommunities, setActiveCommunities] = useState<Set<number> | null>(null);
  const [pathPrefix, setPathPrefix] = useState('');

  const renderStateRef = useRef({
    nodes: [] as GraphNode[],
    edges: [] as GraphEdge[],
    showPhysical: true,
    showCognitive: true,
    showSuspicious: true,
    hubNodes: new Set<string>(),
  });

  // Must mirror the server's getEdgeMapKey (compiler.ts) so removedEdges keys match.
  const edgeKey = (e: GraphEdge) => {
    if (e.type === 'COGNITIVE') return `cog_${e.source}->${e.target}_${e.relation}`;
    if (e.type === 'SUSPICIOUS') return `sus_${e.source}->${e.target}`;
    return `${e.source}->${e.target}_${e.relation}`;
  };

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
      for (const edge of diff.updatedEdges) map.set(edgeKey(edge), edge);
      return Array.from(map.values());
    });

    if (diff.hubNodes) {
      setHubNodes(new Set(diff.hubNodes));
    }

    if (rendererRef.current) {
      rendererRef.current.wakeSimulation();
    }

    if (diff.removedNodes.length) rendererRef.current?.removeNodes(diff.removedNodes);
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

  const handleFocus = useCallback((event: { file: string; activity?: string; impacted_nodes?: string[] }) => {
    setNodes((prev) =>
      prev.map((n) => {
        if (n.source_file === event.file) {
          return { ...n, focus: true, activity: event.activity || n.activity, focusTtl: Date.now() + FOCUS_TTL_MS };
        }
        return n;
      })
    );
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

  // Periodic sweep to clear expired focus highlights.
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setNodes((prev) => {
        let changed = false;
        const next = prev.map((n) => {
          if (n.focus && n.focusTtl && now > n.focusTtl) {
            changed = true;
            return { ...n, focus: false };
          }
          return n;
        });
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const filteredNodes = useMemo(() => {
    return nodes.filter(n => {
      if (!activeFileTypes.has(n.file_type)) return false;
      if (activeCommunities && !activeCommunities.has(n.community ?? 0)) return false;
      if (pathPrefix && !n.source_file.startsWith(pathPrefix)) return false;
      return true;
    });
  }, [nodes, activeFileTypes, activeCommunities, pathPrefix]);

  const visibleNodeIds = useMemo(() => new Set(filteredNodes.map(n => n.id)), [filteredNodes]);

  const filteredEdges = useMemo(() => {
    return edges.filter(e => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target));
  }, [edges, visibleNodeIds]);

  const availableCommunities = useMemo(
    () => [...new Set(nodes.map(n => n.community ?? 0))].sort((a, b) => a - b),
    [nodes]
  );

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return nodes.filter(n =>
      n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)
    );
  }, [searchQuery, nodes]);

  useEffect(() => {
    rendererRef.current?.setHighlightedNodes(
      new Set(searchResults.map(n => n.id))
    );
  }, [searchResults]);

  const handleSearchSelect = (nodeId: string) => {
    rendererRef.current?.flyToNode(nodeId);
    setSelectedNode(nodes.find(n => n.id === nodeId) ?? null);
    setSearchQuery('');
  };

  const handleToggleFileType = useCallback((ft: string) => {
    setActiveFileTypes(prev => {
      const next = new Set(prev);
      if (next.has(ft)) next.delete(ft);
      else next.add(ft);
      return next;
    });
  }, []);

  const handleSetCommunities = useCallback((c: Set<number> | null) => {
    setActiveCommunities(c);
  }, []);

  const handleSetPathPrefix = useCallback((p: string) => {
    setPathPrefix(p);
  }, []);

  useEffect(() => {
    if (!canvasRef.current) return;

    const renderer = new CanvasRenderer(canvasRef.current);
    rendererRef.current = renderer;

    renderer.onNodeClick = (node: GraphNode | null) => {
      setSelectedNode(node);
      setSelectedEdge(null);
    };

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
      const s = renderStateRef.current;
      renderer.render(s.nodes, s.edges, {
        showPhysical: s.showPhysical,
        showCognitive: s.showCognitive,
        showSuspicious: s.showSuspicious,
        hubNodes: s.hubNodes,
        dtMs,
      });
      animId = requestAnimationFrame(loop);
    };
    animId = requestAnimationFrame(loop);

    return () => { cancelAnimationFrame(animId); renderer.destroy(); };
  }, []);

  renderStateRef.current = {
    nodes: filteredNodes,
    edges: filteredEdges,
    showPhysical,
    showCognitive,
    showSuspicious,
    hubNodes,
  };

  return (
    <div style={{ display: 'flex', width: '100vw', height: '100vh' }}>
      <canvas
        ref={canvasRef}
        style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'block', cursor: 'grab' }}
      />
      <Sidebar
        status={status}
        attemptsLeft={attemptsLeft}
        selectedNode={selectedNode}
        selectedEdge={selectedEdge}
        nodeCount={filteredNodes.length}
        edgeCount={filteredEdges.length}
        showPhysical={showPhysical}
        showCognitive={showCognitive}
        showSuspicious={showSuspicious}
        onTogglePhysical={() => setShowPhysical(!showPhysical)}
        onToggleCognitive={() => setShowCognitive(!showCognitive)}
        onToggleSuspicious={() => setShowSuspicious(!showSuspicious)}
        searchQuery={searchQuery}
        searchResults={searchResults}
        onSearchChange={setSearchQuery}
        onSearchSelect={handleSearchSelect}
        availableCommunities={availableCommunities}
        activeFileTypes={activeFileTypes}
        activeCommunities={activeCommunities}
        pathPrefix={pathPrefix}
        onToggleFileType={handleToggleFileType}
        onSetCommunities={handleSetCommunities}
        onSetPathPrefix={handleSetPathPrefix}
      />
    </div>
  );
}
