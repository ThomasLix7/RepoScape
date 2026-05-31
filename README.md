# RepoScape

Real-time cognitive graph of your codebase. A daemon parses your repo into a
living graph (physical import/call edges + cognitive insight edges), watches for
changes, and streams diffs to a HUD that renders the graph on a canvas.

## Install

```bash
npm install
npm run build
```

## Usage

```bash
# Start the daemon (parses + watches the current repo)
reposcape
```

The HUD opens in your browser. Edit files and watch the graph update in
real time.

## Architectural Safety Radar

The radar surfaces architectural risks as `SUSPICIOUS` edges directly on the
canvas, so you see them while you work instead of at review time.

Two kinds are detected:

- **Circular dependencies** — found automatically from the physical import/call
  graph. No configuration needed.
- **Boundary violations** — forbidden imports you declare in
  `.reposcape/architecture_rules.json`.

### Declaring boundary rules

Create `.reposcape/architecture_rules.json` in your repo root:

```json
{
  "boundaries": [
    {
      "from": "src/hud/**",
      "to": "src/server/**",
      "severity": "error",
      "reason": "Frontend views must not import server modules directly"
    }
  ]
}
```

- `from` / `to` — path globs (`**` spans directories, `*` does not). A rule fires
  when a file matching `from` imports a file matching `to`.
- `severity` — `error` (default) or `warn`.
- `reason` — optional message shown in the sidebar when the edge is selected.

Editing this file re-triggers a compile, so violations update live. The first
matching rule wins per import.

### Reading the radar

- **Colour encodes severity:** red = must-fix (`error`, or a high-risk cycle),
  orange = lower-severity warning. These two colours are reserved for the radar —
  normal nodes and edges never use them.
- **Dash pattern encodes kind:** boundary violations and circular dependencies
  use distinct dashes.
- **Click an edge** to see the violation reason in the sidebar.
- Toggle the `SUSPICIOUS` layer on/off from the sidebar legend.

### Querying violations programmatically

`SUSPICIOUS` edges are excluded from `GET /graph` to keep the visual graph clean,
but are available as a structured list for CLI/CI/agent checks:

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:5173/api/violations
```

```json
{
  "violations": [
    {
      "relation": "violates_boundary",
      "severity": "error",
      "score": 0.9,
      "reason": "Frontend views must not import server modules directly",
      "source": { "id": "...", "label": "App.tsx", "file": "src/hud/components/App.tsx" },
      "target": { "id": "...", "label": "compiler.ts", "file": "src/server/compiler.ts" }
    }
  ]
}
```

## Architecture

See `docs/` for specs. Core pieces:

- `src/server/` — daemon: parser, compiler, watcher, websocket, routes.
- `src/hud/` — browser HUD: canvas renderer, sidebar, connection.

## License

MIT
