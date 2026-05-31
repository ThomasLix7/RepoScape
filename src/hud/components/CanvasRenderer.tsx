import { GraphNode, GraphEdge } from '../connection.js';
import { suppressPhysicalEdgesCoveredBySuspicious } from '../edgeVisibility.js';

interface RenderOptions {
  showPhysical: boolean;
  showCognitive: boolean;
  showSuspicious: boolean;
  hubNodes?: Set<string>;
  dtMs?: number;
}

interface Camera {
  x: number;
  y: number;
  zoom: number;
  targetX: number;
  targetY: number;
  targetZoom: number;
  vx: number;
  vy: number;
}

interface D3Node {
  id: string;
  community?: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  index?: number;
}

interface D3Edge {
  source: string;
  target: string;
}

export class CanvasRenderer {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private camera: Camera = { x: 0, y: 0, zoom: 1, targetX: 0, targetY: 0, targetZoom: 1, vx: 0, vy: 0 };
  private isDragging = false;
  private lastMouse = { x: 0, y: 0 };
  private nodePositions = new Map<string, { x: number; y: number }>();
  private hoveredNode: GraphNode | null = null;
  private currentEdges: GraphEdge[] = [];
  private currentOptions: RenderOptions = { showPhysical: true, showCognitive: true, showSuspicious: true };
  public onNodeClick: ((node: GraphNode | null) => void) | null = null;
  public onEdgeClick: ((edge: GraphEdge | null) => void) | null = null;

  private nodeSizes = new Map<string, number>();
  private nodeCommunity = new Map<string, number>();
  private adjacency = new Map<string, Set<string>>();
  private selectedNodeId: string | null = null;
  private selectedEdge: GraphEdge | null = null;
  private edgesSignature = '';
  private userInteracted = false;
  private didPan = false;

  private d3Simulation: any = null;
  private d3Nodes: D3Node[] = [];
  private d3Edges: D3Edge[] = [];
  private simulationTimer: ReturnType<typeof setInterval> | null = null;
  private d3Module: any = null;

  private draggedNode: D3Node | null = null;
  private pinnedNodes = new Set<string>();
  private didDrag = false;
  private suppressNextClick = false;

  private highlightedNodes = new Set<string>();

  // Track focus set to drive the camera, and remember the pre-focus view to restore.
  private lastFocusSignature = '';
  private preFocusCamera: { x: number; y: number; zoom: number } | null = null;

  private lastFrameHash = '';
  private frameSkipCount = 0;
  private lastNodes: GraphNode[] | null = null;
  private lastEdges: GraphEdge[] | null = null;
  private nodeById = new Map<string, GraphNode>();

  private labelCache = new Map<string, { img: HTMLCanvasElement; w: number; h: number }>();
  private static readonly LABEL_FONT_PX = 13;

  // Camera spring frequency (rad/s). ~11 settles in ~0.35s with no overshoot.
  private readonly CAMERA_OMEGA = 11;
  private zoomVel = 0; // zoom velocity in log-zoom units/sec

  // Accumulated time (s) driving the pulsing call-flow dots on focused edges.
  private flowPhase = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    this.bindEvents();
    window.addEventListener('resize', () => this.resize());
    this.initD3Force();
  }

  removeNodes(ids: string[]): void {
    for (const id of ids) {
      this.nodePositions.delete(id);
      this.nodeSizes.delete(id);
      this.pinnedNodes.delete(id);
    }
  }

  private async initD3Force(): Promise<void> {
    try {
      this.d3Module = await import('d3-force');
      this.startSimulation();
    } catch {
    }
  }

  private startSimulation(): void {
    if (!this.d3Module) return;

    if (this.simulationTimer) {
      clearInterval(this.simulationTimer);
    }

    const TICK_INTERVAL = 1000 / 30;

    this.simulationTimer = setInterval(() => {
      const sim = this.d3Simulation;
      if (!sim) return;
      // Stop when layout has cooled to avoid micro-jitter from forceCollide.
      if (sim.alpha() <= sim.alphaMin()) return;
      sim.tick();
      for (const d3n of this.d3Nodes) {
        if (d3n.x !== undefined && d3n.y !== undefined) {
          this.nodePositions.set(d3n.id, { x: d3n.x, y: d3n.y });
        }
      }
    }, TICK_INTERVAL);
  }

  // Position communities on a ring for visual separation.
  private communityAnchors(nodes: GraphNode[]): Map<number, { x: number; y: number }> {
    const communities = Array.from(new Set(nodes.map((n) => n.community ?? 0))).sort((a, b) => a - b);
    const anchors = new Map<number, { x: number; y: number }>();
    const n = communities.length;
    const radius = n <= 1 ? 0 : 120 + n * 45;
    communities.forEach((c, i) => {
      if (n <= 1) {
        anchors.set(c, { x: 0, y: 0 });
      } else {
        const angle = (2 * Math.PI * i) / n;
        anchors.set(c, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
      }
    });
    return anchors;
  }

  private rebuildSimulation(nodes: GraphNode[], edges: GraphEdge[], hubNodes: Set<string>): void {
    if (!this.d3Module) return;

    const d3 = this.d3Module;

    const anchors = this.communityAnchors(nodes);

    const nodeIds = new Set(nodes.map((n) => n.id));
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));
    this.d3Nodes = nodes.map((n, i) => {
      const existing = this.nodePositions.get(n.id);
      const community = n.community ?? 0;
      const anchor = anchors.get(community) ?? { x: 0, y: 0 };
      const r = 14 * Math.sqrt(i + 1);
      const a = i * GOLDEN;
      const pinned = this.pinnedNodes.has(n.id) ? this.nodePositions.get(n.id) : null;
      return {
        id: n.id,
        community,
        x: existing?.x ?? anchor.x + r * Math.cos(a),
        y: existing?.y ?? anchor.y + r * Math.sin(a),
        fx: pinned?.x ?? null,
        fy: pinned?.y ?? null,
      };
    });

    this.d3Edges = edges
      .filter((e) => {
        if (e.type === 'PHYSICAL' && (hubNodes.has(e.source) || hubNodes.has(e.target))) {
          return false;
        }
        return nodeIds.has(e.source) && nodeIds.has(e.target);
      })
      .map((e) => ({ source: e.source, target: e.target }));

    if (this.d3Simulation) {
      this.d3Simulation.stop();
    }

    this.d3Simulation = d3
      .forceSimulation(this.d3Nodes)
      .force('charge', d3.forceManyBody().strength(-320).distanceMax(500))
      .force(
        'link',
        d3
          .forceLink(this.d3Edges)
          .id((d: any) => d.id)
          .distance(70)
          .strength(0.06)
      )
      .force('x', d3.forceX((d: any) => (anchors.get(d.community)?.x ?? 0)).strength(0.08))
      .force('y', d3.forceY((d: any) => (anchors.get(d.community)?.y ?? 0)).strength(0.08))
      .force(
        'collision',
        d3.forceCollide((d: any) => (this.nodeSizes.get(d.id) ?? 6) + 12).strength(1).iterations(3)
      )
      .alphaDecay(0.02)
      .velocityDecay(0.4);
  }

  private recomputeTopology(nodes: GraphNode[], edges: GraphEdge[], hubNodes: Set<string>): void {
    const sig = `${nodes.length}:${edges.length}`;
    if (sig === this.edgesSignature && this.nodeSizes.size === nodes.length) return;
    this.edgesSignature = sig;

    const degree = new Map<string, number>();
    this.adjacency = new Map();
    for (const n of nodes) {
      degree.set(n.id, 0);
      this.adjacency.set(n.id, new Set());
      this.nodeCommunity.set(n.id, n.community ?? 0);
    }
    for (const e of edges) {
      if (!degree.has(e.source) || !degree.has(e.target)) continue;
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
      this.adjacency.get(e.source)!.add(e.target);
      this.adjacency.get(e.target)!.add(e.source);
    }

    this.nodeSizes = new Map();
    for (const n of nodes) {
      const d = degree.get(n.id) ?? 0;
      let size = 4 + 1.8 * Math.sqrt(d);
      if (hubNodes.has(n.id)) size = Math.max(size, 13);
      this.nodeSizes.set(n.id, Math.min(size, 22));
    }
  }

  private activeNodeId(): string | null {
    return this.hoveredNode?.id ?? this.selectedNodeId;
  }

  setSelectedNode(id: string | null): void {
    this.selectedNodeId = id;
  }

  setSelectedEdge(edge: GraphEdge | null): void {
    this.selectedEdge = edge;
  }

  wakeSimulation(): void {
    if (this.d3Simulation) {
      this.d3Simulation.alpha(0.3).restart();
    }
  }

  flyToNode(nodeId: string): void {
    const pos = this.nodePositions.get(nodeId);
    if (!pos) return;
    this.camera.targetX = pos.x;
    this.camera.targetY = pos.y;
    this.camera.targetZoom = Math.max(this.camera.targetZoom, 1.2);
    this.userInteracted = true;
  }

  flyToEdge(edge: GraphEdge): void {
    this.flyToNodes([edge.source, edge.target]);
  }

  flyToNodes(nodeIds: Iterable<string>): void {
    this.focusCameraOnNodes(new Set(nodeIds));
  }

  setHighlightedNodes(ids: Set<string>): void {
    this.highlightedNodes = ids;
  }

  // Move the camera to frame the given nodes, zooming in to fit them.
  private focusCameraOnNodes(ids: Set<string>): void {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let count = 0;
    for (const id of ids) {
      const p = this.nodePositions.get(id);
      if (!p) continue;
      count++;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    if (count === 0) return;

    const rect = this.canvas.getBoundingClientRect();
    const pad = 180;
    const gw = (maxX - minX) + pad * 2;
    const gh = (maxY - minY) + pad * 2;
    this.camera.targetX = (minX + maxX) / 2;
    this.camera.targetY = (minY + maxY) / 2;
    this.camera.targetZoom = Math.max(0.6, Math.min(2.2, Math.min(rect.width / gw, rect.height / gh)));
    this.userInteracted = true;
  }

  // Blend a hex color toward white by `amount` (0..1) for a brighter fill.
  private lighten(hex: string, amount: number): string {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const lr = Math.round(r + (255 - r) * amount);
    const lg = Math.round(g + (255 - g) * amount);
    const lb = Math.round(b + (255 - b) * amount);
    return `rgb(${lr}, ${lg}, ${lb})`;
  }

  private getLabelImage(text: string): { img: HTMLCanvasElement; w: number; h: number } {
    const cached = this.labelCache.get(text);
    if (cached) return cached;

    const dpr = window.devicePixelRatio || 1;
    const fontPx = CanvasRenderer.LABEL_FONT_PX;
    const font = `${fontPx}px monospace`;

    const scratch = document.createElement('canvas');
    const sctx = scratch.getContext('2d')!;
    sctx.font = font;
    const metrics = sctx.measureText(text);
    const w = Math.ceil(metrics.width) + 2;
    const h = Math.ceil(fontPx * 1.4) + 2;
    scratch.width = Math.ceil(w * dpr);
    scratch.height = Math.ceil(h * dpr);
    sctx.scale(dpr, dpr);
    sctx.font = font;
    sctx.fillStyle = '#c9d1d9';
    sctx.textBaseline = 'top';
    sctx.fillText(text, 1, 1);

    const entry = { img: scratch, w, h };
    this.labelCache.set(text, entry);
    return entry;
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
  }

  private bindEvents(): void {
    this.canvas.addEventListener('mousedown', (e) => {
      const hit = this.findNodeAt(e.clientX, e.clientY);
      if (hit) {
        const d3n = this.d3Nodes.find(n => n.id === hit.id);
        if (d3n) {
          this.draggedNode = d3n;
          this.didDrag = false;
          d3n.fx = d3n.x;
          d3n.fy = d3n.y;
          this.d3Simulation?.alpha(0.3).restart();
        }
      } else {
        this.isDragging = true;
        this.didPan = false;
        this.lastMouse = { x: e.clientX, y: e.clientY };
        this.canvas.style.cursor = 'grabbing';
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (this.draggedNode) {
        const rect = this.canvas.getBoundingClientRect();
        const wx = (e.clientX - rect.left - rect.width / 2) / this.camera.zoom + this.camera.x;
        const wy = (e.clientY - rect.top - rect.height / 2) / this.camera.zoom + this.camera.y;
        this.draggedNode.fx = wx;
        this.draggedNode.fy = wy;
        this.nodePositions.set(this.draggedNode.id, { x: wx, y: wy });
        this.didDrag = true;
      } else if (this.isDragging) {
        const dx = e.clientX - this.lastMouse.x;
        const dy = e.clientY - this.lastMouse.y;
        if (dx !== 0 || dy !== 0) {
          this.userInteracted = true;
          this.didPan = true;
        }
        this.camera.targetX -= dx / this.camera.zoom;
        this.camera.targetY -= dy / this.camera.zoom;
        this.lastMouse = { x: e.clientX, y: e.clientY };
      } else {
        this.hoveredNode = this.findNodeAt(e.clientX, e.clientY);
        this.canvas.style.cursor = this.hoveredNode ? 'pointer' : 'grab';
      }
    });

    window.addEventListener('mouseup', () => {
      if (this.draggedNode) {
        if (this.didDrag) {
          this.pinnedNodes.add(this.draggedNode.id);
          this.suppressNextClick = true;
        }
        this.draggedNode = null;
        this.didDrag = false;
      }
      if (this.isDragging && this.didPan) {
        this.suppressNextClick = true;
      }
      this.isDragging = false;
      this.canvas.style.cursor = 'grab';
    });

    this.canvas.addEventListener('dblclick', (e) => {
      const hit = this.findNodeAt(e.clientX, e.clientY);
      if (hit && this.pinnedNodes.has(hit.id)) {
        this.pinnedNodes.delete(hit.id);
        const d3n = this.d3Nodes.find(n => n.id === hit.id);
        if (d3n) {
          d3n.fx = null;
          d3n.fy = null;
        }
        this.d3Simulation?.alpha(0.3).restart();
      }
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.userInteracted = true;
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      this.camera.targetZoom = Math.max(0.1, Math.min(5, this.camera.targetZoom * factor));
    });

    this.canvas.addEventListener('click', (e) => {
      if (this.suppressNextClick) { this.suppressNextClick = false; return; }
      const node = this.findNodeAt(e.clientX, e.clientY);
      if (node) {
        this.selectedNodeId = node.id;
        if (this.onNodeClick) this.onNodeClick(node);
      } else {
        this.selectedNodeId = null;
        const edge = this.findEdgeAt(e.clientX, e.clientY);
        if (this.onEdgeClick) this.onEdgeClick(edge);
      }
    });
  }

  private findNodeAt(clientX: number, clientY: number): GraphNode | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left - rect.width / 2) / this.camera.zoom + this.camera.x;
    const y = (clientY - rect.top - rect.height / 2) / this.camera.zoom + this.camera.y;

    for (const [id, pos] of this.nodePositions.entries()) {
      const dx = x - pos.x;
      const dy = y - pos.y;
      const size = (this.nodeSizes.get(id) ?? 6) + 3;
      if (dx * dx + dy * dy < size * size) {
        return this.nodeById.get(id) ?? ({ id, label: id, file_type: 'code', source_file: '' } as GraphNode);
      }
    }
    return null;
  }

  private findEdgeAt(clientX: number, clientY: number): GraphEdge | null {
    if (this.camera.zoom < 0.10) return null;

    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left - rect.width / 2) / this.camera.zoom + this.camera.x;
    const y = (clientY - rect.top - rect.height / 2) / this.camera.zoom + this.camera.y;

    let closestEdge: GraphEdge | null = null;
    let closestDist = 12;

    for (const edge of this.currentEdges) {
      if (edge.type === 'PHYSICAL' && !this.currentOptions.showPhysical) continue;
      if (edge.type === 'COGNITIVE' && !this.currentOptions.showCognitive) continue;
      if (edge.type === 'SUSPICIOUS' && !this.currentOptions.showSuspicious) continue;

      const sourcePos = this.nodePositions.get(edge.source);
      const targetPos = this.nodePositions.get(edge.target);
      if (!sourcePos || !targetPos) continue;

      const midX = (sourcePos.x + targetPos.x) / 2;
      const midY = (sourcePos.y + targetPos.y) / 2;
      const dx = x - midX;
      const dy = y - midY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < closestDist) {
        closestDist = dist;
        closestEdge = edge;
      }
    }

    return closestEdge;
  }

  // Critically-damped spring integration (stable, frame-rate independent).
  private springStep(p: number, v: number, target: number, omega: number, h: number): { p: number; v: number } {
    const d = p - target;
    const e = Math.exp(-omega * h);
    const np = target + (d + (v + omega * d) * h) * e;
    const nv = (v - omega * (v + omega * d) * h) * e;
    return { p: np, v: nv };
  }

  private updateCamera(dtMs: number = 16.67): void {
    const h = Math.min(dtMs, 50) / 1000; // seconds; clamp long stalls
    const omega = this.CAMERA_OMEGA;

    const rx = this.springStep(this.camera.x, this.camera.vx, this.camera.targetX, omega, h);
    this.camera.x = rx.p;
    this.camera.vx = rx.v;
    const ry = this.springStep(this.camera.y, this.camera.vy, this.camera.targetY, omega, h);
    this.camera.y = ry.p;
    this.camera.vy = ry.v;

    // Zoom in log space for perceptually uniform easing (1→2 feels like 2→4).
    const logZoom = Math.log(this.camera.zoom);
    const logTarget = Math.log(this.camera.targetZoom);
    const rz = this.springStep(logZoom, this.zoomVel, logTarget, omega, h);
    this.zoomVel = rz.v;
    this.camera.zoom = Math.exp(rz.p);

    // Snap when settled to avoid endpoint jitter.
    if (Math.abs(this.camera.x - this.camera.targetX) < 0.05 && Math.abs(this.camera.vx) < 0.05) {
      this.camera.x = this.camera.targetX;
      this.camera.vx = 0;
    }
    if (Math.abs(this.camera.y - this.camera.targetY) < 0.05 && Math.abs(this.camera.vy) < 0.05) {
      this.camera.y = this.camera.targetY;
      this.camera.vy = 0;
    }
    if (Math.abs(logTarget - rz.p) < 0.002 && Math.abs(this.zoomVel) < 0.002) {
      this.camera.zoom = this.camera.targetZoom;
      this.zoomVel = 0;
    }

    if (
      !Number.isFinite(this.camera.x) || !Number.isFinite(this.camera.y) ||
      !Number.isFinite(this.camera.zoom) || !Number.isFinite(this.camera.vx) ||
      !Number.isFinite(this.camera.vy) || !Number.isFinite(this.zoomVel)
    ) {
      this.camera.x = Number.isFinite(this.camera.targetX) ? this.camera.targetX : 0;
      this.camera.y = Number.isFinite(this.camera.targetY) ? this.camera.targetY : 0;
      this.camera.zoom = Number.isFinite(this.camera.targetZoom) ? this.camera.targetZoom : 1;
      this.camera.vx = 0;
      this.camera.vy = 0;
      this.zoomVel = 0;
    }
  }

  private fitToView(w: number, h: number): void {
    if (this.nodePositions.size === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of this.nodePositions.values()) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const pad = 70;
    const gw = maxX - minX + pad * 2;
    const gh = maxY - minY + pad * 2;
    if (gw <= 0 || gh <= 0) return;
    this.camera.targetZoom = Math.max(0.1, Math.min(2, Math.min(w / gw, h / gh)));
    this.camera.targetX = (minX + maxX) / 2;
    this.camera.targetY = (minY + maxY) / 2;
  }

  private layoutNodesFallback(nodes: GraphNode[]): void {
    for (const node of nodes) {
      if (!this.nodePositions.has(node.id)) {
        const hash = this.hashString(node.id);
        this.nodePositions.set(node.id, {
          x: (hash % 800) - 400,
          y: ((hash * 7) % 800) - 400,
        });
      }
    }
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  private isVisible(x: number, y: number, size: number, width: number, height: number): boolean {
    const cx = width / 2;
    const cy = height / 2;
    const sx = (x - this.camera.x) * this.camera.zoom + cx;
    const sy = (y - this.camera.y) * this.camera.zoom + cy;
    return (
      sx + size >= 0 &&
      sx - size <= width &&
      sy + size >= 0 &&
      sy - size <= height
    );
  }

  render(nodes: GraphNode[], edges: GraphEdge[], options: RenderOptions): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const expectedWidth = Math.floor(rect.width * dpr);
    const expectedHeight = Math.floor(rect.height * dpr);

    if (this.canvas.width !== expectedWidth || this.canvas.height !== expectedHeight) {
      this.canvas.width = expectedWidth;
      this.canvas.height = expectedHeight;
      this.ctx.scale(dpr, dpr);
    }

    const w = rect.width;
    const h = rect.height;
    const hubNodes = options.hubNodes || new Set<string>();

    const renderEdges = suppressPhysicalEdgesCoveredBySuspicious(edges, options.showSuspicious);
    this.currentEdges = renderEdges;
    this.currentOptions = options;

    this.recomputeTopology(nodes, edges, hubNodes);

    const dtMs = options.dtMs ?? 16.67;
    this.updateCamera(dtMs);
    this.flowPhase += dtMs / 1000;

    const dataChanged = nodes !== this.lastNodes || edges !== this.lastEdges;
    if (nodes !== this.lastNodes) {
      this.nodeById = new Map(nodes.map((n) => [n.id, n]));
    }
    this.lastNodes = nodes;
    this.lastEdges = edges;

    const focusedIds = new Set<string>();
    for (const n of nodes) if (n.focus) focusedIds.add(n.id);
    const hasChangeFocus = focusedIds.size > 0;

    // On focus changes, fly the camera to frame the changed nodes; restore on clear.
    const focusSig = Array.from(focusedIds).sort().join(',');
    if (focusSig !== this.lastFocusSignature) {
      if (hasChangeFocus) {
        if (!this.preFocusCamera) {
          this.preFocusCamera = {
            x: this.camera.targetX,
            y: this.camera.targetY,
            zoom: this.camera.targetZoom,
          };
        }
        this.focusCameraOnNodes(focusedIds);
      } else if (this.preFocusCamera) {
        this.camera.targetX = this.preFocusCamera.x;
        this.camera.targetY = this.preFocusCamera.y;
        this.camera.targetZoom = this.preFocusCamera.zoom;
        this.preFocusCamera = null;
      }
      this.lastFocusSignature = focusSig;
    }

    // Frame-skip only when scene is idle (no camera/sim movement).
    const cameraMoving =
      this.camera.x !== this.camera.targetX ||
      this.camera.y !== this.camera.targetY ||
      this.camera.zoom !== this.camera.targetZoom;
    const simRunning =
      !!this.d3Simulation && this.d3Simulation.alpha() > this.d3Simulation.alphaMin();
    const idle =
      !dataChanged && !cameraMoving && !simRunning && !hasChangeFocus &&
      this.highlightedNodes.size === 0 && !this.draggedNode;

    if (idle) {
      const selEdgeKey = this.selectedEdge ? `${this.selectedEdge.source}->${this.selectedEdge.target}_${this.selectedEdge.relation}` : '';
      const fingerprint = `${this.hoveredNode?.id ?? ''}|${this.selectedNodeId ?? ''}|${selEdgeKey}|${options.showPhysical ? 1 : 0}${options.showCognitive ? 1 : 0}${options.showSuspicious ? 1 : 0}`;
      if (fingerprint === this.lastFrameHash) {
        this.frameSkipCount++;
        return;
      }
      this.lastFrameHash = fingerprint;
      this.frameSkipCount = 0;
    }

    if (this.d3Module) {
      const currentIds = new Set(nodes.map((n) => n.id));
      const d3Ids = new Set(this.d3Nodes.map((n) => n.id));
      let needsRebuild = !this.d3Simulation || currentIds.size !== d3Ids.size;
      if (!needsRebuild) {
        for (const id of currentIds) {
          if (!d3Ids.has(id)) {
            needsRebuild = true;
            break;
          }
        }
      }
      if (needsRebuild) {
        this.rebuildSimulation(nodes, edges, hubNodes);
      }
    } else {
      this.layoutNodesFallback(nodes);
    }

    if (!this.userInteracted) this.fitToView(w, h);

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const zoom = this.camera.zoom;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(zoom, zoom);
    ctx.translate(-this.camera.x, -this.camera.y);

    const activeId = this.activeNodeId();

    // Unified focus model: a "core" set (hover/selection, or tour focus) plus its
    // 1-degree neighbors, producing a three-tier visual gradient instead of binary.
    const coreIds = new Set<string>();
    if (activeId != null) {
      coreIds.add(activeId);
    } else if (this.selectedEdge != null) {
      coreIds.add(this.selectedEdge.source);
      coreIds.add(this.selectedEdge.target);
    } else {
      for (const id of focusedIds) coreIds.add(id);
    }
    const focusActive = coreIds.size > 0;
    const neighborIds = new Set<string>();
    if (focusActive) {
      for (const id of coreIds) {
        const adj = this.adjacency.get(id);
        if (adj) for (const nb of adj) if (!coreIds.has(nb)) neighborIds.add(nb);
      }
    }
    // 2 = core (discussed), 1 = neighbor (1-degree context), 0 = background.
    const nodeTier = (id: string): number =>
      coreIds.has(id) ? 2 : neighborIds.has(id) ? 1 : 0;
    const edgeTier = (e: GraphEdge): number => {
      const s = coreIds.has(e.source);
      const t = coreIds.has(e.target);
      if (s && t) return 2; // core relationship: both endpoints discussed
      if (s || t) return 1; // links a core node to a neighbor
      return 0;
    };

    if (zoom >= 0.10) {
      for (const edge of renderEdges) {
        if (edge.type === 'PHYSICAL' && !options.showPhysical) continue;
        if (edge.type === 'COGNITIVE' && !options.showCognitive) continue;
        if (edge.type === 'SUSPICIOUS' && !options.showSuspicious) continue;

        const sourcePos = this.nodePositions.get(edge.source);
        const targetPos = this.nodePositions.get(edge.target);
        if (!sourcePos || !targetPos) continue;

        // -1 = no focus active (show all); else 2 core / 1 neighbor / 0 background.
        const tier = focusActive ? edgeTier(edge) : -1;
        const a = tier === -1 ? 1 : tier === 2 ? 1 : tier === 1 ? 0.3 : 0.04;
        const isCore = tier === 2;

        ctx.beginPath();
        ctx.moveTo(sourcePos.x, sourcePos.y);
        ctx.lineTo(targetPos.x, targetPos.y);

        if (edge.type === 'PHYSICAL') {
          ctx.strokeStyle = `rgba(0, 243, 255, ${0.28 * a})`;
          ctx.lineWidth = isCore ? 2.6 : 1.2;
        } else if (edge.type === 'COGNITIVE') {
          ctx.strokeStyle = `rgba(189, 147, 249, ${0.5 * a})`;
          ctx.lineWidth = isCore ? 2.2 : 1;
          ctx.setLineDash([4, 4]);
        } else {
          // Radar: colour encodes severity (red = must-fix), dash encodes kind.
          const rgb = edge.score >= 0.8 ? '255, 85, 85' : '255, 184, 108';
          ctx.strokeStyle = `rgba(${rgb}, ${0.4 * a})`;
          ctx.lineWidth = isCore ? 2.8 : 1.5;
          ctx.setLineDash(edge.relation === 'violates_boundary' ? [6, 3] : [2, 2]);
        }

        if (isCore) {
          ctx.shadowColor = ctx.strokeStyle as string;
          ctx.shadowBlur = 10;
        }

        ctx.stroke();
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;

        // Pulsing call-flow: bright dots gliding source -> target on focused edges.
        if (tier >= 1) {
          const DOTS = 3;
          const SPEED = 0.35; // cycles per second
          const flowColor =
            edge.type === 'PHYSICAL' ? '#00f3ff' :
            edge.type === 'COGNITIVE' ? '#bd93f9' :
            edge.score >= 0.8 ? '#ff5555' : '#ffb86c';
          ctx.fillStyle = flowColor;
          ctx.shadowColor = flowColor;
          ctx.shadowBlur = 6;
          const dotR = (isCore ? 2.6 : 1.8) / Math.max(0.6, zoom);
          for (let k = 0; k < DOTS; k++) {
            const frac = (this.flowPhase * SPEED + k / DOTS) % 1;
            const dx = sourcePos.x + (targetPos.x - sourcePos.x) * frac;
            const dy = sourcePos.y + (targetPos.y - sourcePos.y) * frac;
            // Fade dots in/out toward the endpoints so they "emit" and "arrive".
            ctx.globalAlpha = (isCore ? 1 : 0.5) * (0.4 + 0.6 * Math.sin(frac * Math.PI));
            ctx.beginPath();
            ctx.arc(dx, dy, dotR, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
          ctx.shadowBlur = 0;
        }
      }
    }

    const communityColors = [
      '#ff79c6', '#50fa7b', '#f1fa8c', '#bd93f9',
      '#94a3ff', '#8be9fd', '#5af0b8', '#6272a4',
    ];

    for (const node of nodes) {
      const pos = this.nodePositions.get(node.id);
      if (!pos) continue;

      const size = this.nodeSizes.get(node.id) ?? 6;
      if (!this.isVisible(pos.x, pos.y, size * 2, w, h)) continue;

      const isHub = hubNodes.has(node.id);
      // Minimum visible radius when zoomed out.
      const drawSize = Math.max(size, 2 / zoom);

      const isHighlighted = this.highlightedNodes.has(node.id);
      const tier = nodeTier(node.id);
      // Three-tier gradient: core 1.0, neighbor 0.7, background 0.08 (when focus active).
      ctx.globalAlpha = isHighlighted
        ? 1
        : !focusActive
        ? 1
        : tier === 2
        ? 1
        : tier === 1
        ? 0.7
        : 0.08;

      const colorIdx = (node.community ?? 0) % communityColors.length;

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, drawSize, 0, Math.PI * 2);

      if (this.hoveredNode?.id === node.id || node.id === this.selectedNodeId) {
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = 15;
      } else if (isHighlighted) {
        ctx.fillStyle = '#f1fa8c';
        ctx.shadowColor = '#f1fa8c';
        ctx.shadowBlur = 12 + 4 * Math.sin(Date.now() / 300);
      } else if (node.focus) {
        // Changed node: brightened community color with steady glow (no ring/blink).
        const base = communityColors[colorIdx];
        ctx.fillStyle = this.lighten(base, 0.55);
        ctx.shadowColor = base;
        // Breathing glow so the discussed node reads as "alive" during narration.
        ctx.shadowBlur = 20 + 5 * Math.sin(Date.now() / 300);
      } else {
        ctx.fillStyle = communityColors[colorIdx];
        ctx.shadowColor = communityColors[colorIdx];
        ctx.shadowBlur = isHub ? 10 : 5;
      }

      ctx.fill();
      ctx.shadowBlur = 0;

      if (this.pinnedNodes.has(node.id)) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, drawSize + 4, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      const labelByFocus = focusActive && tier >= 1;
      const isProminent = isHub || size >= 9;
      const area = w * h;
      const baseArea = 1200 * 800;
      const prominentLabelZoom = 0.45 * Math.min(1, baseArea / area);
      if (labelByFocus || zoom >= 1.4 || (zoom >= prominentLabelZoom && isProminent)) {
        const label = node.label || node.id;
        const { img, w: lw, h: lh } = this.getLabelImage(label);
        const targetPx = Math.max(9, 11 / Math.max(0.5, zoom));
        const s = targetPx / CanvasRenderer.LABEL_FONT_PX;
        const dw = lw * s, dh = lh * s;
        ctx.drawImage(img, pos.x - dw / 2, pos.y + drawSize + 12, dw, dh);
      }

      ctx.globalAlpha = 1;
    }

    ctx.restore();

    ctx.fillStyle = 'rgba(13, 17, 23, 0.8)';
    ctx.fillRect(8, h - 30, 250, 22);
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px monospace';
    ctx.fillText(`Nodes: ${nodes.length} | Edges: ${edges.length} | Zoom: ${zoom.toFixed(2)}`, 14, h - 14);
  }

  destroy(): void {
    if (this.simulationTimer) {
      clearInterval(this.simulationTimer);
    }
    if (this.d3Simulation) {
      this.d3Simulation.stop();
    }
  }
}
