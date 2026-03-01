# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-02-28

### Added

- **Two-layer memory architecture**: SpiceDB for authorization, pluggable backend for storage
- **Graphiti backend**: Knowledge graph storage via Graphiti MCP server (FalkorDB)
  - Dual-mode search: nodes (entities) and facts (relationships) in parallel
  - Episode UUID polling with configurable interval and max attempts
  - Backend-specific CLI commands (`episodes`)
- **SpiceDB authorization**: Relationship-based access control at the data layer
  - Authorization schema with `person`, `agent`, `group`, and `memory_fragment` types
  - Group-based access control with `member`, `access`, `contribute` permissions
  - Fragment-level permissions: `view` (involved + shared_by + group access), `delete` (shared_by only)
  - Auto-schema-write on first startup
  - Auto-membership for configured subject in default group
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
- **Docker Compose** (`docker/graphiti/`): FalkorDB + Graphiti MCP + PostgreSQL + SpiceDB
- **Test suites**: Unit tests (vitest) + E2E tests (live services, `OPENCLAW_LIVE_TEST=1`)

### Fixed

- Fix 12 failing unit tests caused by mock/source drift in `graphiti.test.ts` and `index.test.ts`
  - Add `headers` to tool-call mock responses to match `parseResponse()` content-type check
  - Use `mockReset()` instead of `mockClear()` to prevent mock queue leaks between tests
  - Mock `randomUUID` for deterministic episode name matching in store polling test
  - Make CLI registration mock fully chainable to support `registerCommands()` subcommand creation
