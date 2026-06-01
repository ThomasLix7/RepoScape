import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { connectHUD, fetchTours, deleteTourReq, GraphNode, GraphEdge, GraphDiff, HUDConnection, Tour, CommunitySummary, NeighborsContext, Neighbor } from '../connection.js';
import { CanvasRenderer } from './CanvasRenderer.js';
import { Sidebar } from './Sidebar.js';

const INITIAL_TOKEN = new URLSearchParams(window.location.search).get('token') || '';

const FOCUS_TTL_MS = 5000;
const CHANGED_TTL_MS = 10000;

// Let the camera fly/frame the beat's nodes before the narration starts speaking,
// so the voice lands on a view that has already arrived ("指哪说哪").
const BEAT_SPEAK_DELAY_MS = 400;

function getToken(): string {
  return INITIAL_TOKEN;
}

// Filter out community re-clustering and line shift noise using contentHash.
function isCodeChange(prev: GraphNode, next: GraphNode): boolean {
  if (prev.label !== next.label || prev.source_file !== next.source_file) return true;
  if (prev.contentHash !== undefined || next.contentHash !== undefined) {
    return prev.contentHash !== next.contentHash;
  }
  return false;
}

function renderRichSubtitle(text: string) {
  if (!text) return null;
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={index}
          style={{
            fontFamily: 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
            background: 'rgba(0, 243, 255, 0.18)',
            border: '1px solid rgba(0, 243, 255, 0.35)',
            borderRadius: '4px',
            padding: '1px 5px',
            margin: '0 3px',
            color: '#00f3ff',
            fontSize: '92%',
          }}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={index} style={{ color: '#ffffff', fontWeight: '700', textShadow: '0 0 8px rgba(255,255,255,0.2)' }}>
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
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
  const [pendingWarningFocus, setPendingWarningFocus] = useState<{ edge: GraphEdge; nodeIds: string[] } | null>(null);
  const [showPhysical, setShowPhysical] = useState(true);
  const [showCognitive, setShowCognitive] = useState(true);
  const [showSuspicious, setShowSuspicious] = useState(true);

  const [searchQuery, setSearchQuery] = useState('');

  // Narrated tours: persisted history loaded on mount + live appends over WS. The
  // selected tour waits for a one-click start (browsers block speechSynthesis until a
  // user gesture).
  const [tours, setTours] = useState<Tour[]>([]);
  const [activeTourId, setActiveTourId] = useState<string | null>(null);
  const [tourActive, setTourActive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [subtitle, setSubtitle] = useState('');
  const [beatIdx, setBeatIdx] = useState(0);
  const tourRef = useRef<{ beats: Tour['beats']; idx: number } | null>(null);
  const pausedRef = useRef(false);
  // Mirror of tourActive read inside handleTour, which must stay referentially stable
  // (it's a dep of the connection effect) — reading the state directly would either go
  // stale or force a WS reconnect on every play/stop.
  const tourActiveRef = useRef(false);
  const setTourActiveBoth = useCallback((v: boolean) => {
    tourActiveRef.current = v;
    setTourActive(v);
  }, []);
  const beatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeTour = useMemo(
    () => tours.find((t) => t.id === activeTourId) ?? null,
    [tours, activeTourId]
  );

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
    if (e.type === 'SUSPICIOUS') return `sus_${e.source}->${e.target}_${e.relation}`;
    return `${e.source}->${e.target}_${e.relation}`;
  };

  const handleDiff = useCallback((diff: GraphDiff) => {
    setNodes((prev) => {
      const map = new Map(prev.map((n) => [n.id, n]));
      const changedTtl = Date.now() + CHANGED_TTL_MS;
      for (const id of diff.removedNodes) map.delete(id);
      for (const node of diff.addedNodes) map.set(node.id, { ...node, changed: true, changedTtl });
      for (const update of diff.updatedNodes) {
        const existing = map.get(update.id!);
        if (!existing) continue;
        // Apply all updates; only flag `changed` when actual code changed.
        const merged = { ...existing, ...update };
        if (isCodeChange(existing, update as GraphNode)) {
          merged.changed = true;
          merged.changedTtl = changedTtl;
        }
        map.set(update.id!, merged);
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

  // Drive the focus highlight from an explicit set of node ids (the tour path),
  // as opposed to handleFocus which matches by source_file. Setting focus with no
  // focusTtl keeps a beat lit until the next beat replaces it (the periodic TTL
  // sweep only clears nodes that carry a focusTtl).
  const applyFocusByIds = useCallback((ids: Set<string>) => {
    setNodes((prev) =>
      prev.map((n) => {
        const want = ids.has(n.id);
        if (want) return n.focus && !n.focusTtl ? n : { ...n, focus: true, focusTtl: undefined };
        return n.focus ? { ...n, focus: false } : n;
      })
    );
  }, []);

  const playBeat = useCallback(() => {
    const t = tourRef.current;
    if (!t) return;
    if (t.idx >= t.beats.length) {
      tourRef.current = null;
      pausedRef.current = false;
      applyFocusByIds(new Set());
      setTourActiveBoth(false);
      setPaused(false);
      setSubtitle('');
      return;
    }
    const beat = t.beats[t.idx];
    setBeatIdx(t.idx);
    // Move the camera/highlight first (ids matching no node are silently skipped).
    applyFocusByIds(new Set(beat.nodes));
    setSubtitle(beat.say);

    let advanced = false;
    const advance = () => {
      if (advanced || tourRef.current !== t || pausedRef.current) return;
      advanced = true;
      if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
      t.idx += 1;
      playBeat();
    };

    // Delay narration so the voice lands after the camera has begun arriving.
    if (beatTimerRef.current) clearTimeout(beatTimerRef.current);
    beatTimerRef.current = setTimeout(() => {
      if (tourRef.current !== t) return;
      const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
      const estMs = Math.max(2500, beat.say.length * 90);
      if (synth) {
        // Strip markdown backticks and asterisks to ensure clean voice synthesis without symbol narration
        const cleanSpeechText = beat.say.replace(/[`*]/g, '');
        const utter = new SpeechSynthesisUtterance(cleanSpeechText);
        if (beat.lang) utter.lang = beat.lang;
        utter.onend = advance;
        utter.onerror = advance;
        synth.speak(utter);
        // Watchdog: if onend never fires (no installed voice, etc.) keep the tour moving.
        watchdogRef.current = setTimeout(advance, estMs + 8000);
      } else {
        watchdogRef.current = setTimeout(advance, estMs);
      }
    }, BEAT_SPEAK_DELAY_MS);
  }, [applyFocusByIds, setTourActiveBoth]);

  // Handle incoming WS tour updates
  const handleTour = useCallback((tour: Tour) => {
    setTours((prev) => {
      const next = prev.filter((t) => t.id !== tour.id); // upsert: GET may already hold it
      return [tour, ...next].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    });
    if (!tourActiveRef.current && tour.id) {
      setActiveTourId(tour.id);
    }
  }, []);

  // Pause active tour
  const pauseTour = useCallback(() => {
    pausedRef.current = true;
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
    if (beatTimerRef.current) { clearTimeout(beatTimerRef.current); beatTimerRef.current = null; }
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
    setPaused(true);
  }, []);

  const resumeTour = useCallback(() => {
    if (!tourRef.current) return;
    pausedRef.current = false;
    setPaused(false);
    playBeat();
  }, [playBeat]);

  const startTour = useCallback((id?: string) => {
    const tour = id ? tours.find((t) => t.id === id) ?? null : activeTour;
    if (!tour) return;
    if (id && id !== activeTourId) setActiveTourId(id);
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
    if (beatTimerRef.current) { clearTimeout(beatTimerRef.current); beatTimerRef.current = null; }
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
    pausedRef.current = false;
    setPaused(false);
    tourRef.current = { beats: tour.beats, idx: 0 };
    setTourActiveBoth(true);
    playBeat();
  }, [tours, activeTour, activeTourId, playBeat, setTourActiveBoth]);


  const replayTour = useCallback(() => {
    startTour(activeTourId ?? undefined);
  }, [startTour, activeTourId]);

  const dismissTour = useCallback(() => {
    tourRef.current = null;
    pausedRef.current = false;
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
    if (beatTimerRef.current) { clearTimeout(beatTimerRef.current); beatTimerRef.current = null; }
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
    applyFocusByIds(new Set());
    setTourActiveBoth(false);
    setPaused(false);
    setSubtitle('');
    setActiveTourId(null);
  }, [applyFocusByIds, setTourActiveBoth]);

  const previewTour = useCallback((id: string) => {
    const tour = tours.find((t) => t.id === id);
    if (!tour) return;
    setActiveTourId(id);
    const ids = new Set<string>();
    for (const beat of tour.beats) for (const n of beat.nodes) ids.add(n);
    applyFocusByIds(ids);
    rendererRef.current?.flyToNodes(Array.from(ids));
  }, [tours, applyFocusByIds]);

  const removeTour = useCallback((id: string) => {
    deleteTourReq(getToken(), id)
      .then(() => {
        setTours((prev) => prev.filter((t) => t.id !== id));
        if (id === activeTourId) dismissTour();
      })
      .catch(() => {});
  }, [activeTourId, dismissTour]);

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
      if (beatTimerRef.current) clearTimeout(beatTimerRef.current);
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
    };
  }, []);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    fetchTours(token).then(setTours).catch(() => {});
  }, []);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setStatus('no_token');
      return;
    }

    const conn = connectHUD(token, handleDiff, handleFullGraph, handleStatusChange, handleFocus, handleTour);
    connectionRef.current = conn;

    return () => conn.close();
  }, [handleDiff, handleFullGraph, handleStatusChange, handleFocus, handleTour]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setNodes((prev) => {
        let mutated = false;
        const next = prev.map((n) => {
          let m = n;
          if (m.focus && m.focusTtl && now > m.focusTtl) {
            m = { ...m, focus: false };
            mutated = true;
          }
          if (m.changed && m.changedTtl && now > m.changedTtl) {
            m = { ...m, changed: false };
            mutated = true;
          }
          return m;
        });
        return mutated ? next : prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Faceted base: path + node-type filters only, WITHOUT the community filter.
  // The community summary builds on this so toggling one community never makes
  // the others vanish from the list (the classic faceted-search deadlock).
  const baseFilteredNodes = useMemo(() => {
    return nodes.filter(n => {
      if (!activeFileTypes.has(n.file_type)) return false;
      if (pathPrefix && !n.source_file.startsWith(pathPrefix)) return false;
      return true;
    });
  }, [nodes, activeFileTypes, pathPrefix]);

  const filteredNodes = useMemo(() => {
    if (!activeCommunities) return baseFilteredNodes;
    return baseFilteredNodes.filter(n => activeCommunities.has(n.community ?? 0));
  }, [baseFilteredNodes, activeCommunities]);

  const visibleNodeIds = useMemo(() => new Set(filteredNodes.map(n => n.id)), [filteredNodes]);

  const filteredEdges = useMemo(() => {
    return edges.filter(e => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target));
  }, [edges, visibleNodeIds]);

  const warningEdges = useMemo(() => {
    return edges
      .filter(e => e.type === 'SUSPICIOUS')
      .sort((a, b) => b.score - a.score || a.relation.localeCompare(b.relation));
  }, [edges]);

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return nodes.filter(n =>
      n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)
    );
  }, [searchQuery, nodes]);

  const nodeMap = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);

  const communitiesSummary = useMemo<CommunitySummary[]>(() => {
    const total = baseFilteredNodes.length;
    if (total === 0) return [];

    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }

    const communityMembers = new Map<number, GraphNode[]>();
    for (const n of baseFilteredNodes) {
      const cid = n.community ?? 0;
      if (!communityMembers.has(cid)) communityMembers.set(cid, []);
      communityMembers.get(cid)!.push(n);
    }

    const summaries: CommunitySummary[] = [];
    for (const [id, members] of communityMembers.entries()) {
      const folderCounts = new Map<string, number>();
      for (const n of members) {
        const parts = n.source_file.split('/');
        const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '(root)';
        folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1);
      }
      let dominantFolder = '';
      let maxCount = 0;
      for (const [folder, count] of folderCounts.entries()) {
        if (count > maxCount) { maxCount = count; dominantFolder = folder; }
      }

      let bestDegree = -1;
      let hubNodeFile = '';
      for (const n of members) {
        const d = degree.get(n.id) ?? 0;
        if (d > bestDegree) {
          bestDegree = d;
          hubNodeFile = n.source_file;
        }
      }
      const hubNodeName = hubNodeFile ? (hubNodeFile.split('/').pop() || '') : 'N/A';

      summaries.push({
        id,
        size: members.length,
        percentage: Math.round((members.length / total) * 100),
        dominantFolder,
        hubNodeName,
      });
    }

    summaries.sort((a, b) => b.size - a.size);
    return summaries;
  }, [baseFilteredNodes, edges]);

  const selectedNodeNeighbors = useMemo<NeighborsContext>(() => {
    if (!selectedNode) return { incoming: [], outgoing: [] };
    const incomingMap = new Map<string, Neighbor>();
    const outgoingMap = new Map<string, Neighbor>();
    for (const edge of edges) {
      if (edge.target === selectedNode.id) {
        const src = nodeMap.get(edge.source);
        const key = `${edge.source}_${edge.relation}`;
        if (src && !incomingMap.has(key)) incomingMap.set(key, { node: src, edge });
      }
      if (edge.source === selectedNode.id) {
        const tgt = nodeMap.get(edge.target);
        const key = `${edge.target}_${edge.relation}`;
        if (tgt && !outgoingMap.has(key)) outgoingMap.set(key, { node: tgt, edge });
      }
    }
    return { incoming: Array.from(incomingMap.values()), outgoing: Array.from(outgoingMap.values()) };
  }, [selectedNode, edges, nodeMap]);

  useEffect(() => {
    rendererRef.current?.setHighlightedNodes(
      new Set(searchResults.map(n => n.id))
    );
  }, [searchResults]);

  const handleSearchSelect = (nodeId: string) => {
    if (!nodeId) {
      setSelectedNode(null);
      setSelectedEdge(null);
      rendererRef.current?.setSelectedNode(null);
      rendererRef.current?.setSelectedEdge(null);
      return;
    }
    rendererRef.current?.flyToNode(nodeId);
    rendererRef.current?.setSelectedNode(nodeId);
    setSelectedNode(nodes.find(n => n.id === nodeId) ?? null);
    setSelectedEdge(null);
    rendererRef.current?.setSelectedEdge(null);
    setSearchQuery('');
  };

  const selectEdgeAndFocus = useCallback((edge: GraphEdge, nodeIds: string[]) => {
    const focusNodeIds = nodeIds.length > 0 ? nodeIds : [edge.source, edge.target];

    setSelectedEdge(edge);
    setSelectedNode(null);
    rendererRef.current?.setSelectedNode(null);
    rendererRef.current?.setSelectedEdge(edge);
    setSearchQuery('');
    setPathPrefix('');
    setActiveCommunities(null);
    setActiveFileTypes(prev => {
      const next = new Set(prev);
      for (const id of focusNodeIds) {
        const node = nodeMap.get(id);
        if (node) next.add(node.file_type);
      }
      return next;
    });
    setPendingWarningFocus({ edge, nodeIds: focusNodeIds });
  }, [nodeMap]);

  const handleWarningSelect = useCallback((edge: GraphEdge, nodeIds: string[] = [edge.source, edge.target]) => {
    setShowSuspicious(true);
    selectEdgeAndFocus(edge, nodeIds);
  }, [selectEdgeAndFocus]);

  const handleEdgeInspect = useCallback((edge: GraphEdge) => {
    if (edge.type === 'PHYSICAL') setShowPhysical(true);
    else if (edge.type === 'COGNITIVE') setShowCognitive(true);
    else setShowSuspicious(true);
    selectEdgeAndFocus(edge, [edge.source, edge.target]);
  }, [selectEdgeAndFocus]);

  useEffect(() => {
    if (!pendingWarningFocus) return;
    const visibleFocusIds = pendingWarningFocus.nodeIds.filter(id => visibleNodeIds.has(id));
    if (visibleFocusIds.length === 0) return;
    rendererRef.current?.flyToNodes(visibleFocusIds);
    setPendingWarningFocus(null);
  }, [pendingWarningFocus, visibleNodeIds]);

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
      renderer.setSelectedEdge(null);
    };

    renderer.onEdgeClick = (edge: GraphEdge | null) => {
      setSelectedEdge(edge);
      setSelectedNode(null);
      renderer.setSelectedEdge(edge);
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
      {activeTour && !tourActive && (
        <button
          onClick={() => startTour()}
          style={{
            position: 'fixed',
            bottom: 28,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 10,
            padding: '10px 20px',
            borderRadius: 999,
            border: '1px solid #00f3ff',
            background: '#00f3ff',
            color: '#0d1117',
            font: '600 14px system-ui, sans-serif',
            cursor: 'pointer',
            boxShadow: '0 2px 16px rgba(0,243,255,0.35)',
          }}
        >
          {`▶ Play Tour (${activeTour.beats.length})`}
        </button>
      )}
      {tourActive && (
        <div
          onClick={paused ? resumeTour : pauseTour}
          title={paused ? 'Click to resume' : 'Click to pause'}
          style={{
            position: 'fixed',
            bottom: 28,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            maxWidth: 'min(820px, 86vw)',
            padding: '10px 20px',
            borderRadius: 14,
            border: '1px solid rgba(0,243,255,0.18)',
            background: 'rgba(13,17,23,0.42)',
            backdropFilter: 'blur(14px) saturate(140%)',
            WebkitBackdropFilter: 'blur(14px) saturate(140%)',
            color: '#f0f6fc',
            boxShadow: '0 8px 30px rgba(0,0,0,0.4)',
            cursor: 'pointer',
            animation: 'tourBoxIn 260ms cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                border: '1px solid rgba(0,243,255,0.3)',
                background: 'rgba(0,243,255,0.08)',
                color: '#00f3ff',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                boxShadow: '0 0 8px rgba(0,243,255,0.15)',
                transition: 'all 150ms ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(0,243,255,0.2)';
                e.currentTarget.style.transform = 'scale(1.1)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(0,243,255,0.08)';
                e.currentTarget.style.transform = 'scale(1)';
              }}
            >
              {paused ? '▶' : '⏸'}
            </div>
            <span
              style={{
                font: '700 11px system-ui, sans-serif',
                letterSpacing: 0.4,
                color: '#00f3ff',
                opacity: 0.85,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {Math.min(beatIdx + 1, activeTour?.beats.length ?? 0)}/{activeTour?.beats.length ?? 0}
            </span>
          </div>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              font: '500 16px/1.5 system-ui, sans-serif',
              textAlign: 'left',
              opacity: subtitle ? (paused ? 0.5 : 1) : 0,
              transition: 'opacity 320ms ease',
            }}
          >
            {renderRichSubtitle(subtitle)}
          </span>
        </div>
      )}
      <Sidebar
        status={status}
        attemptsLeft={attemptsLeft}
        selectedNode={selectedNode}
        selectedEdge={selectedEdge}
        warningEdges={warningEdges}
        nodesById={nodeMap}
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
        onWarningSelect={handleWarningSelect}
        onEdgeInspect={handleEdgeInspect}
        activeFileTypes={activeFileTypes}
        activeCommunities={activeCommunities}
        pathPrefix={pathPrefix}
        onToggleFileType={handleToggleFileType}
        onSetCommunities={handleSetCommunities}
        onSetPathPrefix={handleSetPathPrefix}
        communitiesSummary={communitiesSummary}
        selectedNodeNeighbors={selectedNodeNeighbors}
        hubNodes={hubNodes}
        baseFilteredNodes={baseFilteredNodes}
        tours={tours}
        activeTourId={activeTourId}
        tourActive={tourActive}
        onPlayTour={(id) => startTour(id)}
        onReplayTour={replayTour}
        onStopTour={dismissTour}
        onPreviewTour={previewTour}
        onDeleteTour={removeTour}
      />
    </div>
  );
}
