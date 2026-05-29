import React from 'react';
import { GraphNode, GraphEdge } from '../connection.js';

interface SidebarProps {
  status: string;
  attemptsLeft: number;
  selectedNode: GraphNode | null;
  selectedEdge: GraphEdge | null;
  nodeCount: number;
  edgeCount: number;
  showPhysical: boolean;
  showCognitive: boolean;
  showSuspicious: boolean;
  onTogglePhysical: () => void;
  onToggleCognitive: () => void;
  onToggleSuspicious: () => void;
  // F2: Search
  searchQuery: string;
  searchResults: GraphNode[];
  onSearchChange: (q: string) => void;
  onSearchSelect: (nodeId: string) => void;
  // F3: Filter
  availableCommunities: number[];
  activeFileTypes: Set<string>;
  activeCommunities: Set<number> | null;
  pathPrefix: string;
  onToggleFileType: (ft: string) => void;
  onSetCommunities: (c: Set<number> | null) => void;
  onSetPathPrefix: (p: string) => void;
}

const FILE_TYPES = ['code', 'document', 'concept'];

export function Sidebar({
  status,
  attemptsLeft,
  selectedNode,
  selectedEdge,
  nodeCount,
  edgeCount,
  showPhysical,
  showCognitive,
  showSuspicious,
  onTogglePhysical,
  onToggleCognitive,
  onToggleSuspicious,
  searchQuery,
  searchResults,
  onSearchChange,
  onSearchSelect,
  availableCommunities,
  activeFileTypes,
  activeCommunities,
  pathPrefix,
  onToggleFileType,
  onSetCommunities,
  onSetPathPrefix,
}: SidebarProps) {
  const statusColors: Record<string, string> = {
    connected: '#50fa7b',
    connecting: '#f1fa8c',
    disconnected: '#ff5555',
    failed_permanently: '#ff5555',
    no_token: '#ff5555',
  };

  const statusColor = statusColors[status] || '#8b949e';

  return (
    <div
      style={{
        width: 280,
        background: '#161b22',
        borderLeft: '1px solid #30363d',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        overflowY: 'auto',
        fontFamily: 'monospace',
      }}
    >
      <div>
        <h2 style={{ color: '#f0f6fc', fontSize: 16, marginBottom: 8 }}>RepoScape</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: statusColor,
              boxShadow: `0 0 6px ${statusColor}`,
            }}
          />
          <span style={{ color: statusColor, fontSize: 12 }}>
            {status === 'disconnected' ? `Reconnecting... (${attemptsLeft} left)` : status}
          </span>
        </div>
      </div>

      {/* F2: Search input */}
      <div style={{ borderTop: '1px solid #30363d', paddingTop: 12 }}>
        <input
          type="text"
          placeholder="Search nodes…"
          value={searchQuery}
          onChange={e => onSearchChange(e.target.value)}
          style={{
            width: '100%',
            background: '#0d1117',
            border: '1px solid #30363d',
            borderRadius: 4,
            padding: '6px 8px',
            color: '#c9d1d9',
            fontSize: 12,
            fontFamily: 'monospace',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        {searchResults.length > 0 && (
          <ul style={{
            listStyle: 'none',
            margin: '4px 0 0',
            padding: 0,
            maxHeight: 160,
            overflowY: 'auto',
          }}>
            {searchResults.slice(0, 8).map(node => (
              <li
                key={node.id}
                onClick={() => onSearchSelect(node.id)}
                style={{
                  padding: '4px 6px',
                  cursor: 'pointer',
                  color: '#c9d1d9',
                  fontSize: 11,
                  borderBottom: '1px solid #21262d',
                  display: 'flex',
                  flexDirection: 'column',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#21262d')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span>{node.label}</span>
                <span style={{ color: '#8b949e', fontSize: 10 }}>{node.source_file}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ borderTop: '1px solid #30363d', paddingTop: 12 }}>
        <div style={{ color: '#8b949e', fontSize: 11, marginBottom: 8 }}>GRAPH STATS</div>
        <div style={{ color: '#c9d1d9', fontSize: 12 }}>Nodes: {nodeCount}</div>
        <div style={{ color: '#c9d1d9', fontSize: 12 }}>Edges: {edgeCount}</div>
      </div>

      <div style={{ borderTop: '1px solid #30363d', paddingTop: 12 }}>
        <div style={{ color: '#8b949e', fontSize: 11, marginBottom: 8 }}>DEPENDENCY FILTER</div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={showPhysical} onChange={onTogglePhysical} />
          <span style={{ color: '#00f3ff', fontSize: 12 }}>PHYSICAL</span>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={showCognitive} onChange={onToggleCognitive} />
          <span style={{ color: '#bd93f9', fontSize: 12 }}>COGNITIVE</span>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={showSuspicious} onChange={onToggleSuspicious} />
          <span style={{ color: '#ffb86c', fontSize: 12 }}>SUSPICIOUS</span>
        </label>
      </div>

      {/* F3: Node Filter panel */}
      <div style={{ borderTop: '1px solid #30363d', paddingTop: 12 }}>
        <div style={{ color: '#8b949e', fontSize: 11, marginBottom: 8 }}>NODE FILTER</div>

        {/* File type toggles */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          {FILE_TYPES.map(ft => (
            <label key={ft} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={activeFileTypes.has(ft)}
                onChange={() => onToggleFileType(ft)}
              />
              <span style={{ color: '#c9d1d9', fontSize: 11 }}>{ft}</span>
            </label>
          ))}
        </div>

        {/* Community selector */}
        <div style={{ marginBottom: 8 }}>
          <div style={{ color: '#8b949e', fontSize: 10, marginBottom: 4 }}>Community</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <span
              onClick={() => onSetCommunities(null)}
              style={{
                padding: '2px 6px',
                fontSize: 10,
                borderRadius: 3,
                cursor: 'pointer',
                background: activeCommunities === null ? '#30363d' : 'transparent',
                color: activeCommunities === null ? '#f0f6fc' : '#8b949e',
                border: '1px solid #30363d',
              }}
            >
              All
            </span>
            {availableCommunities.map(c => (
              <span
                key={c}
                onClick={() => {
                  if (activeCommunities === null) {
                    onSetCommunities(new Set([c]));
                  } else {
                    const next = new Set(activeCommunities);
                    if (next.has(c)) {
                      next.delete(c);
                      if (next.size === 0) { onSetCommunities(null); return; }
                    } else {
                      next.add(c);
                    }
                    onSetCommunities(next);
                  }
                }}
                style={{
                  padding: '2px 6px',
                  fontSize: 10,
                  borderRadius: 3,
                  cursor: 'pointer',
                  background: activeCommunities?.has(c) ? '#30363d' : 'transparent',
                  color: activeCommunities?.has(c) ? '#f0f6fc' : '#8b949e',
                  border: '1px solid #30363d',
                }}
              >
                {c}
              </span>
            ))}
          </div>
        </div>

        {/* Path prefix filter */}
        <div>
          <div style={{ color: '#8b949e', fontSize: 10, marginBottom: 4 }}>Path</div>
          <input
            type="text"
            placeholder="src/server/"
            value={pathPrefix}
            onChange={e => onSetPathPrefix(e.target.value)}
            style={{
              width: '100%',
              background: '#0d1117',
              border: '1px solid #30363d',
              borderRadius: 3,
              padding: '4px 6px',
              color: '#c9d1d9',
              fontSize: 11,
              fontFamily: 'monospace',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>
      </div>

      {selectedNode && (
        <div style={{ borderTop: '1px solid #30363d', paddingTop: 12 }}>
          <div style={{ color: '#8b949e', fontSize: 11, marginBottom: 8 }}>SELECTED NODE</div>
          <div style={{ color: '#f0f6fc', fontSize: 13 }}>
            {selectedNode.label || selectedNode.id}
          </div>
          <div style={{ color: '#8b949e', fontSize: 11, marginTop: 4 }}>
            {selectedNode.source_file}
          </div>
          {selectedNode.source_location && (
            <div style={{ color: '#8b949e', fontSize: 11 }}>{selectedNode.source_location}</div>
          )}
          {selectedNode.activity && (
            <div style={{ color: '#50fa7b', fontSize: 11, marginTop: 4 }}>
              {selectedNode.activity}
            </div>
          )}
        </div>
      )}

      {selectedEdge && selectedEdge.type === 'COGNITIVE' && (
        <div style={{ borderTop: '1px solid #30363d', paddingTop: 12 }}>
          <div style={{ color: '#8b949e', fontSize: 11, marginBottom: 8 }}>COGNITIVE EDGE AUDIT</div>
          <div style={{ color: '#bd93f9', fontSize: 12, marginBottom: 4 }}>
            {selectedEdge.relation}
          </div>
          <div style={{ color: '#8b949e', fontSize: 11, marginBottom: 2 }}>
            {selectedEdge.source} → {selectedEdge.target}
          </div>
          <div style={{ color: '#c9d1d9', fontSize: 11 }}>
            Score: {selectedEdge.score.toFixed(2)}
          </div>
          {selectedEdge.metadata?.rationale && (
            <div style={{ marginTop: 8 }}>
              <div style={{ color: '#8b949e', fontSize: 10, marginBottom: 2 }}>RATIONALE</div>
              <div style={{
                color: '#c9d1d9',
                fontSize: 11,
                background: '#0d1117',
                padding: 8,
                borderRadius: 4,
                border: '1px solid #30363d',
                lineHeight: 1.4,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                overflowWrap: 'break-word',
              }}>
                {selectedEdge.metadata.rationale}
              </div>
            </div>
          )}
          {selectedEdge.metadata?.source_doc && (
            <div style={{ marginTop: 6 }}>
              <div style={{ color: '#8b949e', fontSize: 10, marginBottom: 2 }}>SOURCE</div>
              <div style={{
                color: '#50fa7b',
                fontSize: 11,
                fontFamily: 'monospace',
                wordBreak: 'break-all',
                overflowWrap: 'break-word',
              }}>
                {selectedEdge.metadata.source_doc}
              </div>
            </div>
          )}
        </div>
      )}

      {selectedEdge && selectedEdge.type !== 'COGNITIVE' && (
        <div style={{ borderTop: '1px solid #30363d', paddingTop: 12 }}>
          <div style={{ color: '#8b949e', fontSize: 11, marginBottom: 8 }}>SELECTED EDGE</div>
          <div style={{ color: selectedEdge.type === 'PHYSICAL' ? '#00f3ff' : '#ffb86c', fontSize: 12, marginBottom: 4 }}>
            {selectedEdge.relation}
          </div>
          <div style={{ color: '#8b949e', fontSize: 11 }}>
            {selectedEdge.source} → {selectedEdge.target}
          </div>
          <div style={{ color: '#c9d1d9', fontSize: 11 }}>
            Score: {selectedEdge.score.toFixed(2)}
          </div>
        </div>
      )}
    </div>
  );
}
