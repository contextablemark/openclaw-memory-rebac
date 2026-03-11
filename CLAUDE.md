# CLAUDE.md

## Project overview

OpenClaw two-layer memory plugin: SpiceDB ReBAC authorization + pluggable storage backend (currently Graphiti knowledge graph). ESM TypeScript project (`"type": "module"`).

## Key commands

```bash
npm run build         # Compile TS to dist/ (also copies JSON defaults)
npm test              # Unit tests (102 tests, no services needed)
npm run test:e2e      # E2E tests (15 tests, requires live SpiceDB + Graphiti)
npm run typecheck     # TypeScript type checking
npm run cli -- <cmd>  # CLI: status, search, groups, episodes, etc.
```

E2E tests require `OPENCLAW_LIVE_TEST=1` (set automatically by `test:e2e` script). They have 600s timeouts for local model processing. Services: SpiceDB on `localhost:50051`, Graphiti on `localhost:8000`.

## Architecture

- `index.ts` — Plugin entry point, registers tools with OpenClaw
- `config.ts` — Config parsing with env var interpolation (`${VAR}`)
- `backend.ts` — `MemoryBackend` interface for pluggable storage
- `backends/registry.ts` — Static backend registry (add new backends here)
- `authorization.ts` — SpiceDB relationship-based access control
- `search.ts` — Backend-agnostic parallel group search
- `spicedb.ts` — SpiceDB gRPC client wrapper
- `cli.ts` — CLI commands (search, status, groups, etc.)
- `schema.zed` — SpiceDB authorization schema

## Backend extensibility

New backends require: a module in `backends/`, a `.defaults.json` file, and a static import + entry in `backends/registry.ts`.

## Docker stack (`docker/`)

- `docker/graphiti/` — Custom Graphiti image with `graphiti_overlay.py` (LLM/embedder/reranker config) and `startup.py` (runtime patches for Neo4j attribute sanitization, edge extraction fixes)
- `docker/spicedb/` — PostgreSQL-backed SpiceDB
- `docker/docker-compose.yml` — Full stack startup

## Git workflow

Use PR branches for changes — don't push directly to main.

## Known patterns

- `register()` in `index.ts` should be synchronous to avoid the OpenClaw "async registration" warning; backend registry uses static imports instead of dynamic `import()`
- Groq and some OpenAI-compatible providers require the word "json" in messages when using `response_format=json_object` — handled by `JsonSafeLLMClient` wrapper in `graphiti_overlay.py`
- Edge `fact_embedding` can be clobbered by LLM-extracted attributes — diagnostic logging in `startup.py` watches for this

## Graphiti-specific notes

- **Deletion routing**: `deleteFragment` uses the type prefix from `memory_recall` IDs to choose the correct endpoint — `fact:` → `DELETE /entity-edge/{uuid}`, episode/default → `DELETE /episode/{uuid}`
- **Non-cascading deletes**: Graphiti's entity edge deletion only removes the `RELATES_TO` relationship. Source/target entity nodes remain in the graph and can become orphaned (zero edges). Episodes that referenced the deleted edge are not updated.
- **Invalidation vs deletion**: Graphiti distinguishes temporal invalidation (`expired_at`/`invalid_at` fields, preserves history) from hard deletion (removes entirely). `memory_forget` performs hard deletion.
- **Embedding provider config**: The Graphiti container's `.env` configures LLM, embedder, and reranker independently. The OpenAI client auto-appends `/embeddings` to `EMBEDDING_BASE_URL`, so set just the base (e.g. `https://api.voyageai.com/v1`, not `.../v1/embeddings`).
- **Neo4j driver wrapper**: `singleton_client.driver` is a Graphiti `Neo4jDriver` wrapper, not the raw Neo4j async driver. Custom endpoints in `startup.py` should use `singleton_client.driver.client` (the raw `neo4j.AsyncDriver`) to avoid signature mismatches across graphiti-core versions.
