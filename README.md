# RepoScape

Real-time codebase visualization with incremental compilation, call-graph resolution, and cognitive insight overlays.

## Quick Start

```bash
npm install
npm run build
npx reposcape
```

The HUD opens at `http://127.0.0.1:5173/hud.html?token=<session-token>`.

## API Authentication

All API endpoints (including `/api/health`) require a Bearer token in the `Authorization` header:

```
Authorization: Bearer <session-token>
```

The session token is written to `.reposcape/.session-token` on daemon start. External health monitors must include this header — unauthenticated requests receive `401 Unauthorized`.

## CLI Flags

| Flag | Description |
|------|-------------|
| `--force` | Skip project size guard |
| `--scope <dir>` | Limit scan to a subdirectory |
| `--bootstrap` | Install agent skill rules for detected IDE platforms |

## Development

```bash
npm run dev          # Start daemon + Vite dev server (uses concurrently)
npm run build        # Build HUD (Vite) + server (tsc)
npm test             # Run test suite (vitest)
```
