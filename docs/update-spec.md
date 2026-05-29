# RepoScape v3 Update Specification - Transparent Automation and Cognitive Agent Boundary

This specification replaces agent-driven high-frequency heartbeat behavior with a transparent integration model. RepoScape should feel live because the daemon, IDE, and harness integrations observe the workspace automatically. The agent skill should remain small and focused on non-deterministic cognitive work.

## 1. Product Boundary

RepoScape has two separate layers:

- Deterministic telemetry layer: file watching, graph recompilation, WebSocket graph diffs, cursor/focus events, and harness log forwarding.
- Agent cognition layer: document concept extraction, cognitive risk tagging, GraphRAG traversal, and low-frequency milestone summaries.

High-frequency events must not depend on an LLM deciding to run shell commands.

## 2. Transparent Automation

### File Modification Tracking

The daemon already owns this path.

- `FileWatcher` watches project files.
- On add/change/delete, it recompiles affected graph state.
- It broadcasts `GraphDiff` frames to connected HUD clients.
- Agents should not manually notify RepoScape after every edit.

### File Open and Cursor Focus

Focus should be emitted by integration code, not by `SKILL.md` instructions.

Preferred emitters:

- IDE extensions for Cursor, VS Code, Windsurf, or similar editors.
- Agent harness wrappers around file tools such as `view_file`, `open_file`, `read_file`, and edit tools.
- MCP or local plugin middleware that observes tool calls before they reach the agent runtime.

The integration should call `POST /api/focus` with the current relative file path and optional impacted node IDs. Agents may call this endpoint manually only for demos, explicit user requests, or low-frequency milestone context.

### Agent Thought and Phase Streams

Fine-grained thought streams should be forwarded by the harness shell or plugin if available. The skill should not require an agent to emit a curl command for every phase transition.

Allowed manual use:

- Start of a large refactor.
- Start of verification.
- Completion of a graph investigation.
- Explicit user request to publish a status event.

## 3. Skill Content Direction

`SKILL.md` must stay concise and agent-focused.

Keep:

- Daemon availability guard.
- Cognitive graph extraction rules.
- Batch ingestion schema.
- GraphRAG query workflow.
- Low-frequency milestone update guidance.
- Integration endpoint reference for plugin authors.

Remove or avoid:

- Mandatory focus events for every file read or edit.
- Background shell curls.
- Token-level or command-level thought streaming.
- Claims that current HUD features exist before the client implements them.
- Fake node IDs that look authoritative.

## 4. Cognitive Insight Contract

Agent-produced cognitive chunks should use this edge shape:

```typescript
interface CognitiveEdge {
  source: string;
  target: string;
  relation: string;
  type: 'COGNITIVE' | 'SUSPICIOUS';
  score: number;
  metadata?: {
    rationale?: string;
    source_doc?: string;
  };
}
```

Implementation requirements:

- Preserve `metadata` when loading and broadcasting cognitive edges.
- Validate `metadata` shape when present.
- Keep accepting chunks without metadata for backward compatibility.
- Resolve physical target node IDs from the compiled graph rather than guessed file stems.

## 5. Batch Insight Refresh

`POST /api/insights/batch` currently writes cache files. The product contract should be explicit:

- Short term: document it as cache ingestion only; users should not assume immediate HUD refresh.
- Preferred implementation: after a successful batch write, enqueue `compiler.compile()` and broadcast either a full graph or a computed diff to HUD clients.
- The route response should state whether refresh was triggered, for example `{ results, refresh: "queued" }` or `{ results, refresh: "cache_only" }`.

This removes ambiguity between cache writes and live graph updates.

## 6. Focus Event Contract

`FocusEvent` is an integration contract, not an agent obligation.

Suggested shape:

```typescript
interface FocusEvent {
  file: string;
  activity?: string;
  timestamp: number;
  ttl: number;
  impacted_nodes?: string[];
}
```

Implementation requirements:

- Validate required fields and TTL bounds.
- Preserve optional `impacted_nodes`.
- Expose active focus state through `GET /api/focus`.
- Later HUD work may poll or subscribe to focus state and render camera moves or impact ripples.

## 7. HUD Roadmap

The HUD should only advertise what it implements.

Current safe claims:

- Graph rendering.
- WebSocket graph updates.
- Connection status.
- Node selection.
- Edge type filtering.

Future work:

- Focus polling or WebSocket focus frames.
- Camera glide to focused file node.
- Impact ripple rendering from `impacted_nodes`.
- Edge selection and metadata audit panel.
- Harness-streamed agent phase console.

## 8. Verification Expectations

For this update line, verification should include:

- `npm test`
- `npm run build:server`
- `npm run build:hud`
- Focus route tests for optional payload preservation.
- Batch ingestion tests that prove whether refresh is cache-only or queued.
- HUD tests or manual browser checks only after visual behavior is implemented.
