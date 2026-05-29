---
name: reposcape
description: "Use when extracting RepoScape cognitive graph insights, answering architecture questions with the RepoScape graph, or sending low-frequency RepoScape milestone updates."
---

# RepoScape Agent Skill

RepoScape is a local codebase graph daemon and visual HUD. The daemon owns deterministic workspace telemetry such as file watching, graph recompilation, WebSocket graph diffs, and session security. The agent should use this skill only for work that needs language-model judgment: cognitive graph extraction, topology-aware architecture analysis, and occasional high-level milestone updates.

Do not manually send high-frequency focus or activity events for every file read, cursor movement, or edit. Those signals belong in IDE extensions, harness/tool wrappers, or the RepoScape daemon itself.

## Execution Guard

Before making any optional RepoScape HTTP call:

1. Confirm `.reposcape/.session-token` exists in the project root.
2. Read the token once.
3. Call `GET http://localhost:5173/api/health` with `Authorization: Bearer <token>`.
4. If any step fails, skip RepoScape synchronization and continue normal offline work.

Never let RepoScape telemetry calls block the requested coding task.

## Responsibility Boundary

RepoScape automation should be split this way:

- File modifications: handled automatically by the daemon `FileWatcher`, which recompiles changed files and broadcasts graph diffs.
- File-open and cursor focus: should be emitted by an IDE extension or agent harness interceptor when tools such as `view_file` or `open_file` run.
- Fine-grained agent thinking streams: should be emitted by the harness shell or plugin if available.
- Agent skill behavior: extract cognitive insights, query graph topology, and optionally send low-frequency milestone updates.

Manual `/api/focus` calls are a fallback for demos or explicit user requests, not normal agent workflow.

## Optional Milestone Updates

For major task phases only, an agent may send a status event if the daemon guard succeeds.

Endpoint: `POST http://localhost:5173/api/agent-activity`

Payload:

```json
{
  "file": "src/server/compiler.ts",
  "activity": "Planning compiler cache changes and verification scope",
  "timestamp": 1716891000000,
  "ttl": 120000
}
```

Use this for low-frequency events such as starting a large refactor, beginning verification, or finishing a graph investigation. Do not send it before every command.

## Cognitive Graph Extraction

Use this when reading design docs, architecture notes, runbooks, transcripts, or other non-code sources. Extract only semantic relationships that static AST parsing cannot infer.

Rules:

- Concept node IDs must start with `concept_`.
- Do not duplicate import, contains, or call edges already produced by the compiler.
- Resolve physical node targets from `GET /api/graph` by matching `source_file`; do not guess hash-prefixed node IDs.
- Use POSIX-style relative paths in `source_file`.
- Edges should use `type: "COGNITIVE"` for conceptual relationships or `type: "SUSPICIOUS"` for architectural risks.
- Scores must be between `0.0` and `1.0`.
- Include `metadata.rationale` and `metadata.source_doc` when possible so later UI or audit tools can explain why the edge exists.

Extraction shape:

```json
{
  "nodes": [
    {
      "id": "concept_token_confinement",
      "label": "Token Access Confinement",
      "file_type": "concept",
      "source_file": "docs/auth.md"
    }
  ],
  "edges": [
    {
      "source": "concept_token_confinement",
      "target": "[resolved_security_node_id]",
      "relation": "implements",
      "type": "COGNITIVE",
      "score": 0.9,
      "metadata": {
        "rationale": "The document describes the middleware as enforcing local token confinement through timing-safe token checks.",
        "source_doc": "docs/auth.md#L12"
      }
    }
  ]
}
```

## Insight Ingestion

If the daemon is online and the user wants RepoScape cache updates, wrap extracted chunks in the batch API shape.

Endpoint: `POST http://localhost:5173/api/insights/batch`

Payload:

```json
{
  "extractions": [
    {
      "file": "docs/auth.md",
      "nodes": [
        {
          "id": "concept_token_confinement",
          "label": "Token Access Confinement",
          "file_type": "concept",
          "source_file": "docs/auth.md"
        }
      ],
      "edges": [
        {
          "source": "concept_token_confinement",
          "target": "[resolved_security_node_id]",
          "relation": "implements",
          "type": "COGNITIVE",
          "score": 0.9,
          "metadata": {
            "rationale": "The document maps token confinement to the security middleware behavior.",
            "source_doc": "docs/auth.md#L12"
          }
        }
      ]
    }
  ]
}
```

The current daemon writes these chunks to `.reposcape/cache/insights/`. Do not assume the HUD updates immediately after ingestion unless the implementation explicitly triggers a graph recompile and WebSocket broadcast.

For large doc sets, process bounded batches. If the repo or doc set is large, scope extraction to the relevant directory and ask the user before doing broad semantic sweeps.

## GraphRAG Queries

Use this when the user asks architecture questions such as:

- "Where are the cycles?"
- "What depends on this module?"
- "What changes if I refactor this interface?"
- "How does this subsystem work?"

Workflow:

1. If the daemon guard passes, load `GET /api/graph`.
2. Resolve node IDs from `source_file`, labels, and edge endpoints.
3. Traverse relevant edges in memory. Use `imports`, `contains`, and `calls` for physical dependency reasoning; use `COGNITIVE` and `SUSPICIOUS` edges for semantic or risk reasoning.
4. Report concrete paths, hubs, cycles, and affected files with clickable local file links when possible.
5. State whether the answer came from live RepoScape graph data or offline source inspection.

When the daemon is unavailable, fall back to normal repository inspection with `rg`, tests, and source reads.

## Integration Hooks

The following endpoints exist for IDE or harness integrations. They are not mandatory agent duties.

- `POST /api/focus`: file focus, cursor focus, or impacted node hints.
- `POST /api/agent-activity`: low-frequency agent phase or milestone status.
- `GET /api/graph`: current compiled graph.
- `POST /api/insights/batch`: cognitive insight cache ingestion.

Transparent automation should prefer tool wrappers and IDE plugins over LLM-authored shell commands.
