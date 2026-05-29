import { GraphNode, GraphEdge } from '../connection.js';

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
  private edgesSignature = '';
  private userInteracted = false;

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

  private lastFrameHash = '';
  private frameSkipCount = 0;
  private lastNodes: GraphNode[] | null = null;
  private lastEdges: GraphEdge[] | null = null;
  private nodeById = new Map<string, GraphNode>();

  private labelCache = new Map<string, { img: HTMLCanvasElement; w: number; h: number }>();
  private static readonly LABEL_FONT_PX = 13;

  private readonly STIFFNESS = 0.08;
  private readonly DAMPING = 2 * Math.sqrt(0.08); // ≈0.566

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
      if (this.d3Simulation) {
        this.d3Simulation.tick();
        for (const d3n of this.d3Nodes) {
          if (d3n.x !== undefined && d3n.y !== undefined) {
            this.nodePositions.set(d3n.id, { x: d3n.x, y: d3n.y });
          }
        }
      }
    }, TICK_INTERVAL);
  }

  // Place each community on a ring so the colored groups physically separate
  // instead of collapsing into one overlapping blob.
  private communityAnchors(nodes: GraphNode[]): Map<number, { x: number; y: number }> {
    const communities = Array.from(new Set(nodes.map((n) => n.community ?? 0))).sort((a, b) => a - b);
    const anchors = new Map<number, { x: number; y: number }>();
    const n = communities.length;
    // Ring radius grows with community count so dense graphs don't crowd.
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

  setHighlightedNodes(ids: Set<string>): void {
    this.highlightedNodes = ids;
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
        if (dx !== 0 || dy !== 0) this.userInteracted = true;
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
    if (this.camera.zoom < 0.3) return null;

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

  private updateCamera(dtMs: number = 16.67): void {
    const dt = Math.min(dtMs, 33.34) / 16.67;
    const forceX = (-this.STIFFNESS * (this.camera.x - this.camera.targetX) - this.DAMPING * this.camera.vx) * dt;
    const forceY = (-this.STIFFNESS * (this.camera.y - this.camera.targetY) - this.DAMPING * this.camera.vy) * dt;
    const forceZoom = -this.STIFFNESS * (this.camera.zoom - this.camera.targetZoom) * dt;

    this.camera.vx += forceX;
    this.camera.vy += forceY;

    this.camera.x += this.camera.vx;
    this.camera.y += this.camera.vy;
    this.camera.zoom += forceZoom;

    if (Math.abs(this.camera.vx) < 0.01 && Math.abs(this.camera.vy) < 0.01) {
      this.camera.x = this.camera.targetX;
      this.camera.y = this.camera.targetY;
      this.camera.vx = 0;
      this.camera.vy = 0;
    }

    if (
      !Number.isFinite(this.camera.x) || !Number.isFinite(this.camera.y) ||
      !Number.isFinite(this.camera.zoom) || !Number.isFinite(this.camera.vx) ||
      !Number.isFinite(this.camera.vy)
    ) {
      this.camera.x = Number.isFinite(this.camera.targetX) ? this.camera.targetX : 0;
      this.camera.y = Number.isFinite(this.camera.targetY) ? this.camera.targetY : 0;
      this.camera.zoom = Number.isFinite(this.camera.targetZoom) ? this.camera.targetZoom : 1;
      this.camera.vx = 0;
      this.camera.vy = 0;
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
    const w = this.canvas.getBoundingClientRect().width;
    const h = this.canvas.getBoundingClientRect().height;
    const hubNodes = options.hubNodes || new Set<string>();

    this.currentEdges = edges;
    this.currentOptions = options;

    this.recomputeTopology(nodes, edges, hubNodes);

    const dtMs = options.dtMs ?? 16.67;
    this.updateCamera(dtMs);

    const dataChanged = nodes !== this.lastNodes || edges !== this.lastEdges;
    if (nodes !== this.lastNodes) {
      this.nodeById = new Map(nodes.map((n) => [n.id, n]));
    }
    this.lastNodes = nodes;
    this.lastEdges = edges;

    if (!dataChanged && this.highlightedNodes.size === 0) {
      const fingerprint = [
        this.camera.x.toFixed(1), this.camera.y.toFixed(1),
        this.camera.zoom.toFixed(3),
        nodes.length,
        this.hoveredNode?.id ?? '',
        this.selectedNodeId ?? '',
        this.d3Simulation?.alpha().toFixed(3) ?? '0',
        this.draggedNode ? `${this.draggedNode.fx?.toFixed(1)},${this.draggedNode.fy?.toFixed(1)}` : '',
      ].join('|');

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

    if (zoom >= 0.3) {
      for (const edge of edges) {
        if (edge.type === 'PHYSICAL' && !options.showPhysical) continue;
        if (edge.type === 'COGNITIVE' && !options.showCognitive) continue;
        if (edge.type === 'SUSPICIOUS' && !options.showSuspicious) continue;

        const sourcePos = this.nodePositions.get(edge.source);
        const targetPos = this.nodePositions.get(edge.target);
        if (!sourcePos || !targetPos) continue;

        const incident = activeId != null && (edge.source === activeId || edge.target === activeId);
        const a = activeId == null ? 1 : incident ? 1 : 0.08;

        ctx.beginPath();
        ctx.moveTo(sourcePos.x, sourcePos.y);
        ctx.lineTo(targetPos.x, targetPos.y);

        if (edge.type === 'PHYSICAL') {
          ctx.strokeStyle = `rgba(0, 243, 255, ${0.28 * a})`;
          ctx.lineWidth = incident ? 2 : 1.2;
        } else if (edge.type === 'COGNITIVE') {
          ctx.strokeStyle = `rgba(189, 147, 249, ${0.22 * a})`;
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
        } else {
          ctx.strokeStyle = `rgba(255, 184, 108, ${0.4 * a})`;
          ctx.lineWidth = incident ? 2.2 : 1.5;
          ctx.setLineDash([2, 2]);
        }

        if (incident) {
          ctx.shadowColor = ctx.strokeStyle as string;
          ctx.shadowBlur = 6;
        }

        ctx.stroke();
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;
      }
    }

    const focusNeighbors = activeId != null ? this.adjacency.get(activeId) : null;

    const communityColors = [
      '#ff79c6', '#50fa7b', '#f1fa8c', '#bd93f9',
      '#ff5555', '#8be9fd', '#ffb86c', '#6272a4',
    ];

    for (const node of nodes) {
      const pos = this.nodePositions.get(node.id);
      if (!pos) continue;

      const size = this.nodeSizes.get(node.id) ?? 6;
      if (!this.isVisible(pos.x, pos.y, size * 2, w, h)) continue;

      const isHub = hubNodes.has(node.id);
      if (zoom < 0.3 && !isHub) continue;

      const isHighlighted = this.highlightedNodes.has(node.id);
      const inFocus =
        activeId == null || node.id === activeId || (focusNeighbors?.has(node.id) ?? false);
      ctx.globalAlpha = isHighlighted ? 1 : (inFocus ? 1 : 0.15);

      const colorIdx = (node.community ?? 0) % communityColors.length;

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, size, 0, Math.PI * 2);

      if (this.hoveredNode?.id === node.id || node.id === this.selectedNodeId) {
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = 15;
      } else if (node.focus) {
        ctx.fillStyle = '#50fa7b';
        ctx.shadowColor = '#50fa7b';
        ctx.shadowBlur = 12;
      } else if (isHighlighted) {
        ctx.fillStyle = '#f1fa8c';
        ctx.shadowColor = '#f1fa8c';
        ctx.shadowBlur = 12 + 4 * Math.sin(Date.now() / 300);
      } else {
        ctx.fillStyle = communityColors[colorIdx];
        ctx.shadowColor = communityColors[colorIdx];
        ctx.shadowBlur = isHub ? 10 : 5;
      }

      ctx.fill();
      ctx.shadowBlur = 0;

      if (this.pinnedNodes.has(node.id)) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, size + 4, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      const labelByFocus = activeId != null && inFocus;
      const isProminent = isHub || size >= 9;
      if (labelByFocus || zoom >= 1.4 || (zoom >= 0.45 && isProminent)) {
        const label = node.label || node.id;
        const { img, w: lw, h: lh } = this.getLabelImage(label);
        const targetPx = Math.max(9, 11 / Math.max(0.5, zoom));
        const s = targetPx / CanvasRenderer.LABEL_FONT_PX;
        const dw = lw * s, dh = lh * s;
        ctx.drawImage(img, pos.x - dw / 2, pos.y + size + 12, dw, dh);
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
