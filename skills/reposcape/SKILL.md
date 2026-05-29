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

Use this when reading design docs, architecture notes, runbooks, transcripts, or other non-code sources. The compiler already has every `import`, `contains`, and `call` edge. Your only job is the layer AST cannot reach: **why** the code is shaped the way it is, which concepts a module implements, and where the docs reveal architectural risk. Do not re-emit structural edges.

Follow these steps in order. Do not skip steps.

### Step 1 — Guard and load the live graph

Run the Execution Guard above. If it passes, `GET http://localhost:5173/api/graph` (with the bearer token) and keep the result — you need its physical nodes to resolve edge targets in Step 4. If the guard fails, stop: there is nothing to ingest into.

### Step 2 — Decide scope

If the doc set is large or spans the whole repo, name the directories you intend to sweep and ask the user before a broad pass. Default to the directory relevant to the current task. Never sweep the entire repo unprompted.

### Step 3 — Dispatch extraction

- **Small set (≤ ~5 docs):** read and extract them yourself.
- **Larger set:** you **MUST** use the Agent tool. Split docs into chunks of ~15–20 (group same-directory files together), and dispatch one `subagent_type="general-purpose"` agent per chunk **in a single message** so they run in parallel. Reading dozens of files yourself one-by-one is the wrong approach. Give each subagent the verbatim prompt in Step 5 plus the physical-node list from Step 1.

### Step 4 — Resolve targets (the server does NOT do this for you)

Ingestion is a blind merge: an edge whose `target` is not the **exact** id of an existing graph node becomes a silently invisible dangling edge. Two hard rules:

- For every edge pointing at code, copy the **exact `id`** of the physical node from the Step-1 graph whose `source_file` matches. Never invent or guess a hash-prefixed id.
- Every node you emit must carry a `source_file` that exists on disk (POSIX relative path). **If any node's `source_file` is wrong, the daemon discards the ENTIRE chunk** — one bad path silently drops all of its siblings.

### Step 5 — Extraction prompt (verbatim for subagents; the same rules bind you in single-agent mode)

```
You are a RepoScape cognitive-extraction subagent. Read the assigned docs and emit
ONLY semantic relationships that AST parsing cannot infer. Output ONLY valid JSON
(no prose, no markdown fences) matching the schema at the end.

Assigned files (chunk N of M): FILE_LIST
Physical nodes (resolve every code target against this list): GRAPH_NODES_JSON

Extract, in priority order:
1. RATIONALE — the highest-value signal, and the main reason an LLM is in this loop.
   Wherever a doc explains WHY a decision was made, a trade-off taken, or design
   intent, create a `concept_` node and a `rationale_for` edge to the physical node
   it explains. Do not skip rationale.
2. COGNITIVE — a doc concept that implements / constrains / motivates / contradicts
   a code module. Edge type:"COGNITIVE".
3. SUSPICIOUS — architectural risk the docs expose (a stated invariant the code may
   violate, a deprecated path still referenced, a boundary the design forbids).
   Edge type:"SUSPICIOUS".

Do NOT emit import/contains/call edges — the compiler already has those.

Relation vocabulary (pick one): implements | constrains | motivates | contradicts |
references | rationale_for. Use `concept_`-prefixed, [a-z0-9_]-only ids for concepts.

Provenance + confidence (REQUIRED on every edge — never default to 0.5):
- EXTRACTED  (doc states it explicitly):  score 1.0
- INFERRED   (reasonable reading):         score 0.6–0.9
- AMBIGUOUS  (uncertain — flag, don't drop): score 0.1–0.3
Record the label in metadata.provenance.

Target + source rules (the server does not resolve or repair these):
- Every edge `target` aimed at code MUST be the exact `id` of a node in
  GRAPH_NODES_JSON whose source_file matches. A wrong target = invisible edge.
- Every node MUST have a real `source_file` (POSIX relative path). If any is wrong,
  the WHOLE chunk is discarded.
- Always include metadata.rationale (one sentence: why this edge exists) and
  metadata.source_doc ("path#Ln") for the audit trail.

Output exactly this shape:
{"file":"docs/auth.md",
 "nodes":[{"id":"concept_token_confinement","label":"Token Access Confinement",
   "file_type":"concept","source_file":"docs/auth.md"}],
 "edges":[{"source":"concept_token_confinement","target":"<exact id from GRAPH_NODES_JSON>",
   "relation":"implements","type":"COGNITIVE","score":0.9,
   "metadata":{"provenance":"INFERRED","rationale":"The doc maps token confinement to the security middleware.","source_doc":"docs/auth.md#L12"}}]}
```

### Step 6 — Ingest

Collect every subagent's per-file object into one `extractions` array and POST it once (see Insight Ingestion). If a subagent returned invalid JSON or is missing, drop that chunk and note it — do not abort the whole batch.

## Insight Ingestion

Wrap the collected extractions in the batch shape and `POST http://localhost:5173/api/insights/batch` (with the bearer token):

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
          "target": "[exact physical node id from GET /api/graph]",
          "relation": "implements",
          "type": "COGNITIVE",
          "score": 0.9,
          "metadata": {
            "provenance": "INFERRED",
            "rationale": "The document maps token confinement to the security middleware behavior.",
            "source_doc": "docs/auth.md#L12"
          }
        }
      ]
    }
  ]
}
```

The daemon writes each chunk to `.reposcape/insights/<hash>.json` (keyed by `source_file`), then recompiles and broadcasts a graph diff over WebSocket. Read the response and act on it per entry:

- `refresh: "queued"` — at least one chunk was accepted; the HUD will update after the recompile finishes (not instantly).
- `refresh: "cache_only"` — nothing was broadcast (e.g. every chunk failed); investigate before retrying.
- Per-entry `status`: `ok` succeeded; `invalid_schema` means the chunk failed validation — fix the shape, do not resend unchanged; `lock_failed` is transient — retry that entry.

A re-POST for the same `file` overwrites its prior insight chunk, so re-running extraction on a doc is safe and idempotent.

## GraphRAG Queries

Use this when the user asks architecture questions such as:

- "Where are the cycles?"
- "What depends on this module?"
- "What changes if I refactor this interface?"
- "How does this subsystem work?"
- "Why is this built this way?" (answerable only if cognitive `rationale_for` edges exist)

Workflow:

1. If the daemon guard passes, load `GET /api/graph`. Otherwise fall back to `rg`, tests, and source reads, and say so.
2. Resolve the nodes in question from `source_file`, labels, and edge endpoints.
3. Traverse edges in memory: use `imports`, `contains`, and `calls` for physical dependency and blast-radius reasoning; use `COGNITIVE` / `SUSPICIOUS` / `rationale_for` edges for intent and risk reasoning.
4. Weight by provenance — lead with `EXTRACTED` facts, present `INFERRED` edges as inferences, and surface `AMBIGUOUS` edges only as open questions. Quote `metadata.rationale` when explaining *why*.
5. Report concrete paths, hubs, cycles, and affected files with clickable local file links.
6. State whether the answer came from live RepoScape graph data or offline source inspection.

## Integration Hooks

The following endpoints exist for IDE or harness integrations. They are not mandatory agent duties.

- `POST /api/focus`: file focus, cursor focus, or impacted node hints.
- `POST /api/agent-activity`: low-frequency agent phase or milestone status.
- `GET /api/graph`: current compiled graph.
- `POST /api/insights/batch`: cognitive insight cache ingestion.

Transparent automation should prefer tool wrappers and IDE plugins over LLM-authored shell commands.
