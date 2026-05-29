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

// §6.A: d3-force types (dynamic import)
interface D3Node {
  id: string;
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

  // §6.A: d3-force simulation
  private d3Simulation: any = null;
  private d3Nodes: D3Node[] = [];
  private d3Edges: D3Edge[] = [];
  private simulationTimer: ReturnType<typeof setInterval> | null = null;
  private d3Module: any = null;

  // §5.5 Camera Spring: F = -k·Δx − c·v, then v += F, x += v
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

  // §6.A: Initialize d3-force with dedicated simulation loop
  private async initD3Force(): Promise<void> {
    try {
      this.d3Module = await import('d3-force');
      this.startSimulation();
    } catch {
      // d3-force not available — will fall back to hash positions
    }
  }

  private startSimulation(): void {
    if (!this.d3Module) return;

    // §6.A: d3-force simulation at 30Hz (33ms interval)
    if (this.simulationTimer) {
      clearInterval(this.simulationTimer);
    }

    const TICK_INTERVAL = 1000 / 30; // 30 Hz

    this.simulationTimer = setInterval(() => {
      if (this.d3Simulation) {
        this.d3Simulation.tick();
        // Copy positions from d3 nodes to our position map
        for (const d3n of this.d3Nodes) {
          if (d3n.x !== undefined && d3n.y !== undefined) {
            this.nodePositions.set(d3n.id, { x: d3n.x, y: d3n.y });
          }
        }
      }
    }, TICK_INTERVAL);
  }

  private rebuildSimulation(nodes: GraphNode[], edges: GraphEdge[], hubNodes: Set<string>): void {
    if (!this.d3Module) return;

    const d3 = this.d3Module;

    // Build d3 node/edge arrays
    const nodeIds = new Set(nodes.map((n) => n.id));
    this.d3Nodes = nodes.map((n) => {
      const existing = this.nodePositions.get(n.id);
      return {
        id: n.id,
        x: existing?.x ?? (this.hashString(n.id) % 800) - 400,
        y: existing?.y ?? ((this.hashString(n.id) * 7) % 800) - 400,
      };
    });

    this.d3Edges = edges
      .filter((e) => {
        // §5.4: Exclude hub node PHYSICAL edges from force simulation
        if (e.type === 'PHYSICAL' && (hubNodes.has(e.source) || hubNodes.has(e.target))) {
          return false;
        }
        return nodeIds.has(e.source) && nodeIds.has(e.target);
      })
      .map((e) => ({ source: e.source, target: e.target }));

    // Create or update simulation
    if (this.d3Simulation) {
      this.d3Simulation.stop();
    }

    this.d3Simulation = d3
      .forceSimulation(this.d3Nodes)
      .force('charge', d3.forceManyBody().strength(-500))
      .force(
        'link',
        d3
          .forceLink(this.d3Edges)
          .id((d: any) => d.id)
          .distance(100)
          .strength(0.01)
      )
      .force('center', d3.forceCenter(0, 0).strength(0.01))
      .force('collision', d3.forceCollide(20))
      .alphaDecay(0.02)
      .velocityDecay(0.3);

    // §6.A: Simulation pauses on alpha-decay threshold
    // d3-force handles this automatically via alphaMin
  }

  // §6.A: Wake simulation on non-empty GraphDiff
  wakeSimulation(): void {
    if (this.d3Simulation) {
      this.d3Simulation.alpha(0.3).restart();
    }
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
      this.isDragging = true;
      this.lastMouse = { x: e.clientX, y: e.clientY };
      this.canvas.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDragging) {
        const dx = e.clientX - this.lastMouse.x;
        const dy = e.clientY - this.lastMouse.y;
        this.camera.targetX -= dx / this.camera.zoom;
        this.camera.targetY -= dy / this.camera.zoom;
        this.lastMouse = { x: e.clientX, y: e.clientY };
      } else {
        this.hoveredNode = this.findNodeAt(e.clientX, e.clientY);
        this.canvas.style.cursor = this.hoveredNode ? 'pointer' : 'grab';
      }
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
      this.canvas.style.cursor = 'grab';
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      this.camera.targetZoom = Math.max(0.1, Math.min(5, this.camera.targetZoom * factor));
      // §6.A: Camera zoom/pan must NOT wake simulation
    });

    this.canvas.addEventListener('click', (e) => {
      const node = this.findNodeAt(e.clientX, e.clientY);
      if (node) {
        if (this.onNodeClick) this.onNodeClick(node);
      } else {
        // §6.D: Check for edge click — honors all edge type visibility filters
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
      const size = 8;
      if (dx * dx + dy * dy < size * size) {
        return { id, label: id, file_type: 'code', source_file: '' } as GraphNode;
      }
    }
    return null;
  }

  // §6.D: findEdgeAt iterates over ALL edge types, respecting visibility filters
  private findEdgeAt(clientX: number, clientY: number): GraphEdge | null {
    // §5.4: Edges are not rendered below zoom 0.3
    if (this.camera.zoom < 0.3) return null;

    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left - rect.width / 2) / this.camera.zoom + this.camera.x;
    const y = (clientY - rect.top - rect.height / 2) / this.camera.zoom + this.camera.y;

    let closestEdge: GraphEdge | null = null;
    let closestDist = 12; // Max click distance in world coords

    for (const edge of this.currentEdges) {
      // §6.D: Per-type gate against currentOptions.show*
      if (edge.type === 'PHYSICAL' && !this.currentOptions.showPhysical) continue;
      if (edge.type === 'COGNITIVE' && !this.currentOptions.showCognitive) continue;
      if (edge.type === 'SUSPICIOUS' && !this.currentOptions.showSuspicious) continue;

      const sourcePos = this.nodePositions.get(edge.source);
      const targetPos = this.nodePositions.get(edge.target);
      if (!sourcePos || !targetPos) continue;

      // Distance from point to edge midpoint
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

  // §5.5 Spring damping: F = -k·Δx − c·v; v += F; x += v
  // §6.B: Accept dtMs and scale forces by dtMs/16.67
  private updateCamera(dtMs: number = 16.67): void {
    const dt = dtMs / 16.67;
    const forceX = (-this.STIFFNESS * (this.camera.x - this.camera.targetX) - this.DAMPING * this.camera.vx) * dt;
    const forceY = (-this.STIFFNESS * (this.camera.y - this.camera.targetY) - this.DAMPING * this.camera.vy) * dt;
    const forceZoom = -this.STIFFNESS * (this.camera.zoom - this.camera.targetZoom) * dt;

    this.camera.vx += forceX;
    this.camera.vy += forceY;

    this.camera.x += this.camera.vx;
    this.camera.y += this.camera.vy;
    this.camera.zoom += forceZoom;
  }

  // §6.A: Fallback layout for when d3-force is not available
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

  // §5.4 Frustum Bounding Check
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
    // §6.D: Persist latest options for interaction filtering
    this.currentOptions = options;

    // §6.B: dtMs from performance.now()
    const dtMs = options.dtMs ?? 16.67;
    this.updateCamera(dtMs);

    // §6.A: Use d3-force if available, otherwise fallback to hash positions
    if (this.d3Simulation) {
      // d3 simulation runs in its own interval — just ensure node set is current
      const currentIds = new Set(nodes.map((n) => n.id));
      const d3Ids = new Set(this.d3Nodes.map((n) => n.id));
      let needsRebuild = false;
      if (currentIds.size !== d3Ids.size) {
        needsRebuild = true;
      } else {
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
      // Positions are updated by the simulation timer
    } else {
      this.layoutNodesFallback(nodes);
    }

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const zoom = this.camera.zoom;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(zoom, zoom);
    ctx.translate(-this.camera.x, -this.camera.y);

    // §5.4 LOD: Only render edges when zoom >= 0.3
    if (zoom >= 0.3) {
      for (const edge of edges) {
        if (edge.type === 'PHYSICAL' && !options.showPhysical) continue;
        if (edge.type === 'COGNITIVE' && !options.showCognitive) continue;
        if (edge.type === 'SUSPICIOUS' && !options.showSuspicious) continue;

        const sourcePos = this.nodePositions.get(edge.source);
        const targetPos = this.nodePositions.get(edge.target);
        if (!sourcePos || !targetPos) continue;

        ctx.beginPath();
        ctx.moveTo(sourcePos.x, sourcePos.y);
        ctx.lineTo(targetPos.x, targetPos.y);

        // §5.4 Edge Type Rendering
        if (edge.type === 'PHYSICAL') {
          ctx.strokeStyle = 'rgba(0, 243, 255, 0.6)';
          ctx.lineWidth = 1.5;
          ctx.shadowColor = '#00f3ff';
          ctx.shadowBlur = 4;
        } else if (edge.type === 'COGNITIVE') {
          ctx.strokeStyle = 'rgba(189, 147, 249, 0.4)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.shadowColor = '#bd93f9';
          ctx.shadowBlur = 2;
        } else {
          ctx.strokeStyle = 'rgba(255, 184, 108, 0.7)';
          ctx.lineWidth = 2;
          ctx.setLineDash([2, 2]);
          ctx.shadowColor = '#ffb86c';
          ctx.shadowBlur = 6;
        }

        ctx.stroke();
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;
      }
    }

    // §5.4 LOD: Node rendering
    for (const node of nodes) {
      const pos = this.nodePositions.get(node.id);
      if (!pos) continue;

      const size = 6;
      if (!this.isVisible(pos.x, pos.y, size * 2, w, h)) continue;

      const isHub = hubNodes.has(node.id);

      // §5.4: Hub Nodes always render at all zoom levels
      if (zoom < 0.3 && !isHub) continue;

      const communityColors = [
        '#ff79c6', '#50fa7b', '#f1fa8c', '#bd93f9',
        '#ff5555', '#8be9fd', '#ffb86c', '#6272a4',
      ];
      const colorIdx = (node.community ?? 0) % communityColors.length;

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, size, 0, Math.PI * 2);

      if (this.hoveredNode?.id === node.id) {
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = 15;
      } else if (node.focus) {
        ctx.fillStyle = '#50fa7b';
        ctx.shadowColor = '#50fa7b';
        ctx.shadowBlur = 12;
      } else {
        ctx.fillStyle = communityColors[colorIdx];
        ctx.shadowColor = communityColors[colorIdx];
        ctx.shadowBlur = 6;
      }

      ctx.fill();
      ctx.shadowBlur = 0;

      // §5.4 LOD: Labels
      // zoom < 0.3: no labels
      // 0.3 <= zoom < 0.7: labels only for hub nodes
      // zoom >= 0.7: all labels
      if (zoom >= 0.7 || (zoom >= 0.3 && isHub)) {
        ctx.fillStyle = '#c9d1d9';
        ctx.font = `${10 / Math.max(0.5, zoom)}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(node.label || node.id, pos.x, pos.y + size + 12);
      }
    }

    ctx.restore();

    // HUD status bar
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
