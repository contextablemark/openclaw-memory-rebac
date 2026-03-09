# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Groq JSON mode 400 errors**: Added `JsonSafeLLMClient` wrapper in `graphiti_overlay.py` that injects "Respond in JSON format." into system messages when `response_format=json_object` is set but no message mentions "json" — required by Groq and some other OpenAI-compatible providers
- **Graphiti port not accessible from host**: Changed `expose` to `ports` in `docker/graphiti/docker-compose.yml` so port 8000 is reachable from outside the Docker network

### Added

- **Embedding diagnostic logging**: Warnings in `startup.py` for edges with missing/invalid `fact_embedding` and for `fact_embedding` appearing in edge attributes (potential clobbering bug)

## [0.1.0] - 2026-03-03

### Added

- **Two-layer memory architecture**: SpiceDB for authorization, pluggable backend for storage
- **Graphiti REST backend**: Knowledge graph storage via Graphiti FastAPI server (Neo4j)
  - Direct REST API integration (replacing MCP transport)
  - Dual-mode search: nodes (entities) and facts (relationships) in parallel
  - Episode UUID polling with configurable interval and max attempts
  - Configurable HTTP request timeout (`requestTimeoutMs`)
  - Backend-specific CLI commands (`episodes`, `fact`, `clear-graph`)
- **Custom Graphiti Docker image** (`docker/graphiti/`):
  - `OpenClawGraphiti` subclass bypasses `ZepGraphiti` to properly forward embedder and cross_encoder params to the base `Graphiti` constructor
  - Per-component LLM/embedder/reranker configuration via `ExtendedSettings`
  - BGE reranker support (local sentence-transformers, no API needed)
  - Singleton Graphiti client to avoid "Driver closed" errors in background tasks
  - Neo4j connection retry with exponential backoff on startup
  - Resilient AsyncWorker that logs and recovers from job failures instead of dying silently
  - Attribute sanitization for Neo4j: flattens nested dicts/lists from LLM-extracted attributes on both entity nodes and edges
  - Safe `extract_edges` wrapper for LLMs that return None for node indices
- **SpiceDB authorization**: Relationship-based access control at the data layer
  - Authorization schema with `person`, `agent`, `group`, and `memory_fragment` types
  - Group-based access control with `member`, `access`, `contribute` permissions
  - Fragment-level permissions: `view` (involved + shared_by + group access), `delete` (shared_by only)
  - Auto-schema-write on first startup
  - Auto-membership for configured subject in default group
- **SpiceDB Docker Compose** (`docker/spicedb/`): PostgreSQL-backed SpiceDB with migration
- **Combined Docker Compose** (`docker/docker-compose.yml`): Single-command full stack startup
- **MemoryBackend interface** (`backend.ts`): Defines the contract for pluggable storage engines
  - `store`, `searchGroup`, `enrichSession`, `getConversationHistory`
  - `healthCheck`, `getStatus`, `deleteGroup`, `listGroups`, `deleteFragment`
  - CLI extension point for backend-specific commands
- **Agent tools**: `memory_recall`, `memory_store`, `memory_forget`, `memory_status`
- **Auto-recall hook** (`before_agent_start`): Injects relevant memories into agent context before each turn
  - Parallel search across all authorized groups
  - Deduplicates session results against long-term results
  - Configurable via `autoRecall` flag
- **Auto-capture hook** (`agent_end`): Captures conversation fragments after each agent turn
  - Stores to session group with SpiceDB fragment registration
  - Configurable max messages and custom extraction instructions
  - Configurable via `autoCapture` flag
- **Session groups**: Per-conversation memory isolation (`session-<id>`)
  - Auto-created membership for the agent
  - Exclusive access — other agents cannot read foreign sessions
- **CLI** (`rebac-mem`): `search`, `status`, `schema-write`, `groups`, `add-member`, `import`, `episodes`
  - Standalone mode (no gateway required) via `bin/rebac-mem.ts`
  - Config priority: env vars > JSON config file > defaults
- **Environment variable interpolation**: `${VAR}` syntax in string config values
- **Plugin manifest** (`openclaw.plugin.json`): Config schema with UI hints for OpenClaw plugin installer
- **Test suites**: 96 unit tests (vitest) + 15 E2E tests (live services, `OPENCLAW_LIVE_TEST=1`)
- **Drop-in backend registry** (`backends/backends.json`, `backends/registry.ts`): JSON-driven dynamic backend loading — adding a new storage backend requires only a new module, a defaults JSON file, and one line in `backends.json`. No TypeScript changes to any existing file.
  - `backends/backends.json` is the single source of truth for backend names; no backend name strings appear in `config.ts` or `index.ts`
  - Backend-specific config defaults live entirely in `backends/<name>.defaults.json`
  - `RebacMemoryConfig.backendConfig` (generic `Record<string, unknown>`) replaces the typed per-backend field

### Fixed

- **Plugin load failure**: Replaced top-level `await` in `registry.ts` with an explicit `initRegistry()` async function called from `register()` — the OpenClaw plugin loader does not support top-level `await` in ESM modules
- **npm publishing**: Added `plugin.defaults.json` to `files` (it is imported at runtime by `config.ts` but was missing from the published package), added `peerDependencies: { openclaw: "*" }`, added `peerDependencies` declaration
- **`extract_edges` None-index crash** (Docker image): Improved patch in `startup.py` to filter bad edges at model-parse level so valid edges from the same episode are preserved; falls back to per-function TypeError catch for newer graphiti-core versions that use name-based validation
