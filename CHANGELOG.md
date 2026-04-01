# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Graphiti Docker image built from source (v0.28.1)**: Replaced `FROM zepai/graphiti:0.22.0` base image with a fully reproducible source build from the [Contextable graphiti fork](https://github.com/Contextable/graphiti), pinned to commit `aa68b38`. The new Dockerfile starts from `python:3.12-slim`, clones the repo at build time via `git clone`, and installs both `graphiti-core` and `graph_service` (the FastAPI server) using `uv`. Upgrades graphiti-core from v0.22.0 to v0.28.1, gaining native structured output (`json_schema` response format), name-based edge model, and upstream bug fixes.
- **Overlay files installed to site-packages**: `config_overlay.py` and `graphiti_overlay.py` are now copied into the installed `graph_service` package location (dynamically discovered at build time) instead of a local `/app/graph_service/` directory.
- **Docker healthcheck uses Python**: Replaced `curl` with `python -c "import httpx; ..."` since `curl` is not available in the `python:3.12-slim` base image.
- **`JsonSafeLLMClient` simplified**: Removed the `_generate_response` override that backported structured output — v0.28.1's `OpenAIGenericClient` natively uses `json_schema` response format. The class now only injects the `"json"` keyword into system messages for Groq/Ollama compatibility.
- **`create_graphiti()` reranker wiring simplified**: Removed the `_create_reranker()` wrapper function. Reranker construction now uses native `BGERerankerClient` and `OpenAIRerankerClient` imports directly from `graphiti_core.cross_encoder`.
- **Runtime patches reduced from 13 to 8**: Five patches removed (see Removed below). Remaining patches: singleton client lifecycle, resilient AsyncWorker, Neo4j attribute sanitization, reserved key protection, IS_DUPLICATE_OF edge filtering, self-referential edge filtering, empty batch embedder guard, and episodes edges endpoint.

### Removed

- **Structured output backport** (`JsonSafeLLMClient._generate_response` override): v0.28.1's `OpenAIGenericClient` natively uses `json_schema` structured output, making the backport unnecessary.
- **`entity_type_id` IndexError guard** (`safe_extract_nodes` in `startup.py`): v0.28.1 has bounds checking for entity type IDs (line 184 of `extract_nodes`).
- **`resolve_extracted_edge` IndexError guard** (`safe_resolve_extracted_edge` in `startup.py`): v0.28.1 validates `contradicted_facts` indices before access (line 591 of `resolve_extracted_edge`).
- **None-index edge filtering** (`safe_extract_edges` TypeError guard in `startup.py`): v0.28.1 uses a name-based edge model (`source_entity_name`/`target_entity_name` strings) instead of integer indices, eliminating the `None` index failure mode.
- **Custom `_create_reranker()` wrapper** (in `graphiti_overlay.py`): v0.28.1 has native `BGERerankerClient` support in `graphiti_core.cross_encoder.bge_reranker_client`.

### Fixed

- **Empty embedding batch crash**: Ollama's `/v1/embeddings` returns 400 for empty input arrays. Models that extract zero entities (e.g., gemma3) or entities with `None` names now short-circuit with `return []` instead of sending an empty batch.

### Added

- **Reasoning token suppression**: Injects `think: false` via `extra_body` for all Graphiti LLM calls, suppressing `<think>...</think>` blocks from reasoning models (qwen3, deepseek-r1) that waste inference time on extraction prompts.

## [0.5.4] - 2026-03-31

### Fixed

- **Liminal auto-recall score filtering**: EverMemOS search scores from the Qwen3-Reranker-4B model are raw logit-derived values (0.0001–0.01 range), not normalized 0–1. The previous `minLiminalScore` threshold of 0.1 filtered out all results — even highly relevant fresh memories. `formatLiminalContext()` now normalizes scores relative to the batch maximum before filtering: top result = 1.0, others proportional. The threshold is now reranker-agnostic.

### Changed

- **Structured `<memory>` XML for liminal auto-recall**: Hybrid mode's `before_agent_start` hook now injects EverMemOS memories as structured XML (`<memory>` with `<episodic>`, `<profile>`, `<foresight>`, `<event>` sections) instead of flat `<recent-context>` text. Each memory is capped at 2000 characters. Aligns with the upstream EverMemOS OpenClaw plugin's formatting approach.
- **`autoRecallLimit` default reduced from 8 to 5**: Reduces context window consumption during the preload phase, aligning with the upstream EverMemOS plugin's `topK: 5`.
- **`minLiminalScore` default changed from 0.1 to 0.3**: With score normalization, 0.3 means "include results scoring at least 30% of the best match in the batch". Filters low-relevance results while keeping meaningful context.
- **Memory echo prevention**: User messages are now stripped of `<memory>`, `<recent-context>`, `<relevant-memories>`, and `<memory-tools>` blocks before EverMemOS auto-capture, preventing previously-injected context from being re-stored as new memories.

### Added

- **`autoRecallLimit` config key**: Controls how many results the liminal auto-recall hook fetches from EverMemOS (default: 5). Previously hardcoded to 8.
- **`minLiminalScore` config key**: Minimum normalized relevance score for liminal auto-recall results (default: 0.3). Results below this threshold are excluded from injected context.

## [0.5.3] - 2026-03-31

### Added

- **Canonical identity resolution via `identityLinks`**: SpiceDB person IDs now resolve to canonical names using OpenClaw's `session.identityLinks` config. Agents can say `memory_share(id, ["carson"])` instead of raw platform IDs. Resolution is applied to `memory_share`, `memory_unshare`, `identities`, `groupOwners`, and `subjectId`. Falls back to raw IDs when `identityLinks` is not configured.

## [0.5.2] - 2026-03-30

### Fixed

- **Per-agent liminal memory isolation**: Each agent now gets its own EverMemOS group (`{baseGroupId}:{agentId}`) for conversational memory. Previously all agents shared a single group, causing full bleed-through of unrelated conversations in `<recent-context>`.

## [0.5.1] - 2026-03-30

### Added

- **`memory_share` and `memory_unshare` in toolHint**: Agents are now made aware of the share/unshare tools via the injected `<memory-tools>` context in both unified and hybrid modes.

### Fixed

- **SpiceDB schema always written at startup**: Schema is now unconditionally written on every startup (idempotent). Previously, a keyword check could skip the write when new permissions were added to existing definitions, causing `FAILED_PRECONDITION` errors. Includes a single retry with 2s delay if SpiceDB isn't ready yet, and errors are now logged instead of silently swallowed.

## [0.5.0] - 2026-03-30

### Added

- **Composite plugin architecture**: Two operating modes — **unified** (Graphiti handles tools + hooks, same as v0.4.x) and **hybrid** (Graphiti for tools with ReBAC, EverMemOS for conversational hooks without SpiceDB). Configured via a new `liminal` config field that defaults to the `backend` value.
- **`liminal` config field**: Set to `"evermemos"` for hybrid mode. When omitted or equal to `backend`, the plugin operates in unified mode (identical to v0.4.x behavior).
- **Hybrid hook routing**: In hybrid mode, `before_agent_start` queries EverMemOS for recent conversational context (injected as `<recent-context>`), and `agent_end` stores to EverMemOS only (fire-and-forget, no SpiceDB writes). Graphiti knowledge is accessed on-demand via `memory_recall`. Unified mode behavior is unchanged.
- **`memory_promote` tool** (hybrid mode only): Searches the liminal backend (EverMemOS) and stores matching memories into the primary backend (Graphiti) with full SpiceDB fragment authorization. Bridges short-term conversational context into the long-term knowledge graph.

### Removed

- **`backend: "evermemos"` as primary backend**: EverMemOS now serves exclusively as the liminal backend for hook-driven auto-recall and auto-capture. Tool-based operations (`memory_recall`, `memory_store`, `memory_forget`, `memory_share`, `memory_unshare`) always route to Graphiti.
- **Trace overlay** (`docker/evermemos/trace_overlay.py`): No longer needed — EverMemOS doesn't write SpiceDB fragment relationships in its liminal role.
- **`discoverFragmentIds` / `resolveAnchors`** from EverMemOS backend and `resolveAnchors` from the `MemoryBackend` interface.
- **Recall rate limiting** (`maxRecallsPerTurn` config, rate-limit check in `memory_recall`): Was an artifact of using EverMemOS as the primary tool backend.
- **EverMemOS discovery config** (`discoveryPollIntervalMs`, `discoveryTimeoutMs`).

### Migration

- **`backend: "evermemos"` users**: Migrate to `"backend": "graphiti", "liminal": "evermemos"`. EverMemOS can no longer be the primary backend.
- **Remove `maxRecallsPerTurn`** from config if present (now rejected as unknown key).
- **Remove `discoveryPollIntervalMs` / `discoveryTimeoutMs`** from `evermemos` config if present.

## [0.4.2] - 2026-03-28

### Fixed

- **npmSpec pinned to old version**: `openclaw plugins update` could not resolve newer published versions because `npmSpec` was pinned to `0.3.5`. Updated to `@latest`.

## [0.4.1] - 2026-03-28

### Fixed

- **EverMemOS Docker build files missing from npm package**: `entrypoint.sh` and `supervisord.conf` were excluded because `package.json` `files` array was missing `*.sh` and `*.conf` globs. The EverMemOS Docker image failed to build on install targets.

## [0.4.0] - 2026-03-27

### Added

- **EverMemOS backend** (`backends/evermemos.ts`): Second storage backend, implementing the full `MemoryBackend` interface against the EverMemOS MemCell-based memory system. Supports episodic memory, profile, foresight, and event log memory types with configurable hybrid/keyword/vector retrieval. Store returns a UUID anchor immediately (202 Accepted); search aggregates results from group-keyed response structure. Memory type mapping: `episodic_memory`→`chunk`, `profile`→`summary`, `foresight`→`summary`, `event_log`→`fact`, with context prefixes (`episode:`, `profile:`, `foresight:`, `event:`) for downstream disambiguation.
- **EverMemOS Docker stack** (`docker/evermemos/`): All-in-one container running MongoDB, Elasticsearch, Milvus, Redis, and EverMemOS API server via supervisord. Built from source (pinned to commit `3c9a2d0`). Milvus binaries extracted from official `milvusdb/milvus` image via multi-stage build. `entrypoint.sh` generates `.env` from Docker environment variables. Compose file at `docker/docker-compose.evermemos.yml`.
- **Trace overlay endpoint** (`docker/evermemos/trace_overlay.py`): Read-only FastAPI route (`GET /api/v1/memories/trace/{message_id}`) added to the EverMemOS Docker image. Traces the internal linkage chain (`memory_request_logs` → `memcells` → episodic/foresight/event_log collections) to return the MongoDB ObjectIds of all derived memories produced from a given ingestion message. Returns `status: "not_found"|"processing"|"complete"` with `all_ids` array. Uses pymongo with `asyncio.to_thread` for FastAPI compatibility. This endpoint is the bridge between store-time UUID anchors and search-time MongoDB ObjectIds.
- **Fragment ID resolution for EverMemOS** (`discoverFragmentIds`, `resolveAnchors`): Two-phase resolution of the fragment ID mismatch (store returns UUIDs, search returns MongoDB ObjectIds):
  - `discoverFragmentIds()` polls the trace overlay after store until extraction completes, returning actual ObjectIds for SpiceDB relationship writing. Configurable via `discoveryPollIntervalMs` (default 3s) and `discoveryTimeoutMs` (default 120s).
  - `resolveAnchors()` provides lazy resolution at recall time — if `discoverFragmentIds` timed out, the next `memory_recall` resolves anchors via the trace endpoint and updates SpiceDB in the background, making future recalls fast.
- **`resolveAnchors` on `MemoryBackend` interface** (`backend.ts`): Optional method for backends where store-time IDs differ from search-time IDs. Returns `Map<anchor, resolvedIds[]>`. Used by the lazy resolution path in `memory_recall`.
- **`memory_share` tool**: Share a specific memory fragment with one or more people/agents, granting them view access via SpiceDB `involves` relationships. Accepts type-prefixed IDs from `memory_recall` (e.g. `fact:UUID`, `chunk:UUID`). Only the memory's creator (`shared_by`) or a group admin (`source_group->admin`) can share.
- **`memory_unshare` tool**: Revoke view access by removing `involves` relationships. Same permission model as `memory_share`.
- **SpiceDB share/unshare authorization** (`authorization.ts`): `canShareFragment`, `shareFragment`, `unshareFragment`, `ensureGroupOwnership` helpers. `canShareFragment` checks the new `share` permission; `shareFragment`/`unshareFragment` write/delete `involves` tuples.
- **SpiceDB schema: `owner` relation and `share`/`admin` permissions** (`schema.zed`): Groups now have an `owner` relation with `admin` permission. Memory fragments gain a `share` permission granted to `shared_by + source_group->admin`, enabling group owners to share any memory from their groups.
- **`groupOwners` config** (`config.ts`): Maps group IDs to owner person IDs (e.g. `{"slack-engineering": ["U0123"]}`). At startup, writes `group:X #owner person:Y` relationships to SpiceDB, activating admin-level sharing for those groups.
- **Backend-agnostic E2E contract tests** (`e2e-backend.test.ts`): 13 tests validating the `MemoryBackend` interface contract against any configured backend (`E2E_BACKEND` env var). Covers lifecycle, SpiceDB schema, store→search→forget, authorization, share/unshare chain, group ownership, and graceful error handling.
- **EverMemOS-specific E2E tests** (`e2e-evermemos.test.ts`): 8 tests covering EverMemOS-specific behavior: fragment anchor semantics, `discoverFragmentIds` capability, type mapping and context prefixes, `enrichSession` integration, memory type filtering, `customPrompt` handling, and a comprehensive fragment-level auth flow test (trace → resolve → write SpiceDB → share → unshare → involves → search post-filter).
- **EverMemOS unit tests** (`backends/evermemos.test.ts`): 10 tests covering store, search, type mapping, `discoverFragmentIds` polling, `resolveAnchors`, timeout handling, and error paths.
- **Backend registry: `evermemos` entry** (`backends/registry.ts`): Static import and registration of the EverMemOS backend module.
- **npm scripts**: `test:e2e:backend` (backend-agnostic E2E), `test:e2e:evermemos` (EverMemOS-specific E2E).

### Changed

- **Lazy resolution in `memory_recall`** (`index.ts`): When the involves-based post-filter yields 0 results but candidate search results exist, the recall path now attempts `resolveAnchors` to resolve stale UUID anchors to actual MongoDB ObjectIds. On success, SpiceDB relationships are updated in the background so future recalls skip the resolution step.
- **`discoverFragmentIds` comment updated** (`index.ts`): Documents both Graphiti (polls `/episodes/{id}/edges`) and EverMemOS (polls trace overlay) discovery paths, plus fallback behavior.
- **Docker compose renamed**: `docker/docker-compose.yml` → `docker/docker-compose.graphiti.yml` to distinguish from the new EverMemOS compose file.
- **E2E test refactored**: `e2e.test.ts` reduced from Graphiti-specific to a thin wrapper; backend-agnostic tests extracted to `e2e-backend.test.ts`.
- **Build script updated** (`package.json`): Now copies `backends/evermemos.defaults.json` to `dist/backends/` alongside `graphiti.defaults.json`.

### Migration

- **SpiceDB schema update required.** The `schema.zed` adds `owner` relation to `group`, `admin` permission to `group`, and `share` permission to `memory_fragment`. Run `schema-write` or restart the plugin (auto-schema-write handles it). Existing relationships are unaffected — these are purely additive.
- **Config update for EverMemOS.** To switch from Graphiti to EverMemOS, set `"backend": "evermemos"` and add an `"evermemos"` config block with `endpoint`, `defaultGroupId`, `retrieveMethod`, `memoryTypes`, and `defaultSenderId`. See `docs/configuration-guide.md`.

## [0.3.8] - 2026-03-24

### Fixed

- **Strip envelope metadata before Graphiti ingestion** ([#23](https://github.com/contextablemark/openclaw-memory-rebac/issues/23)): Auto-capture now strips OpenClaw envelope metadata from user messages before sending them to Graphiti for entity extraction. Previously, channel headers (`[Telegram Dev Chat +5m ...]`), sender meta lines (`[from: Alice (42)]`), and message ID hints (`[message_id: 804]`) were ingested verbatim, causing Graphiti to extract redundant noise facts like "Mark's Telegram Chat ID is 85555555" on every turn. The new `stripEnvelopeMetadata()` function removes these metadata patterns — along with the already-handled `<relevant-memories>` and `<memory-tools>` blocks — in a single pass. Also applied to the `enrichSession` code path.
- **Guard resolve_extracted_edge against IndexError** ([#22](https://github.com/contextablemark/openclaw-memory-rebac/issues/22)): Added runtime patch in `startup.py` to catch `IndexError` in Graphiti's `resolve_extracted_edge` when the LLM returns `contradicted_facts` indices that exceed the `existing_edges` list bounds. On crash, the edge is preserved as-is with no invalidations instead of silently failing and leaving behind `IS_DUPLICATE_OF` artifacts. Upstream v0.28.2+ includes a native fix but no Docker image has been published beyond 0.22.0.

## [0.3.7] - 2026-03-22

### Fixed

- **Auto-capture skips user messages** ([#19](https://github.com/contextablemark/openclaw-memory-rebac/issues/19)): The `agent_end` auto-capture filter discarded any message containing `<relevant-memories>`, which matched virtually all user messages because `autoRecall` injects that block into user context via `prependContext`. Now strips the `<relevant-memories>` and `<memory-tools>` XML blocks from message text instead of skipping the entire message, preserving the user's actual content in episodic captures. Same fix applied to the CLI `import` transcript filter for consistency.

## [0.3.6] - 2026-03-22

### Added

- **Session filtering for auto-capture and auto-recall** ([#16](https://github.com/contextablemark/openclaw-memory-rebac/issues/16)): New `sessionFilter` config option with `excludePatterns` and `includePatterns` arrays. Sessions whose key matches an exclude pattern (or fails to match any include pattern) skip auto-capture and auto-recall entirely. Explicit memory tools (`memory_recall`, `memory_store`, etc.) remain available to all sessions — only the automatic hooks are filtered. This prevents cron/monitoring sessions from flooding the knowledge graph with repetitive, low-value facts.

### Fixed

- **Test mock isolation**: Added `vi.clearAllMocks()` to `beforeEach` in `index.test.ts` to prevent shared mock call history from leaking between tests.

## [0.3.5] - 2026-03-21

### Changed

- **Single multi-group search**: `searchAuthorizedMemories` now prefers `backend.searchGroups()` — a single call with all authorized group IDs — so the backend applies cross-group relevance ranking (Graphiti RRF: cosine similarity + BM25). Falls back to per-group fan-out when `searchGroups()` is not implemented. This fixes search relevance degradation where per-group fan-out discarded backend ranking and fell back to recency-only ordering.
- **Combined recall path in `memory_recall` and `before_agent_start`**: Long-term and session groups are now searched in a single `searchAuthorizedMemories` call (instead of two separate calls), then results are split by group type for formatting. Reduces round-trips and leverages unified ranking.
- **Pin all dependency versions**: Replaced semver ranges with exact versions for supply-chain stability (`@authzed/authzed-node@1.6.1`, `@grpc/grpc-js@1.14.3`, `commander@13.1.0`, `dotenv@17.3.1`, `typescript@5.9.3`, `vitest@4.0.18`).
- **Pin Graphiti Docker image**: Changed `FROM zepai/graphiti:latest` to `FROM zepai/graphiti:0.22.0` with upgrade audit documenting which overlay patches are still needed at upstream v0.28.2 (5 of 6).

### Added

- **`searchGroups()` on `MemoryBackend` interface**: Optional method for backends that support multi-group search in a single call. `GraphitiBackend` implements it using POST `/search` with multiple `group_ids`.

### Removed

- **`deduplicateSessionResults()`**: Dead code after search consolidation — session dedup is now handled by the unified search path.

## [0.3.4] - 2026-03-21

### Fixed

- **Owner-aware recall now query-relevant**: Previously, the owner-aware recall path (`involves`-based) fetched all viewable fragments by ID without query filtering, returning identical results regardless of what the user asked. Now uses a search-then-post-filter approach: discovers source groups of viewable fragments, searches those groups with the actual query via Graphiti, then post-filters results against the authorized fragment set. This ensures both query relevance (semantic search) and authorization security (SpiceDB allow-list).

### Added

- **`lookupFragmentSourceGroups` helper** (`authorization.ts`): Discovers which groups a set of memory fragments belong to by reading `source_group` relationships from SpiceDB. Used by the search-then-post-filter recall pipeline.

### Removed

- **`getFragmentsByIds` backend method**: Removed from `MemoryBackend` interface and `GraphitiBackend` — no longer needed now that owner-aware recall uses search-then-post-filter instead of direct fragment fetching.

## [0.3.3] - 2026-03-19

### Added

- **SpiceDB schema: `involves->represents` traversal**: Agents can now view memory fragments where their owner person is in `involves`, resolved entirely within SpiceDB via `involves->represents` arrow permission. No code-level owner resolution needed for permission checks.
- **Bidirectional identity tuples**: `link-identity` and startup identity writing now create both `agent:X#owner@person:Y` and `person:Y#agent@agent:X` relationships, enabling the `involves->represents` schema traversal.

### Changed

- **`person` definition** now has `relation agent: agent` and `permission represents = agent` for reverse lookups.
- **`memory_fragment.view` permission** now includes `involves->represents` in addition to existing paths.

## [0.3.2] - 2026-03-19

### Fixed

- **CLI: `search` now works for `person` subjects**: Previously, `search --as person:U0123ABC` only searched groups (finding none), ignoring `involves`-based fragment access. Now fragment-based search via `lookupViewableFragments` runs for both `person` and `agent` subjects.

### Changed

- **Stenographer SOUL.md updates**: Broadened `involves` scope to include acknowledgers/approvers; added post-store channel acknowledgement; strengthened `memberInfo` resolution instructions; replaced `slack_actions` with correct `message` tool name.
- **Runbook prerequisites**: Added required Slack OAuth scopes and event subscriptions documentation.

## [0.3.1] - 2026-03-19

### Added

- **CLI: `identities` command**: Lists configured identity links and verifies each against SpiceDB (shows `verified`, `mismatch`, or `not found`).
- **CLI: `link-identity` / `unlink-identity` commands**: Write or remove `agent→owner` relationships in SpiceDB directly from the CLI, without restarting the gateway.
- **CLI: `--as` subject override** for `search` and `groups` commands. Accepts `"type:id"` (e.g., `"agent:main"`, `"person:U0123ABC"`) or bare `"id"` (defaults to agent type).
- **CLI: `status` enhanced**: Now displays the current subject and configured identity links.
- **CLI: Owner-aware recall in `search`**: When the subject is an agent with an owner, `search` also finds memories where the owner is in `involves`.

## [0.3.0] - 2026-03-18

### Added

- **Per-agent subject identity**: Tools and lifecycle hooks now derive the SpiceDB subject from the runtime `agentId` (via `OpenClawPluginToolContext` / `PluginHookAgentContext`), falling back to config-level `subjectType`/`subjectId` when `agentId` is absent. This means multiple agents sharing a single gateway each get their own `shared_by` identity in SpiceDB, enabling distinct ownership and access control per agent. Tool registrations converted from direct objects to tool factories to receive per-agent context.
- **Per-agent state isolation**: Session IDs and SpiceDB write tokens (zedTokens) are tracked per agent via a `Map<string, AgentState>`, replacing the previous single `currentSessionId`/`lastWriteToken`. Agents no longer share session state or consistency tokens.
- **Identity linking (`identities` config)**: New `identities` config field maps agent IDs to their owner person IDs (e.g., Slack user IDs). At plugin startup, `agent:<agentId> #owner person:<personId>` relationships are written to SpiceDB, activating the existing `act_as` permission in the authorization schema. This enables cross-agent recall without any SpiceDB schema changes.
- **Owner-aware recall in `memory_recall`**: When the calling agent has an owner (via `identities`), `memory_recall` now runs a second search path in parallel: it looks up the agent's owner person ID, queries SpiceDB for all `memory_fragment` IDs where that person is in `involves`, fetches fragment details from the backend, and merges them with the group-based results. This enables scenarios like: stenographer stores a decision with `involves: [person:U0123ABC]`, and later Cara's personal agent (linked to `person:U0123ABC` via `identities`) can discover that decision even though it was stored in a group the personal agent doesn't belong to.
- **`lookupAgentOwner` helper** (`authorization.ts`): Queries SpiceDB for `agent:<id> #owner` relationships and returns the owner's person ID, or `undefined` if no owner is linked.
- **`getFragmentsByIds` backend method** (`backend.ts`, `backends/graphiti.ts`): Optional method on the `MemoryBackend` interface to fetch fragment details by their SpiceDB-tracked IDs. The Graphiti implementation uses the `entity-edge` endpoint. *(Removed in 0.3.3 — replaced by search-then-post-filter approach.)*
- **Stenographer agent runbook** (`docs/stenographer-runbook.md`): Comprehensive setup guide for deploying a passive Slack-monitoring agent that observes channels, detects decisions/action items, and stores them with `involves` relationships for cross-agent access control. Includes SOUL.md template, `openclaw.json` configuration, verification checklist, troubleshooting, and architecture diagram.
- **Unit tests**: 6 new tests covering per-agent identity, identity linking, owner-aware recall, and fallback behavior.
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
- **Combined Docker Compose** (`docker/docker-compose.graphiti.yml`): Single-command full stack startup
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
