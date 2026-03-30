# CLAUDE.md

## Project overview

OpenClaw composite memory plugin: SpiceDB ReBAC authorization with a primary knowledge graph (Graphiti) and an optional liminal conversational memory (EverMemOS). Two operating modes: **unified** (Graphiti handles tools + hooks) or **hybrid** (Graphiti for tools, EverMemOS for hooks, with a promotion bridge). ESM TypeScript project (`"type": "module"`).

## Key commands

```bash
npm run build         # Compile TS to dist/ (also copies JSON defaults)
npm test              # Unit tests (~186 tests, no services needed)
npm run test:e2e      # Graphiti E2E tests (14 tests, requires SpiceDB + Graphiti)
npm run test:e2e:backend  # Backend-agnostic E2E (13 tests, uses E2E_BACKEND env var)
npm run test:e2e:evermemos # EverMemOS-specific E2E (requires SpiceDB + EverMemOS)
npm run typecheck     # TypeScript type checking
npm run cli -- <cmd>  # CLI: status, search, groups, episodes, etc.
```

E2E tests require `OPENCLAW_LIVE_TEST=1` (set automatically by test scripts). They have 600s timeouts for local model processing.

## Architecture

### Composite plugin model

```
Unified mode (default, liminal omitted or same as backend):
  Graphiti handles everything — tools + hooks → SpiceDB auth on all fragments.

Hybrid mode (liminal: "evermemos"):
  ├── Tools → Graphiti (primary, ReBAC authorized)
  │   ├── memory_recall, memory_store, memory_forget
  │   ├── memory_share / unshare
  │   └── memory_promote (reads EverMemOS, writes Graphiti)
  ├── Hooks → EverMemOS only (liminal)
  │   ├── before_agent_start → EverMemOS auto-recall (recent context)
  │   └── agent_end → EverMemOS auto-capture (no SpiceDB writes)
  └── SpiceDB (Graphiti fragments only)
```

### Source files

- `index.ts` — Plugin entry point, registers tools (memory_recall, memory_store, memory_forget, memory_status, memory_share, memory_unshare, memory_promote)
- `config.ts` — Config parsing with env var interpolation (`${VAR}`), liminal backend config
- `backend.ts` — `MemoryBackend` interface for pluggable storage
- `backends/registry.ts` — Static backend registry (graphiti, evermemos)
- `backends/graphiti.ts` — Graphiti REST backend (primary)
- `backends/evermemos.ts` — EverMemOS REST backend (liminal)
- `authorization.ts` — SpiceDB relationship-based access control (includes share/unshare)
- `search.ts` — Backend-agnostic parallel group search
- `spicedb.ts` — SpiceDB gRPC client wrapper
- `cli.ts` — CLI commands (search, status, groups, etc.)
- `schema.zed` — SpiceDB authorization schema (person, agent, group with owner, memory_fragment with share)

## Backend extensibility

New backends require: a module in `backends/`, a `.defaults.json` file, and a static import + entry in `backends/registry.ts`.

## Docker stack (`docker/`)

Two top-level compose files share the same SpiceDB sub-stack:

- `docker/docker-compose.graphiti.yml` — Graphiti + SpiceDB
- `docker/docker-compose.evermemos.yml` — EverMemOS + SpiceDB
- `docker/graphiti/` — Custom Graphiti image with `graphiti_overlay.py` (LLM/embedder/reranker config) and `startup.py` (runtime patches)
- `docker/evermemos/` — All-in-one container: MongoDB, Elasticsearch, Milvus, Redis, and EverMemOS API server managed by supervisord. Built from source (pinned to commit `3c9a2d0`). Requires LLM/vectorize/rerank API keys in `.env`. Needs ~4 GB RAM.
- `docker/spicedb/` — PostgreSQL-backed SpiceDB (shared by both backends)

```bash
# Graphiti stack (unified mode)
cd docker && docker compose -f docker-compose.graphiti.yml up -d

# Both stacks (hybrid mode)
cd docker && docker compose -f docker-compose.graphiti.yml up -d
cd docker && docker compose -f docker-compose.evermemos.yml up -d
```

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

## EverMemOS-specific notes (liminal backend)

In hybrid mode, EverMemOS serves as the liminal backend — auto-recall and auto-capture only, no SpiceDB fragment authorization.

- **No upstream Docker image**: EverMemOS does not publish a Docker image. We build from source in `docker/evermemos/Dockerfile`, pinned to commit SHA `3c9a2d0`. Milvus binaries are extracted from the official `milvusdb/milvus` Docker image via multi-stage build.
- **Search response structure**: The search API returns memories nested under group-id keys: `result.memories: [{"group-id": [mem1, mem2]}]` with parallel `result.scores: [{"group-id": [0.95, 0.8]}]`. Content varies by type: `episode` for episodic_memory, `foresight` for foresight, `summary` for profile/event_log.
- **Search user_id**: Do not send `user_id` in search requests — EverMemOS filters by it. Omitting defaults to `__all__`.
- **Store returns 202**: With `@timeout_to_background()`, store returns 202 Accepted after 5s for background processing. Our `store()` returns the generated `message_id` UUID.
- **Foresight model**: Uses `google/gemini-2.5-flash` via OpenRouter for reliable foresight JSON extraction.
- **Delete limitations**: `DELETE /api/v1/memories` only soft-deletes MemCells — derived memories (episodic, foresight, event_log) remain searchable. Tracked upstream: [EverMemOS#148](https://github.com/EverMind-AI/EverMemOS/issues/148).
- **`customPrompt` ignored**: EverMemOS handles extraction internally via its MemCell pipeline; unlike Graphiti, extraction is not configurable per-message.
- **Memory type mapping**: `episodic_memory` → `chunk`, `profile` → `summary`, `foresight` → `summary`, `event_log` → `fact`. Context prefixes (`episode:`, `profile:`, `foresight:`, `event:`) disambiguate in search results.
