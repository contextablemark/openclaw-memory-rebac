# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-03-18

### Added

- **Per-agent subject identity**: Tools and lifecycle hooks now derive the SpiceDB subject from the runtime `agentId` (via `OpenClawPluginToolContext` / `PluginHookAgentContext`), falling back to config-level `subjectType`/`subjectId` when `agentId` is absent. This means multiple agents sharing a single gateway each get their own `shared_by` identity in SpiceDB, enabling distinct ownership and access control per agent. Tool registrations converted from direct objects to tool factories to receive per-agent context.
- **Per-agent state isolation**: Session IDs and SpiceDB write tokens (zedTokens) are tracked per agent via a `Map<string, AgentState>`, replacing the previous single `currentSessionId`/`lastWriteToken`. Agents no longer share session state or consistency tokens.
- **Identity linking (`identities` config)**: New `identities` config field maps agent IDs to their owner person IDs (e.g., Slack user IDs). At plugin startup, `agent:<agentId> #owner person:<personId>` relationships are written to SpiceDB, activating the existing `act_as` permission in the authorization schema. This enables cross-agent recall without any SpiceDB schema changes.
- **Owner-aware recall in `memory_recall`**: When the calling agent has an owner (via `identities`), `memory_recall` now runs a second search path in parallel: it looks up the agent's owner person ID, queries SpiceDB for all `memory_fragment` IDs where that person is in `involves`, fetches fragment details from the backend, and merges them with the group-based results. This enables scenarios like: stenographer stores a decision with `involves: [person:U0123ABC]`, and later Cara's personal agent (linked to `person:U0123ABC` via `identities`) can discover that decision even though it was stored in a group the personal agent doesn't belong to.
- **`lookupAgentOwner` helper** (`authorization.ts`): Queries SpiceDB for `agent:<id> #owner` relationships and returns the owner's person ID, or `undefined` if no owner is linked.
- **`getFragmentsByIds` backend method** (`backend.ts`, `backends/graphiti.ts`): Optional method on the `MemoryBackend` interface to fetch fragment details by their SpiceDB-tracked IDs. The Graphiti implementation uses the `entity-edge` endpoint. Used by owner-aware recall to hydrate fragment IDs discovered via `involves` permissions.
- **Stenographer agent runbook** (`docs/stenographer-runbook.md`): Comprehensive setup guide for deploying a passive Slack-monitoring agent that observes channels, detects decisions/action items, and stores them with `involves` relationships for cross-agent access control. Includes SOUL.md template, `openclaw.json` configuration, verification checklist, troubleshooting, and architecture diagram.
- **CLI: `--as` subject override** for `search` and `groups` commands. Accepts `"type:id"` (e.g., `"agent:main"`, `"person:U0123ABC"`) or bare `"id"` (defaults to agent type). Enables querying as a different subject without changing config.
- **CLI: `identities` command**: Lists configured identity links and verifies each against SpiceDB (shows `verified`, `mismatch`, or `not found`).
- **CLI: `link-identity` / `unlink-identity` commands**: Write or remove `agent→owner` relationships in SpiceDB directly from the CLI, without restarting the gateway.
- **CLI: `status` enhanced**: Now displays the current subject and configured identity links.
- **CLI: Owner-aware recall in `search`**: When the subject is an agent with an owner, `search` now also finds memories where the owner is in `involves` (same logic as `memory_recall`).
- **Unit tests**: 15 new tests covering per-agent identity, identity linking, owner-aware recall, fallback behavior, `parseSubjectOverride`, and identity management CLI commands.
- **E2E integration tests**: 7 new tests exercising the full stenographer feature set against live SpiceDB + Graphiti — decision storage with `involves`, permission enforcement (view vs. delete), per-agent group isolation, owner-aware fragment discovery, end-to-end agent→owner→involves chain, and unauthorized agent denial.

### Fixed

- **`memory_forget` always fails with "Permission denied"**: SpiceDB relationships were written using the Graphiti episode UUID, but `memory_recall` returns fact UUIDs — so fragment-level permission checks on facts always failed (no relationships existed for them). Root cause: Graphiti extracts multiple facts from each episode, but the plugin only tracked the episode UUID, not the individual fact UUIDs. Fixed with a three-part approach ([#2](https://github.com/contextablemark/openclaw-memory-rebac/issues/2)):
  - **Per-fact relationship writing**: Added `GET /episodes/{uuid}/edges` endpoint to the Graphiti Docker overlay (queries Neo4j `RELATES_TO` relationships by episode), exposed as `discoverFragmentIds()` on the backend interface. After episode processing completes, the plugin now discovers extracted fact UUIDs and writes `shared_by` + `source_group` relationships for each fact — not the episode.
  - **Group-level fallback in `memory_forget`**: When fragment-level delete permission is missing (old memories, edge cases), falls back to checking `contribute` permission on authorized groups.
  - **`backfill-relationships` CLI command**: `rebac-mem backfill-relationships` retroactively writes per-fact SpiceDB relationships for existing episodes, enabling deletion and fine-grained sharing of old memories.
- **Async registration warning from OpenClaw plugin loader**: `register()` was `async` (to await dynamic backend imports), causing the loader to emit "plugin register returned a promise; async registration is ignored". Replaced dynamic `import()` in `backends/registry.ts` with static imports, making `register()` fully synchronous.
- **No compiled `.js` artifacts**: Plugin shipped raw `.ts` files, requiring the host to transpile at load time. Added `tsc` build step emitting to `dist/`, updated `package.json` `main` and `openclaw.extensions` to point to `./dist/index.js`, added `prepublishOnly` hook.
- **Embedding clobber from LLM-extracted attributes** (Docker image): `_sanitize_attributes` in `startup.py` now strips reserved keys (`fact_embedding`, `uuid`, `source_node_uuid`, `target_node_uuid`, `name_embedding`, `group_id`, etc.) from LLM-extracted attributes before they are merged via `dict.update()` in graphiti-core's `add_nodes_and_edges_bulk_tx`. Previously, models like `llama-3.3-70b-versatile` (Groq) would include `fact_embedding` as an attribute key, overwriting the valid Voyage AI embedding vector with a string and causing `setRelationshipVectorProperty` failures in Neo4j. ([#6](https://github.com/contextablemark/openclaw-memory-rebac/issues/6))

### Migration

- **No database migration required.** The SpiceDB authorization schema (`schema.zed`) is unchanged — `agent { relation owner: person; permission act_as = owner }` was already present. New `agent #owner person` relationships are purely additive and written automatically at startup from the `identities` config. Existing deployments upgrade by restarting the gateway with the new plugin version. If `identities` is omitted, all behavior is identical to 0.2.0.

## [0.2.0] - 2026-03-14

### Security

- **Bind all exposed ports to `127.0.0.1`**: Graphiti (8000), SpiceDB gRPC (50051), and SpiceDB HTTP (8080) were previously bound to `0.0.0.0`, exposing them to the network. All three now bind to localhost only, preventing remote access.

## [0.1.5] - 2026-03-12

### Fixed

- **IS_DUPLICATE_OF dedup edges pollute search results** (Docker image): Older graphiti-core versions and certain LLMs (e.g. `llama-3.3-70b-versatile`) create `IS_DUPLICATE_OF`, `DUPLICATE_OF`, `HAS_DUPLICATE`, and `DUPLICATES` edges between overlapping entity nodes. These are dedup artifacts, not real knowledge. `startup.py` now filters them at two levels: `safe_extract_edges` (early, before embedding computation) and `patched_bulk_add` (safety net before Neo4j write). ([#12](https://github.com/Contextable/openclaw-memory-rebac/issues/12))
- **Self-referential edges** (Docker image): Edges where `source_node_uuid == target_node_uuid` are now filtered out in `patched_bulk_add` before being written to Neo4j.

### Added

- E2E test for IS_DUPLICATE_OF edge filtering: stores overlapping entity mentions and verifies no dedup artifacts appear in search results.

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
