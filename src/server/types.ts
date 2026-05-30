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

export interface CognitiveEdgeMetadata {
  rationale?: string;
  source_doc?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  type: 'PHYSICAL' | 'COGNITIVE' | 'SUSPICIOUS';
  score: number;
  source_file?: string;
  source_location?: string;
  metadata?: CognitiveEdgeMetadata;
}

export interface CognitiveChunk {
  nodes: { id: string; label: string; file_type: 'code' | 'document' | 'concept'; source_file: string }[];
  edges: {
    source: string;
    target: string;
    relation: string;
    type: 'PHYSICAL' | 'COGNITIVE' | 'SUSPICIOUS';
    score: number;
    metadata?: CognitiveEdgeMetadata;
  }[];
  hyperedges?: any[];
}

export interface RawExportEntry {
  symbol: string;
  alias?: string;
  sourceFile?: string;
  isStar?: boolean;
  exportKind: 'value' | 'type';
}

export type RawImportEntry =
  | { kind: 'side-effect';  moduleSpecifier: string;                              source_location: string }
  | { kind: 'default';      moduleSpecifier: string; localName: string;           source_location: string }
  | { kind: 'named';        moduleSpecifier: string; importedName: string; localName: string; source_location: string }
  | { kind: 'namespace';    moduleSpecifier: string; localName: string;           source_location: string }
  | { kind: 'type-default'; moduleSpecifier: string; localName: string;           source_location: string }
  | { kind: 'type-named';   moduleSpecifier: string; importedName: string; localName: string; source_location: string };

export interface ExtractionResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rawCalls: { caller_nid: string; callee: string; is_member_call: boolean; source_location: string }[];
  rawExports: RawExportEntry[];
  rawImports: RawImportEntry[];
  defaultExportNodeId?: string;
  diagnostics?: string[];
}

export interface LanguageStrategy {
  parse(sourceText: string, parser: any, filePath: string): ExtractionResult;
}

export interface ResolvedExport {
  filePath: string;
  symbol: string;
}

export interface GraphDiff {
  addedNodes: GraphNode[];
  removedNodes: string[];
  updatedNodes: Partial<GraphNode>[];
  addedEdges: GraphEdge[];
  updatedEdges: GraphEdge[];
  removedEdges: string[];
  hubNodes?: string[];
}

export interface WSMessage {
  type: 'ping' | 'pong' | 'diff' | 'full_graph' | 'focus';
  diff?: GraphDiff;
  graph?: { nodes: GraphNode[]; edges: GraphEdge[]; hubNodes?: string[] };
  focus?: { file: string; activity?: string; impacted_nodes?: string[] };
}

export interface FocusEvent {
  file: string;
  activity?: string;
  timestamp: number;
  ttl: number;
  impacted_nodes?: string[];
}

export interface InsightExtraction {
  file: string;
  hash: string;
  nodes: CognitiveChunk['nodes'];
  edges: CognitiveChunk['edges'];
  hyperedges?: any[];
}

export interface BatchInsightsRequest {
  extractions: InsightExtraction[];
}

export interface CacheVersion {
  graph_version: string;
  git_head_commit: string;
}

export interface FileExtractionCache {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rawCalls: ExtractionResult['rawCalls'];
  rawExports: RawExportEntry[];
  rawImports: RawImportEntry[];
  defaultExportNodeId?: string;
}
