import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { Server } from 'http';
import crypto from 'crypto';
import { GraphDiff, WSMessage, Tour } from './types.js';
import { getSessionToken } from './security.js';

export class HUDWebSocketServer {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private getCurrentGraph: () => { nodes: any[]; edges: any[]; hubNodes?: string[] };

  constructor(server: Server, getCurrentGraph?: () => { nodes: any[]; edges: any[]; hubNodes?: string[] }) {
    this.getCurrentGraph = getCurrentGraph || (() => ({ nodes: [], edges: [] }));
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const token = url.searchParams.get('token') || '';

      const tokenBuf = Buffer.from(token, 'utf-8');
      const expectedBuf = Buffer.from(getSessionToken(), 'utf-8');

      if (
        !token ||
        tokenBuf.length !== expectedBuf.length ||
        !crypto.timingSafeEqual(tokenBuf, expectedBuf)
      ) {
        ws.close(4001, 'Unauthorized');
        return;
      }

      this.clients.add(ws);

      ws.send(JSON.stringify({ type: 'full_graph', graph: this.getCurrentGraph() }));

      ws.on('message', (data) => {
        try {
          const msg: WSMessage = JSON.parse(data.toString());
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        } catch {
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });
    });
  }

  broadcastDiff(diff: GraphDiff): void {
    const msg: WSMessage = { type: 'diff', diff };
    const payload = JSON.stringify(msg);

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  broadcastFocus(event: { file: string; activity?: string; impacted_nodes?: string[] }): void {
    const msg: WSMessage = { type: 'focus', focus: event };
    const payload = JSON.stringify(msg);

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  broadcastTour(tour: Tour): void {
    const msg: WSMessage = { type: 'tour', tour };
    const payload = JSON.stringify(msg);

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  broadcastFullGraph(graph: { nodes: any[]; edges: any[]; hubNodes?: string[] }): void {
    const msg: WSMessage = { type: 'full_graph', graph };
    const payload = JSON.stringify(msg);

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  close(): void {
    for (const client of this.clients) {
      client.close();
    }
    this.wss.close();
  }
}
