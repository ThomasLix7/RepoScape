import React, { useState, useMemo, useEffect } from 'react';
import { GraphNode, GraphEdge, CommunitySummary, NeighborsContext } from '../connection.js';
import { AccordionSection } from './AccordionSection.js';

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
  searchQuery: string;
  searchResults: GraphNode[];
  onSearchChange: (q: string) => void;
  onSearchSelect: (nodeId: string) => void;
  activeFileTypes: Set<string>;
  activeCommunities: Set<number> | null;
  pathPrefix: string;
  onToggleFileType: (ft: string) => void;
  onSetCommunities: (c: Set<number> | null) => void;
  onSetPathPrefix: (p: string) => void;
  communitiesSummary: CommunitySummary[];
  selectedNodeNeighbors: NeighborsContext;
  hubNodes: Set<string>;
  baseFilteredNodes: GraphNode[];
}

const FILE_TYPES = ['code', 'document', 'concept'];

const FILE_TYPE_ICONS: Record<string, string> = {
  code: '\u{1F4BB}',
  document: '\u{1F4C4}',
  concept: '\u{1F4A1}',
};

const communityColors = [
  '#ff79c6', '#50fa7b', '#f1fa8c', '#bd93f9',
  '#ff5555', '#8be9fd', '#ffb86c', '#6272a4',
];

function getCommunityColor(id: number): string {
  return communityColors[id % communityColors.length];
}

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
  activeFileTypes,
  activeCommunities,
  pathPrefix,
  onToggleFileType,
  onSetCommunities,
  onSetPathPrefix,
  communitiesSummary,
  selectedNodeNeighbors,
  hubNodes,
  baseFilteredNodes,
}: SidebarProps) {
  const [expandedPanels, setExpandedPanels] = useState<Set<number>>(new Set([3, 4]));
  const [expandedCommunities, setExpandedCommunities] = useState<Set<number>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [foldersInitialized, setFoldersInitialized] = useState(false);
  const [searchHovered, setSearchHovered] = useState(false);
  const [incomingExpanded, setIncomingExpanded] = useState(true);
  const [outgoingExpanded, setOutgoingExpanded] = useState(true);

  const hasSelection = selectedNode !== null || selectedEdge !== null;

  // Auto-expand Detail Inspect panel on selection; allow manual collapse.
  useEffect(() => {
    if (hasSelection) {
      setExpandedPanels(prev => {
        if (prev.has(5)) return prev;
        const next = new Set(prev);
        next.add(5);
        return next;
      });
    }
  }, [hasSelection]);

  const togglePanel = (panel: number) => {
    setExpandedPanels(prev => {
      const next = new Set(prev);
      if (next.has(panel)) next.delete(panel);
      else next.add(panel);
      return next;
    });
  };

  const toggleCommunityExpand = (id: number) => {
    setExpandedCommunities(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleFolderExpand = (folder: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  };

  const toggleCommunityFilter = (id: number) => {
    if (activeCommunities === null) {
      onSetCommunities(new Set([id]));
    } else {
      const next = new Set(activeCommunities);
      if (next.has(id)) {
        next.delete(id);
        if (next.size === 0) { onSetCommunities(null); return; }
      } else {
        next.add(id);
      }
      onSetCommunities(next);
    }
  };

  const statusColors: Record<string, string> = {
    connected: '#50fa7b',
    connecting: '#f1fa8c',
    disconnected: '#ff5555',
    failed_permanently: '#ff5555',
    no_token: '#ff5555',
  };
  const statusColor = statusColors[status] || '#8b949e';


  const groupedCommunities = useMemo(() => {
    const groupsMap = new Map<string, CommunitySummary[]>();
    for (const summary of communitiesSummary) {
      const folder = summary.dominantFolder || '(root)';
      if (!groupsMap.has(folder)) {
        groupsMap.set(folder, []);
      }
      groupsMap.get(folder)!.push(summary);
    }
    return Array.from(groupsMap.entries())
      .map(([folder, summaries]) => ({
        folder,
        summaries: summaries.sort((a, b) => b.size - a.size),
        totalSize: summaries.reduce((acc, s) => acc + s.size, 0),
      }))
      .sort((a, b) => b.totalSize - a.totalSize);
  }, [communitiesSummary]);

  // Auto-expand only the largest folder group on first load.
  useEffect(() => {
    if (!foldersInitialized && groupedCommunities.length > 0) {
      setExpandedFolders(new Set([groupedCommunities[0].folder]));
      setFoldersInitialized(true);
    }
  }, [foldersInitialized, groupedCommunities]);

  // File lists derive from the faceted base so counts stay consistent with filters.
  const communityFileLists = useMemo(() => {
    const map = new Map<number, GraphNode[]>();
    for (const summary of communitiesSummary) {
      const members = baseFilteredNodes.filter(n => (n.community ?? 0) === summary.id);
      map.set(summary.id, members);
    }
    return map;
  }, [baseFilteredNodes, communitiesSummary]);

  const edgeColor = (type: string) => {
    if (type === 'PHYSICAL') return '#00f3ff';
    if (type === 'COGNITIVE') return '#bd93f9';
    return '#ffb86c';
  };

  return (
    <div
      style={{
        width: 300,
        background: '#0d1117',
        borderLeft: '1px solid #30363d',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        fontFamily: 'monospace',
      }}
    >
      <div style={{
        padding: '12px 12px 8px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid #30363d',
        background: '#0d1117',
      }}>
        <h2 style={{ color: '#f0f6fc', fontSize: 15, margin: 0, fontWeight: 700, letterSpacing: '0.5px' }}>RepoScape</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: statusColor,
              boxShadow: `0 0 5px ${statusColor}`,
            }}
          />
          <span style={{ color: statusColor, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.3px' }}>
            {status === 'disconnected' ? `RECONNECTING (${attemptsLeft})` : status}
          </span>
        </div>
      </div>

      <div style={{ padding: '12px', borderBottom: '1px solid #30363d' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div style={{
            background: '#0d1117',
            borderRadius: 4,
            padding: '8px 10px',
            border: '1px solid #21262d',
            transition: 'border-color 150ms',
          }}
          onMouseEnter={e => (e.currentTarget.style.borderColor = '#30363d')}
          onMouseLeave={e => (e.currentTarget.style.borderColor = '#21262d')}
          >
            <div style={{ color: '#8b949e', fontSize: 9, fontWeight: 600, letterSpacing: '0.5px', marginBottom: 2 }}>NODES</div>
            <div style={{ color: '#00f3ff', fontSize: 16, fontWeight: 700 }}>{nodeCount}</div>
          </div>
          <div style={{
            background: '#0d1117',
            borderRadius: 4,
            padding: '8px 10px',
            border: '1px solid #21262d',
            transition: 'border-color 150ms',
          }}
          onMouseEnter={e => (e.currentTarget.style.borderColor = '#30363d')}
          onMouseLeave={e => (e.currentTarget.style.borderColor = '#21262d')}
          >
            <div style={{ color: '#8b949e', fontSize: 9, fontWeight: 600, letterSpacing: '0.5px', marginBottom: 2 }}>EDGES</div>
            <div style={{ color: '#bd93f9', fontSize: 16, fontWeight: 700 }}>{edgeCount}</div>
          </div>
        </div>
      </div>

      <div style={{ padding: '12px', borderBottom: '1px solid #30363d' }}>
        <div style={{ position: 'relative' }}>
          <span style={{
            position: 'absolute',
            left: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            color: '#8b949e',
            fontSize: 12,
            lineHeight: 1,
            pointerEvents: 'none',
          }}>
            {'\u{1F50D}'}
          </span>
          <input
            type="text"
            placeholder="Search nodes..."
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            onMouseEnter={() => setSearchHovered(true)}
            onMouseLeave={() => setSearchHovered(false)}
            style={{
              width: '100%',
              background: '#0d1117',
              border: `1px solid ${searchHovered || searchQuery ? '#58a6ff' : '#30363d'}`,
              borderRadius: 4,
              padding: '6px 28px 6px 26px', // Extra left padding for the search icon
              color: '#c9d1d9',
              fontSize: 12,
              fontFamily: 'monospace',
              outline: 'none',
              boxSizing: 'border-box',
              transition: 'border-color 150ms, box-shadow 150ms',
              boxShadow: searchHovered || searchQuery ? '0 0 6px rgba(88,166,255,0.15)' : 'none',
            }}
          />
          {searchQuery && (
            <span
              onClick={() => onSearchChange('')}
              style={{
                position: 'absolute',
                right: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                cursor: 'pointer',
                color: '#8b949e',
                fontSize: 11,
                lineHeight: 1,
              }}
              title="Clear search"
            >
              {'\u2716'}
            </span>
          )}
        </div>
        {searchResults.length > 0 && (
          <ul style={{
            listStyle: 'none',
            margin: '6px 0 0',
            padding: 0,
            maxHeight: 200,
            overflowY: 'auto',
            background: '#0d1117',
            border: '1px solid #30363d',
            borderRadius: 4,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}>
            {searchResults.slice(0, 8).map(node => (
              <li
                key={node.id}
                onClick={() => onSearchSelect(node.id)}
                style={{
                  padding: '6px 8px',
                  cursor: 'pointer',
                  fontSize: 11,
                  borderBottom: '1px solid #21262d',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#21262d')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span style={{ color: '#f0f6fc', fontWeight: 600 }}>{node.label}</span>
                <span style={{ color: '#8b949e', fontSize: 9 }}>{node.source_file}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <AccordionSection
        title="View & Filter"
        icon={'\u2699\uFE0F'}
        isExpanded={expandedPanels.has(3)}
        onToggle={() => togglePanel(3)}
      >
        <div style={{ marginBottom: 10 }}>
          <div style={{ color: '#8b949e', fontSize: 10, marginBottom: 6 }}>DEPENDENCIES</div>
          {[
            { label: 'PHYSICAL', checked: showPhysical, toggle: onTogglePhysical, color: '#00f3ff' },
            { label: 'COGNITIVE', checked: showCognitive, toggle: onToggleCognitive, color: '#bd93f9' },
            { label: 'SUSPICIOUS', checked: showSuspicious, toggle: onToggleSuspicious, color: '#ffb86c' },
          ].map(({ label, checked, toggle, color }) => (
            <label
              key={label}
              style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, cursor: 'pointer' }}
            >
              <div
                onClick={toggle}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  border: `1.5px solid ${checked ? color : '#30363d'}`,
                  background: checked ? color : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  transition: 'all 150ms',
                  flexShrink: 0,
                }}
              >
                {checked && <span style={{ color: '#0d1117', fontSize: 10, fontWeight: 700 }}>{'\u2713'}</span>}
              </div>
              <span style={{ color, fontSize: 12 }}>{label}</span>
            </label>
          ))}
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ color: '#8b949e', fontSize: 10, marginBottom: 6 }}>NODE TYPES</div>
          {FILE_TYPES.map(ft => (
            <label
              key={ft}
              style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, cursor: 'pointer' }}
            >
              <div
                onClick={() => onToggleFileType(ft)}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  border: `1.5px solid ${activeFileTypes.has(ft) ? '#58a6ff' : '#30363d'}`,
                  background: activeFileTypes.has(ft) ? '#58a6ff' : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  transition: 'all 150ms',
                  flexShrink: 0,
                }}
              >
                {activeFileTypes.has(ft) && <span style={{ color: '#0d1117', fontSize: 10, fontWeight: 700 }}>{'\u2713'}</span>}
              </div>
              <span style={{ color: '#c9d1d9', fontSize: 11 }}>{ft}</span>
            </label>
          ))}
        </div>

        <div>
          <div style={{ color: '#8b949e', fontSize: 10, marginBottom: 4 }}>PATH PREFIX</div>
          <input
            type="text"
            placeholder="e.g. src/server/"
            value={pathPrefix}
            onChange={e => onSetPathPrefix(e.target.value)}
            style={{
              width: '100%',
              background: '#0d1117',
              border: '1px solid #30363d',
              borderRadius: 4,
              padding: '5px 8px',
              color: '#c9d1d9',
              fontSize: 11,
              fontFamily: 'monospace',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>
      </AccordionSection>

      <AccordionSection
        title="Code Communities"
        icon={'\u{1F465}'}
        isExpanded={expandedPanels.has(4)}
        onToggle={() => togglePanel(4)}
        headerRight={
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              onClick={(e) => {
                e.stopPropagation();
                onSetCommunities(null);
              }}
              style={{
                padding: '2px 8px',
                fontSize: 10,
                borderRadius: 3,
                cursor: 'pointer',
                background: activeCommunities === null ? '#30363d' : 'transparent',
                color: activeCommunities === null ? '#f0f6fc' : '#8b949e',
                border: '1px solid #30363d',
                transition: 'all 150ms',
                lineHeight: '12px',
              }}
            >
              All
            </span>
            <span
              style={{
                background: '#30363d',
                color: '#8b949e',
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 10,
                lineHeight: '16px',
              }}
            >
              {communitiesSummary.length}
            </span>
          </div>
        }
      >
        {groupedCommunities.map(group => {
          const isFolderExpanded = expandedFolders.has(group.folder);

          return (
            <div key={group.folder} style={{ marginBottom: 4 }}>
              <div
                onClick={() => toggleFolderExpand(group.folder)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 8px',
                  color: '#8b949e',
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '0.2px',
                  cursor: 'pointer',
                  background: '#161b2235',
                  borderRadius: 4,
                  marginBottom: 2,
                  marginTop: 2,
                  userSelect: 'none',
                  transition: 'background 150ms, color 150ms',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = '#21262d45';
                  e.currentTarget.style.color = '#f0f6fc';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = '#161b2235';
                  e.currentTarget.style.color = '#8b949e';
                }}
              >
                <span style={{
                  display: 'inline-block',
                  fontSize: 8,
                  transition: 'transform 0.2s ease-in-out',
                  transform: isFolderExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  width: 10,
                  textAlign: 'center',
                  flexShrink: 0,
                }}>
                  ▶
                </span>
                <span>📁</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {group.folder}
                </span>
                <span style={{
                  background: '#21262d',
                  color: '#8b949e',
                  fontSize: 9,
                  padding: '1px 5px',
                  borderRadius: 8,
                  fontWeight: 500,
                  flexShrink: 0,
                }}>
                  {group.summaries.length}
                </span>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateRows: isFolderExpanded ? '1fr' : '0fr',
                  transition: 'grid-template-rows 200ms cubic-bezier(0.4, 0, 0.2, 1)',
                  overflow: 'hidden',
                }}
              >
                <div style={{ minHeight: 0, minWidth: 0, paddingLeft: 8 }}>
                  {group.summaries.map(summary => {
                    const isExpanded = expandedCommunities.has(summary.id);
                    const isActive = activeCommunities === null || activeCommunities.has(summary.id);
                    const fileList = communityFileLists.get(summary.id) || [];

                    return (
                      <div key={summary.id} style={{ marginBottom: 2 }}>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 6,
                            padding: '3px 8px',
                            borderRadius: 4,
                            cursor: 'pointer',
                            background: isExpanded ? '#21262d' : 'transparent',
                            transition: 'background 150ms',
                          }}
                          onMouseEnter={e => { if (!isExpanded) e.currentTarget.style.background = '#21262d'; }}
                          onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = 'transparent'; }}
                        >
                          <span
                            onClick={(e) => { e.stopPropagation(); toggleCommunityExpand(summary.id); }}
                            style={{
                              display: 'inline-block',
                              fontSize: 9,
                              color: '#8b949e',
                              transition: 'transform 0.2s ease-in-out',
                              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                              width: 10,
                              textAlign: 'center',
                              flexShrink: 0,
                              marginTop: 3,
                            }}
                          >
                            ▶
                          </span>
                          
                          <div
                            onClick={() => toggleCommunityExpand(summary.id)}
                            style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, overflow: 'hidden' }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 6 }}>
                              <span
                                style={{
                                  width: 8,
                                  height: 8,
                                  borderRadius: '50%',
                                  background: getCommunityColor(summary.id),
                                  boxShadow: `0 0 4px ${getCommunityColor(summary.id)}`,
                                  flexShrink: 0,
                                }}
                              />
                              <span
                                style={{
                                  color: '#f0f6fc',
                                  fontSize: 11,
                                  fontWeight: 600,
                                  flex: 1,
                                  minWidth: 0,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap'
                                }}
                                title={`Core Hub: ${summary.hubNodeName} (Community #${summary.id})`}
                              >
                                {summary.hubNodeName}
                              </span>

                              <div
                                onClick={(e) => { e.stopPropagation(); toggleCommunityFilter(summary.id); }}
                                style={{
                                  width: 14,
                                  height: 14,
                                  borderRadius: 3,
                                  border: `1.5px solid ${isActive ? '#50fa7b' : '#30363d'}`,
                                  background: isActive ? '#50fa7b' : 'transparent',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  cursor: 'pointer',
                                  transition: 'all 150ms',
                                  flexShrink: 0,
                                }}
                                title={isActive ? 'Active in filter (Click to toggle)' : 'Hidden (Click to toggle)'}
                              >
                                {isActive && (
                                  <span style={{ color: '#0d1117', fontSize: 9, fontWeight: 'bold', lineHeight: 1 }}>✓</span>
                                )}
                              </div>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, paddingLeft: 14 }}>
                              <span style={{ color: '#8b949e', fontSize: 10, flexShrink: 0 }}>
                                {summary.size} nodes
                              </span>
                              <span
                                style={{
                                  color: '#8b949e',
                                  fontSize: 9,
                                  background: '#21262d',
                                  padding: '0px 4px',
                                  borderRadius: 3,
                                  fontFamily: 'monospace',
                                  flexShrink: 0,
                                }}
                              >
                                #{summary.id}
                              </span>
                              <span
                                style={{
                                  background: '#0d1117',
                                  color: '#8be9fd',
                                  fontSize: 9,
                                  padding: '1px 5px',
                                  borderRadius: 8,
                                  flexShrink: 0,
                                }}
                              >
                                {summary.percentage}%
                              </span>
                            </div>
                          </div>
                        </div>

                        <div
                          style={{
                            display: 'grid',
                            gridTemplateRows: isExpanded ? '1fr' : '0fr',
                            transition: 'grid-template-rows 180ms cubic-bezier(0.4, 0, 0.2, 1)',
                            overflow: 'hidden',
                          }}
                        >
                          <div style={{ minHeight: 0, minWidth: 0, paddingLeft: 24, marginTop: 2, marginBottom: 4 }}>
                            {fileList.map(file => {
                              const isSelected = selectedNode?.id === file.id;
                              return (
                                <div
                                  key={file.id}
                                  onClick={() => onSearchSelect(file.id)}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    padding: '3px 6px',
                                    borderRadius: 3,
                                    cursor: 'pointer',
                                    fontSize: 10,
                                    background: isSelected ? '#00f3ff15' : 'transparent',
                                    borderLeft: isSelected ? '2px solid #00f3ff' : '2px solid transparent',
                                    transition: 'background 120ms',
                                  }}
                                  onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = '#21262d'; }}
                                  onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                                >
                                  <span style={{ fontSize: 10 }}>{FILE_TYPE_ICONS[file.file_type] || '\u{1F4C4}'}</span>
                                  <span style={{ color: isSelected ? '#00f3ff' : '#c9d1d9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {file.label}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </AccordionSection>

      <AccordionSection
        title="Detail Inspect"
        icon={'\u{1F4C4}'}
        isExpanded={expandedPanels.has(5)}
        onToggle={() => togglePanel(5)}
      >
        {!selectedNode && !selectedEdge && (
          <div style={{ color: '#8b949e', fontSize: 11, textAlign: 'center', padding: '8px 0' }}>
            Select a node or edge to inspect
          </div>
        )}

        {selectedNode && (
          <div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <button
                onClick={() => onSearchSelect(selectedNode.id)}
                style={{
                  flex: 1,
                  background: '#0d1117',
                  border: '1px solid #00f3ff',
                  borderRadius: 4,
                  padding: '5px 8px',
                  color: '#00f3ff',
                  fontSize: 10,
                  cursor: 'pointer',
                  fontFamily: 'monospace',
                }}
              >
                {'\u{1F3AF}'} Fly & Focus
              </button>
              <button
                onClick={() => onSearchSelect('')}
                style={{
                  flex: 1,
                  background: '#0d1117',
                  border: '1px solid #30363d',
                  borderRadius: 4,
                  padding: '5px 8px',
                  color: '#8b949e',
                  fontSize: 10,
                  cursor: 'pointer',
                  fontFamily: 'monospace',
                }}
              >
                {'\u2716'} Clear Selection
              </button>
            </div>

            <div style={{ background: '#0d1117', borderRadius: 4, padding: 8, marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6, marginBottom: 4 }}>
                <div style={{ color: '#f0f6fc', fontSize: 13, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selectedNode.label || selectedNode.id}
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>
                  <span style={{
                    background: '#21262d',
                    color: '#c9d1d9',
                    fontSize: 9,
                    padding: '1px 5px',
                    borderRadius: 3,
                  }}>
                    {selectedNode.file_type}
                  </span>
                  {hubNodes.has(selectedNode.id) && (
                    <span style={{
                      background: '#00f3ff20',
                      color: '#00f3ff',
                      fontSize: 9,
                      padding: '1px 5px',
                      borderRadius: 3,
                    }}>
                      HUB
                    </span>
                  )}
                </div>
              </div>
              <div style={{ color: '#8b949e', fontSize: 10, marginBottom: 2 }}>
                {selectedNode.source_file}
              </div>
              {selectedNode.source_location && (
                <div style={{ color: '#8b949e', fontSize: 10 }}>{selectedNode.source_location}</div>
              )}
            </div>

            {selectedNodeNeighbors.incoming.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div
                  onClick={() => setIncomingExpanded(v => !v)}
                  style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#8b949e', fontSize: 10, marginBottom: 4, cursor: 'pointer', userSelect: 'none' }}
                >
                  <span style={{
                    display: 'inline-block',
                    fontSize: 8,
                    transition: 'transform 0.2s ease-in-out',
                    transform: incomingExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  }}>▶</span>
                  {'📥'} INCOMING ({selectedNodeNeighbors.incoming.length})
                </div>
                <div style={{
                  display: 'grid',
                  gridTemplateRows: incomingExpanded ? '1fr' : '0fr',
                  transition: 'grid-template-rows 200ms cubic-bezier(0.4, 0, 0.2, 1)',
                  overflow: 'hidden',
                }}>
                  <div style={{ minHeight: 0, maxHeight: 120, overflowY: 'auto' }}>
                    {selectedNodeNeighbors.incoming.map(n => (
                      <div
                        key={n.id}
                        onClick={() => onSearchSelect(n.id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '4px 6px',
                          borderRadius: 3,
                          cursor: 'pointer',
                          fontSize: 10,
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#21262d')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        <span style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: getCommunityColor(n.community ?? 0),
                          flexShrink: 0,
                        }} />
                        <span style={{ color: '#c9d1d9' }}>{n.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {selectedNodeNeighbors.outgoing.length > 0 && (
              <div>
                <div
                  onClick={() => setOutgoingExpanded(v => !v)}
                  style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#8b949e', fontSize: 10, marginBottom: 4, cursor: 'pointer', userSelect: 'none' }}
                >
                  <span style={{
                    display: 'inline-block',
                    fontSize: 8,
                    transition: 'transform 0.2s ease-in-out',
                    transform: outgoingExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  }}>▶</span>
                  {'📤'} OUTGOING ({selectedNodeNeighbors.outgoing.length})
                </div>
                <div style={{
                  display: 'grid',
                  gridTemplateRows: outgoingExpanded ? '1fr' : '0fr',
                  transition: 'grid-template-rows 200ms cubic-bezier(0.4, 0, 0.2, 1)',
                  overflow: 'hidden',
                }}>
                  <div style={{ minHeight: 0, maxHeight: 120, overflowY: 'auto' }}>
                    {selectedNodeNeighbors.outgoing.map(n => (
                      <div
                        key={n.id}
                        onClick={() => onSearchSelect(n.id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '4px 6px',
                          borderRadius: 3,
                          cursor: 'pointer',
                          fontSize: 10,
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#21262d')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        <span style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: getCommunityColor(n.community ?? 0),
                          flexShrink: 0,
                        }} />
                        <span style={{ color: '#c9d1d9' }}>{n.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {selectedEdge && (
          <div>
            <div style={{
              color: edgeColor(selectedEdge.type),
              fontSize: 12,
              fontWeight: 600,
              marginBottom: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}>
              <span>{'\u2192'}</span>
              {selectedEdge.relation}
            </div>
            <div style={{ color: '#8b949e', fontSize: 10, marginBottom: 4 }}>
              {selectedEdge.source} {'\u2192'} {selectedEdge.target}
            </div>
            <div style={{ color: '#c9d1d9', fontSize: 11, marginBottom: 8 }}>
              Score: {selectedEdge.score.toFixed(2)}
            </div>

            {selectedEdge.type === 'COGNITIVE' && selectedEdge.metadata?.rationale && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ color: '#8b949e', fontSize: 10, marginBottom: 4 }}>RATIONALE</div>
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
                }}>
                  {selectedEdge.metadata.rationale}
                </div>
              </div>
            )}

            {selectedEdge.type === 'COGNITIVE' && selectedEdge.metadata?.source_doc && (
              <div>
                <div style={{ color: '#8b949e', fontSize: 10, marginBottom: 4 }}>SOURCE</div>
                <div style={{
                  color: '#50fa7b',
                  fontSize: 11,
                  fontFamily: 'monospace',
                  wordBreak: 'break-all',
                }}>
                  {selectedEdge.metadata.source_doc}
                </div>
              </div>
            )}
          </div>
        )}
      </AccordionSection>
    </div>
  );
}
