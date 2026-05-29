export interface GraphNode {
  id: string;
  label: string;
  file_type: 'code' | 'document' | 'concept';
  source_file: string;
  source_location?: string;
  metadata?: Record<string, any>;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  size?: number;
  community?: number;
  activity?: string;
  focus?: boolean;
  focusTtl?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  type: 'PHYSICAL' | 'COGNITIVE' | 'SUSPICIOUS';
  score: number;
  source_file?: string;
  source_location?: string;
  metadata?: Record<string, any>;
}

export interface GraphDiff {
  addedNodes: GraphNode[];
  removedNodes: string[];
  updatedNodes: Partial<GraphNode>[];
  addedEdges: GraphEdge[];
  removedEdges: string[];
  hubNodes?: string[];
}

export interface WSMessage {
  type: 'ping' | 'pong' | 'diff' | 'full_graph' | 'focus';
  diff?: GraphDiff;
  graph?: { nodes: GraphNode[]; edges: GraphEdge[]; hubNodes?: string[] };
  focus?: { file: string; activity?: string; impacted_nodes?: string[] };
}

export interface HUDConnection {
  close: () => void;
}

export function connectHUD(
  token: string,
  onDiff: (diff: GraphDiff) => void,
  onFullGraph: (graph: { nodes: GraphNode[]; edges: GraphEdge[]; hubNodes?: string[] }) => void,
  onStatusChange: (status: string, attemptsLeft?: number) => void,
  onFocus?: (event: { file: string; activity?: string; impacted_nodes?: string[] }) => void
): HUDConnection {
  let ws: WebSocket | null = null;
  let reconnectDelay = 1000;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 50;
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let pongWatchdog: ReturnType<typeof setTimeout> | null = null;
  let isClosed = false;

  // Strip token from URL
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('token')) {
      url.searchParams.delete('token');
      window.history.replaceState({}, '', url.pathname + url.hash);
    }
  } catch {}

  function connect() {
    if (isClosed) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      onStatusChange('failed_permanently', 0);
      console.error('WebSocket reconnect failed permanently after 50 attempts. Please restart Daemon.');
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${token}`);

    ws.onopen = () => {
      if (isClosed) {
        ws?.close();
        return;
      }
      reconnectDelay = 1000;
      reconnectAttempts = 0;
      onStatusChange('connected');

      // Keepalive ping interval
      pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
          // Watchdog: close connection if no pong in 5s
          if (pongWatchdog) clearTimeout(pongWatchdog);
          pongWatchdog = setTimeout(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.close();
            }
          }, 5000);
        }
      }, 30000);
    };

    ws.onmessage = (event) => {
      if (isClosed) return;
      const msg: WSMessage = JSON.parse(event.data);
      if (msg.type === 'pong') {
        // Clear watchdog on pong
        if (pongWatchdog) {
          clearTimeout(pongWatchdog);
          pongWatchdog = null;
        }
        return;
      }
      if (msg.type === 'diff' && msg.diff) {
        onDiff(msg.diff);
      }
      if (msg.type === 'full_graph' && msg.graph) {
        onFullGraph(msg.graph);
      }
      // Handle focus events
      if (msg.type === 'focus' && msg.focus && onFocus) {
        onFocus(msg.focus);
      }
    };

    ws.onclose = () => {
      if (pingInterval) clearInterval(pingInterval);
      if (pongWatchdog) { clearTimeout(pongWatchdog); pongWatchdog = null; }
      if (isClosed) return;

      reconnectAttempts++;
      onStatusChange('disconnected', MAX_RECONNECT_ATTEMPTS - reconnectAttempts);

      setTimeout(() => {
        if (!isClosed) {
          reconnectDelay = Math.min(reconnectDelay * 2, 16000);
          connect();
        }
      }, reconnectDelay);
    };
  }

  connect();

  return {
    close: () => {
      isClosed = true;
      if (pingInterval) clearInterval(pingInterval);
      if (pongWatchdog) { clearTimeout(pongWatchdog); pongWatchdog = null; }
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.close();
      }
    },
  };
}
