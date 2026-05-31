---
name: reposcape
description: "Use when extracting RepoScape cognitive graph insights, answering architecture questions with the RepoScape graph, or sending low-frequency RepoScape milestone updates."
---

# RepoScape Agent Skill

RepoScape is a local codebase graph daemon and visual HUD. The daemon owns deterministic workspace telemetry such as file watching, graph recompilation, WebSocket graph diffs, and session security. The agent should use this skill only for work that needs language-model judgment: cognitive graph extraction, topology-aware architecture analysis, narrated tours that speak and highlight the answer in the HUD (the default for architecture questions when the daemon is live), and occasional high-level milestone updates.

Do not manually send high-frequency focus or activity events for every file read, cursor movement, or edit. Those signals belong in IDE extensions, harness/tool wrappers, or the RepoScape daemon itself.

## Execution Guard

Before making any optional RepoScape HTTP call, run this three-state diagnosis. `/api/health` is auth-gated, so you always read the token first; the **distinction between a refused connection and a 401 is what tells you whether to launch** — never relaunch a daemon that is already running.

1. Read `.reposcape/.session-token` from the project root (it may be absent or stale).
2. Call `GET http://localhost:5173/api/health` with `Authorization: Bearer <token>` and branch on the result:
   - **`200 OK`** → the daemon is already running. Proceed; do **not** launch anything.
   - **`401`** → a daemon is running but your token is stale (the token rotates on every launch). Re-read the token file and retry once. If it still 401s, stop with an auth error — do **not** launch a second instance.
   - **Connection refused / unreachable** (this returns immediately — it is *not* a timeout, so do not wait it out) → the daemon is genuinely offline. Handle per request type below.

When the daemon is offline:

- **Passive questions (e.g., general architecture explanations)**: gracefully skip RepoScape synchronization, note it briefly at the end of your response, and continue with normal offline work using standard file-reading and grep tools.
- **Active `/reposcape` sweeps or explicit HUD analysis**: do NOT abort. Bootstrap the daemon following **Daemon Bootstrap** below, then resume.

Never let RepoScape telemetry calls block the requested coding task.

### Daemon Bootstrap

Bring the daemon up, then resume. Every step is non-interactive on purpose — a bare interactive launch can hang on the project-size prompt and never write a token.

1. **Pick the launch command** (first that applies):
   - `reposcape` — if it resolves on `PATH` (the daemon is installed globally; the normal case).
   - `npm install -g reposcape` then `reposcape` — only if `reposcape` is missing. Propose this install to the user and run it only on approval. *(Until the package is published to npm this will fail; if so, fall through.)*
   - Otherwise stop with: *"The RepoScape daemon is not installed and could not be auto-installed. Install it with `npm i -g reposcape` (during local development of RepoScape itself: run `npm link` inside the repo), then re-run."*
2. **Propose and launch** in the background, non-interactively. Tell the user: *"The RepoScape daemon is offline. With your approval I'll start it in the background so we can proceed."* Then run the chosen command with:
   - `--scope <dir>` — the directory relevant to this task. This skips the interactive size prompt on large repos; pass `--force` instead only if the user explicitly wants the whole repo compiled.
   - `--no-open` — so the sweep does not pop open the user's browser.
   - Launch it as a background / detached task so the terminal does not lock up.
3. **Poll, don't sleep.** After launching, poll `GET /api/health` (re-reading the token file each time — it is rewritten on startup) about once a second, up to ~60s. Resume the moment it returns `200 OK`: that response means the initial graph is already compiled and queryable. Also watch the launched process — if it exits early (port in use, missing build, etc.), stop immediately and surface its output instead of waiting out the timeout.
4. **Give up cleanly** only if the user rejects the launch, the command can't be found or installed, the process exits with an error, or the poll times out. Report the daemon's output in that case.

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

Run the Execution Guard above. Because this is an active sweep, an offline daemon means **Daemon Bootstrap**, not abort — start it and wait for health before continuing. Once health passes, `GET http://localhost:5173/api/graph` (with the bearer token) and keep the result — you need its physical nodes to resolve edge targets in Step 4. Stop only if the bootstrap itself fails (user declines, not installed, or it never comes up).

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

### Narrated Tour (default when the daemon is live)

After composing the textual answer you SHOULD drive a synchronized narration: the HUD speaks
each line aloud while highlighting the node(s) it is about and moving the camera to them. The
textual answer still prints in chat as normal — the tour is an additive layer, not a replacement.

This is the **default** for architecture answers, not an optional extra. Whenever the Execution
Guard passed and you already hold the Step-1 `GET /api/graph` result, emit a tour. Skip it only
when one of these holds — and a skip needs one of these reasons:

- the answer touches a single node, so a tour adds nothing;
- the user has said they don't want voice / narration.

Offline is not a separate case here — the Execution Guard already governs it: an explicit
`/reposcape` bootstraps the daemon first (so by this step health has passed and the tour runs),
and a passive offline answer already notes the skip per the Guard. Either way you never drop the
tour silently.

Build an ordered list of **beats**. Each beat is one short spoken sentence plus the **exact**
node ids it covers:

- Resolve every id from the live graph — copy the precise `id`, never invent or guess one. As
  with insight ingestion, a wrong id is silently skipped (the HUD ignores ids it can't find);
  unlike ingestion it does not drop siblings, but the beat will simply highlight nothing.
- Keep each `say` to ~one sentence so the highlight cadence feels natural.
- **Short per beat, never shallow overall.** One-sentence brevity governs each
  `say`, not the tour's depth. The beat list must walk through **every core
  module or intent your textual answer names** — if the prose covers security,
  the AST strategy, the heartbeat, and contains-edge clustering, each gets its
  own beat with the camera on it. A skeleton that collapses a broad architecture
  answer into a handful of high-level beats is a failure, not a concise success.
  Let the textual answer's coverage set the beat count, never a target length.
- To make a *relationship* light up, put **both** endpoint ids in the same beat — the HUD
  auto-highlights the edge between two focused nodes.
- Set `lang` on every beat to the BCP 47 tag of the language you wrote that `say` text in —
  you authored the text, so you know it: `"zh-CN"` for Chinese, `"en-US"` for English,
  `"ja-JP"`, `"fr-FR"`, etc. Match the conversation language. Omitting falls back to the HUD's
  default voice, which mispronounces text in any other language, so only omit if you genuinely
  cannot tell.

Then `POST http://localhost:5173/api/tour` (with the bearer token):

```json
{
  "beats": [
    { "say": "入口在 daemon.ts，它启动了 watcher 和 websocket。", "lang": "zh-CN",
      "nodes": ["<exact id from GET /api/graph>", "<exact websocket id>"] },
    { "say": "路由层把图查询和聚合都收口在 routes.ts。", "lang": "zh-CN",
      "nodes": ["<exact routes id>"] }
  ]
}
```

A `200 { ok: true }` means the tour was broadcast; the HUD shows a one-click
`▶ Play Tour (N)` button — N is the beat count — (browsers require a user gesture before
speaking) and then plays the beats in order, toggling to `⏹ Stop Tour` while it runs.

## Node IDs & Context-Efficient Queries

Node ids are **deterministic** — you can compute them from a file path without fetching the
graph. Prefer this over loading the whole graph just to copy an id.

**ID rule:**
- File node = the repo-relative path with `/` → `_`, dots kept, lowercased.
  `src/server/compiler.ts` → `src_server_compiler.ts` (dots stay so `app/config.ts` and
  `app.config.ts` don't collide).
- Symbol node = `<file id>:<qualified name>`, where the qualified name is the enclosing
  class/namespace chain plus the symbol, joined by `.`, lowercased, non-alphanumeric → `_`.
  - top-level `compile` in `src/server/compiler.ts` → `src_server_compiler.ts:compile`
  - method `GraphCompiler.compile` → `src_server_compiler.ts:graphcompiler.compile`
- Collisions (true overloads / same name + same scope) get a deterministic `~2`, `~3` suffix
  by appearance order. When unsure, **resolve** instead of guessing.

**Query the graph in slices, not whole.** `GET /api/graph` is the last resort. Default to:

- `GET /api/graph/overview` — whole-repo map: one line per community with its hub node and top
  members. A few hundred tokens. Use to orient before drilling in. `?format=json` for structured.
- `GET /api/graph/neighborhood?node=<id>&depth=2&format=compact&budget=1500` — the local subgraph
  around a node (BFS to `depth`, ranked by closeness, trimmed to a `budget` of ~N tokens).
  Compact text by default (`NODE …` / `EDGE …` lines); `format=json` for objects. This is
  typically ~10% of the full-graph token cost. Query the **file** id for a file-level slice.
- `GET /api/graph/resolve?file=<relative path>&symbol=<name>` — the safety net for the id rule.
  Returns the real node id(s) for a file + symbol (symbol matched by its last segment, so
  `GraphCompiler.compile` and `compile` both work). Returns the file node id when `symbol` is
  omitted. Use whenever your computed id 404s or a symbol might be overloaded.

When emitting insight or tour edges, compute or `resolve` the target id this way instead of
loading `GET /api/graph` to copy it.

## Integration Hooks

The following endpoints exist for IDE or harness integrations. They are not mandatory agent duties.

- `POST /api/focus`: file focus, cursor focus, or impacted node hints.
- `POST /api/agent-activity`: low-frequency agent phase or milestone status.
- `GET /api/graph`: current compiled graph (whole graph — prefer the sliced queries above).
- `GET /api/graph/overview`: community-level map of the whole graph.
- `GET /api/graph/neighborhood`: token-budgeted local subgraph around a node.
- `GET /api/graph/resolve`: file + symbol → deterministic node id(s).
- `POST /api/insights/batch`: cognitive insight cache ingestion.

Transparent automation should prefer tool wrappers and IDE plugins over LLM-authored shell commands.
