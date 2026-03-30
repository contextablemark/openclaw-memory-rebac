# @contextableai/openclaw-memory-rebac

Composite memory plugin for OpenClaw: **Graphiti** knowledge graph (primary) with optional **EverMemOS** liminal memory, authorized by **SpiceDB** ReBAC.

Agents remember conversations as structured knowledge. SpiceDB enforces who can read and write which memories — authorization lives at the data layer, not in prompts. Two operating modes: **unified** (Graphiti handles everything) or **hybrid** (Graphiti for tools, EverMemOS for conversational hooks, with a promotion bridge).

## Architecture

```
Unified mode (default):
  Tools + hooks → Graphiti → SpiceDB auth on all fragments.

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

**SpiceDB** determines which `group_id`s a subject (agent or person) can access. The **primary backend** (Graphiti) stores and searches memories scoped to those groups. In hybrid mode, the **liminal backend** (EverMemOS) handles conversational auto-recall and auto-capture without SpiceDB authorization — important memories are promoted to Graphiti via the `memory_promote` tool.

### Why This Design?

Most memory systems bundle authorization with storage. openclaw-memory-rebac separates these concerns:
- **SpiceDB** owns the authorization model (relationships, permissions, consistency)
- **Graphiti** owns the curated knowledge graph (entities, facts, structured retrieval)
- **EverMemOS** (optional) owns conversational context (episodic memory, foresight, profiles)
- The plugin orchestrates all three — routing tools to Graphiti with SpiceDB authorization, and hooks to the liminal backend

In unified mode, Graphiti handles everything (same as a single-backend plugin). In hybrid mode, EverMemOS captures conversational context automatically while Graphiti remains the authoritative knowledge store accessed via tools.

## Backends

### Graphiti (primary)

[Graphiti](https://github.com/getzep/graphiti) builds a knowledge graph from conversations. It extracts entities, facts, and relationships, storing them in Neo4j for structured retrieval. Always serves as the primary backend for tools and SpiceDB-authorized operations.

- **Storage**: Neo4j graph database
- **Transport**: Direct REST API to Graphiti FastAPI server
- **Extraction**: LLM-powered entity and relationship extraction (~300 embedding calls per episode)
- **Search**: Dual-mode — searches both nodes (entities) and facts (relationships) in parallel
- **Docker image**: Custom image (`docker/graphiti/`) with per-component LLM/embedder/reranker configuration, BGE reranker support, and runtime patches for local-model compatibility

### EverMemOS (liminal)

[EverMemOS](https://github.com/EverMind-AI/EverMemOS) is a conversational memory system with MemCell boundary detection and parallel LLM extraction. In hybrid mode, it serves as the **liminal backend** — handling auto-recall and auto-capture hooks without SpiceDB authorization.

- **Storage**: MongoDB + Milvus (vector) + Elasticsearch (keyword)
- **Transport**: REST API to EverMemOS FastAPI server (port 1995)
- **Extraction**: MemCell pipeline — automatic boundary detection, then parallel LLM extraction of episodic memories, profiles, foresight, and event logs
- **Search**: Hybrid (vector + keyword + reranking), configurable via `retrieveMethod`
- **Docker image**: Built from source (`docker/evermemos/Dockerfile`), pinned to upstream release tag (v1.1.0)
- **Role**: Liminal only — not used for tool-based operations. Important memories are promoted to Graphiti via `memory_promote`.

#### EverMemOS-specific config

| Key | Default | Description |
|---|---|---|
| `retrieveMethod` | `"hybrid"` | Search method: `"hybrid"`, `"vector"`, `"keyword"` |
| `memoryTypes` | `["episodic_memory", "profile", "foresight", "event_log"]` | Which memory types to search |
| `defaultSenderId` | `"system"` | Sender ID for stored messages |

## Installation

```bash
openclaw plugins install @contextableai/openclaw-memory-rebac
```

Or with npm:

```bash
npm install @contextableai/openclaw-memory-rebac
```

Then restart the gateway. On first start, the plugin automatically:
- Writes the SpiceDB authorization schema (if not already present)
- Creates group membership for the configured agent in the default group

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- A running LLM endpoint (both backends use LLMs for memory extraction)

### 1. Start Infrastructure

**Unified mode (Graphiti only — default)**

```bash
cd docker
cp graphiti/.env.example graphiti/.env
# Edit graphiti/.env — set your LLM endpoint and API key
docker compose -f docker-compose.graphiti.yml up -d
```

This starts: Neo4j (7687), Graphiti (8000), PostgreSQL (5432), SpiceDB (50051).

**Hybrid mode (Graphiti + EverMemOS)**

```bash
# Start Graphiti stack
cd docker
cp graphiti/.env.example graphiti/.env
docker compose -f docker-compose.graphiti.yml up -d

# Start EverMemOS stack (shares SpiceDB)
cd docker/evermemos
cp .env.example .env
# Edit .env — set LLM_API_KEY, VECTORIZE_API_KEY, RERANK_API_KEY
cd ..
docker compose -f docker-compose.evermemos.yml up -d
```

This starts both stacks. EverMemOS first run builds from source (~5 min). Both share the same SpiceDB instance.

### 2. Restart the Gateway

```bash
openclaw gateway restart
```

The plugin auto-initializes on startup — no manual `schema-write` or `add-member` needed for basic use.

### 3. (Optional) Add More Group Members

```bash
rebac-mem add-member family mom --type person
rebac-mem add-member family dad --type person
```

## Tools

The plugin registers the following tools (plus `memory_promote` in hybrid mode):

### memory_recall

Search memories across all authorized groups. Returns entities and facts the current subject is permitted to see.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | *required* | Search query |
| `limit` | number | 10 | Max results |
| `scope` | string | `"all"` | `"session"`, `"long-term"`, or `"all"` |

Searches both nodes and facts across all authorized groups in parallel, then deduplicates and ranks by recency.

### memory_store

Save information to the backend. The storage engine handles extraction and indexing.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `content` | string | *required* | Information to remember |
| `source_description` | string | `"conversation"` | Context about the source |
| `involves` | string[] | `[]` | Person/agent IDs involved |
| `group_id` | string | configured default | Target group for this memory |
| `longTerm` | boolean | `true` | `false` stores to the current session group |

Write authorization is enforced before storing:
- **Own session groups** auto-create membership (the agent gets exclusive access)
- **All other groups** require `contribute` permission in SpiceDB

### memory_forget

Delete a memory fragment. Requires `delete` permission (only the subject who stored the memory can delete it).

| Parameter | Type | Description |
|-----------|------|-------------|
| `episode_id` | string | Fragment UUID to delete |

### memory_status

Check the health of the backend and SpiceDB services. No parameters.

### memory_promote (hybrid mode only)

Promote memories from the liminal backend (EverMemOS) into the primary knowledge graph (Graphiti) with full SpiceDB authorization.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | *required* | Search query to find memories to promote |
| `groupId` | string | configured default | Target group in the knowledge graph |
| `limit` | number | 3 | Max memories to promote |

Searches EverMemOS for matching memories, stores each into Graphiti, and writes SpiceDB fragment relationships. This bridges short-term conversational context into the long-term authorized knowledge graph.

## Automatic Behaviors

### Auto-Recall

When enabled (default: `true`), the plugin searches relevant memories before each agent turn and injects them into context.

**Unified mode**: Searches Graphiti via SpiceDB-authorized groups. Injects as `<relevant-memories>` blocks. Searches up to 5 long-term and 3 session memories per turn, deduplicates session results against long-term.

**Hybrid mode**: Searches EverMemOS only (no SpiceDB). Injects as `<recent-context>` blocks. The agent accesses Graphiti knowledge on-demand via the `memory_recall` tool.

Both modes only trigger when the user prompt is at least 5 characters.

### Auto-Capture

When enabled (default: `true`), the plugin captures the last N messages from each completed agent turn.

**Unified mode**: Stores to Graphiti with full SpiceDB fragment authorization. Uses custom extraction instructions.

**Hybrid mode**: Stores to EverMemOS only (fire-and-forget, no SpiceDB writes). EverMemOS handles extraction internally via its MemCell pipeline. Important memories are promoted to Graphiti via `memory_promote`.

Both modes capture up to `maxCaptureMessages` messages (default: 10), skip messages shorter than 5 characters, and skip injected context blocks.

### Session Filtering

Both auto-recall and auto-capture can be filtered by session key pattern using the `sessionFilter` config option. This is useful for excluding cron jobs, monitoring sessions, or other automated processes that generate repetitive, low-value data.

```json
{
  "sessionFilter": {
    "excludePatterns": ["cron", "monitoring", "healthcheck"]
  }
}
```

- **`excludePatterns`**: Array of strings. If the session key contains any of these substrings, auto-recall and auto-capture are skipped for that session.
- **`includePatterns`**: Array of strings. If set, only sessions whose key contains at least one of these substrings will trigger auto-recall/capture.
- If both are set, `excludePatterns` takes priority (exclude first, then check include).
- If neither is set, all sessions are captured (default behavior).

Filtered sessions still have full access to explicit memory tools (`memory_recall`, `memory_store`, `memory_forget`, `memory_status`). This means a cron job that consolidates memories can still use `memory_recall` and `memory_store` directly — only the automatic hooks are suppressed.

## Authorization Model

The SpiceDB schema defines four object types:

```
definition person {
    relation agent: agent
    permission represents = agent
}

definition agent {
    relation owner: person
    permission act_as = owner
}

definition group {
    relation member: person | agent
    permission access = member
    permission contribute = member
}

definition memory_fragment {
    relation source_group: group
    relation involves: person | agent
    relation shared_by: person | agent

    // involves->represents: if a person is involved, their agent can also view
    permission view = involves + shared_by + source_group->access + involves->represents
    permission delete = shared_by
}
```

### Groups

Groups organize memories and control access. A subject must be a **member** of a group to read (`access`) or write (`contribute`) to it.

Membership is managed via the CLI (`rebac-mem add-member`) or programmatically via `ensureGroupMembership()`.

### Memory Fragments

Each stored memory creates a `memory_fragment` with three relationships:
- **source_group** — which group the memory belongs to
- **shared_by** — who stored the memory (can delete it)
- **involves** — people/agents mentioned in the memory (can view it)

View permission is granted to anyone who is directly involved, shared the memory, or has access to the source group. Delete permission is restricted to the subject who shared (stored) the memory.

### Session Groups

Session groups (`session-<id>`) provide per-conversation memory isolation:
- The agent that creates a session automatically gets exclusive membership
- Other agents cannot read or write to foreign session groups without explicit membership
- Session memories are searchable within the session scope and are deduplicated against long-term memories

### Per-Agent Identity

When multiple agents share a single OpenClaw gateway, each agent gets its own SpiceDB identity. Tools and lifecycle hooks derive the subject from the runtime `agentId` — so `agent:stenographer` and `agent:main` write memories with distinct `shared_by` relationships, even though they run through the same plugin instance.

If `agentId` is not available in the runtime context (e.g., older OpenClaw versions or standalone CLI use), the plugin falls back to the config-level `subjectType`/`subjectId`.

Session state (session IDs and SpiceDB consistency tokens) is also tracked per agent, so agents don't interfere with each other's sessions.

### Identity Linking

The `identities` config field connects agents to the people they represent. This is essential for **cross-agent recall** — finding memories stored by one agent that involve a person represented by a different agent.

```json
{
  "identities": {
    "main": "U0123ABC",
    "work": "U0456DEF"
  }
}
```

Each entry maps an agent ID to a person ID (typically a Slack user ID or other external identifier). At plugin startup, the plugin writes `agent:<agentId> #owner person:<personId>` relationships to SpiceDB.

**How cross-agent recall works:**

1. Agent A stores a memory with `involves: ["U0123ABC"]`
2. Later, agent B (configured as `"main": "U0123ABC"`) calls `memory_recall`
3. The plugin resolves `agent:main` → `person:U0123ABC` via SpiceDB
4. It discovers the memory because `person:U0123ABC` is in `involves`
5. The memory is returned alongside group-based results

This means a user's personal agent can discover memories stored by service agents (like a meeting recorder or Slack observer), as long as the user was a participant. The service agent retains `shared_by` ownership (and exclusive delete permission), while involved people get view access through their own agents.

Agents without an `identities` entry (like service agents) are not linked to any person and cannot be resolved through identity chains. This is intentional — a service agent acts on its own behalf, not on behalf of a human.

## Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `backend` | string | `graphiti` | Primary backend for tools and SpiceDB-authorized operations |
| `liminal` | string | *(same as backend)* | Liminal backend for auto-recall/capture hooks. Set to `"evermemos"` for hybrid mode |
| `spicedb.endpoint` | string | `localhost:50051` | SpiceDB gRPC endpoint |
| `spicedb.token` | string | *required* | SpiceDB pre-shared key (supports `${ENV_VAR}`) |
| `spicedb.insecure` | boolean | `true` | Allow insecure gRPC (for localhost dev) |
| `graphiti.endpoint` | string | `http://localhost:8000` | Graphiti REST server URL |
| `graphiti.defaultGroupId` | string | `main` | Default group for memory storage |
| `graphiti.uuidPollIntervalMs` | integer | `3000` | Polling interval for resolving episode UUIDs (ms) |
| `graphiti.uuidPollMaxAttempts` | integer | `60` | Max polling attempts (total timeout = interval x attempts) |
| `graphiti.requestTimeoutMs` | integer | `30000` | HTTP request timeout for Graphiti REST calls (ms) |
| `subjectType` | string | `agent` | SpiceDB subject type (`agent` or `person`) |
| `subjectId` | string | `default` | Fallback SpiceDB subject ID when agentId is unavailable (supports `${ENV_VAR}`) |
| `identities` | object | `{}` | Maps agent IDs to owner person IDs for cross-agent recall (see [Identity Linking](#identity-linking)) |
| `autoCapture` | boolean | `true` | Auto-capture conversations |
| `autoRecall` | boolean | `true` | Auto-inject relevant memories |
| `sessionFilter.excludePatterns` | string[] | `[]` | Skip auto-capture/recall for sessions matching any pattern |
| `sessionFilter.includePatterns` | string[] | `[]` | Only auto-capture/recall sessions matching at least one pattern |
| `customInstructions` | string | *(see below)* | Custom extraction instructions |
| `maxCaptureMessages` | integer | `10` | Max messages per auto-capture batch (1-50) |

### Default Custom Instructions

When not overridden, the plugin uses these extraction instructions:

```
Extract key facts about:
- Identity: names, roles, titles, contact info
- Preferences: likes, dislikes, preferred tools/methods
- Goals: objectives, plans, deadlines
- Relationships: connections between people, teams, organizations
- Decisions: choices made, reasoning, outcomes
- Routines: habits, schedules, recurring patterns
Do not extract: greetings, filler, meta-commentary about the conversation itself.
```

### Environment Variable Interpolation

String values in the config support `${ENV_VAR}` syntax:

```json
{
  "spicedb": {
    "token": "${SPICEDB_TOKEN}"
  },
  "subjectId": "${OPENCLAW_AGENT_ID}"
}
```

## CLI Commands

All commands are under `rebac-mem`:

| Command | Description |
|---------|-------------|
| `rebac-mem search <query>` | Search memories with authorization (includes owner-aware recall). Options: `--limit`, `--as` |
| `rebac-mem status` | Check SpiceDB + backend connectivity, show subject and identity links |
| `rebac-mem schema-write` | Write/update the SpiceDB authorization schema |
| `rebac-mem groups` | List authorized groups for a subject. Options: `--as` |
| `rebac-mem add-member <group-id> <subject-id>` | Add a subject to a group. Options: `--type` |
| `rebac-mem identities` | List configured identity links and verify them in SpiceDB |
| `rebac-mem link-identity <agent-id> <person-id>` | Write an agent→owner relationship to SpiceDB |
| `rebac-mem unlink-identity <agent-id>` | Remove an agent→owner relationship from SpiceDB |
| `rebac-mem import` | Import workspace markdown files. Options: `--workspace`, `--include-sessions`, `--group`, `--dry-run` |

The `--as` flag accepts `"type:id"` (e.g., `"agent:main"`, `"person:U0123ABC"`) or a bare `"id"` (defaults to agent type). Use it to query as a different subject without changing config.

Backend-specific commands (Graphiti):

| Command | Description |
|---------|-------------|
| `rebac-mem episodes` | List recent episodes. Options: `--last`, `--group` |
| `rebac-mem fact <uuid>` | Show details of a specific fact (entity edge) |
| `rebac-mem clear-graph <group-id>` | Delete all data in a group |

### Standalone CLI

For development and testing, commands can be run directly without a full OpenClaw gateway:

```bash
# Via npm script
npm run cli -- status
npm run cli -- search "some query"
npm run cli -- import --workspace /path/to/files --dry-run

# Via npx
npx tsx bin/rebac-mem.ts status
```

**Configuration** is loaded from (highest priority first):

1. **Environment variables** — `SPICEDB_TOKEN`, `SPICEDB_ENDPOINT`, `GRAPHITI_ENDPOINT`, etc.
2. **JSON config file** — `--config <path>`, or auto-discovered from `./rebac-mem.config.json` or `~/.config/rebac-mem/config.json`
3. **Built-in defaults** (see [Configuration Reference](#configuration-reference))

| Environment Variable | Config Equivalent |
|---------------------|-------------------|
| `SPICEDB_TOKEN` | `spicedb.token` |
| `SPICEDB_ENDPOINT` | `spicedb.endpoint` |
| `GRAPHITI_ENDPOINT` | `graphiti.endpoint` |
| `REBAC_MEM_DEFAULT_GROUP_ID` | `graphiti.defaultGroupId` |
| `REBAC_MEM_SUBJECT_TYPE` | `subjectType` |
| `REBAC_MEM_SUBJECT_ID` | `subjectId` |
| `REBAC_MEM_BACKEND` | `backend` |

## OpenClaw Integration

### Selecting the Memory Slot

OpenClaw has an exclusive `memory` slot — only one memory plugin is active at a time:

**Unified mode** (Graphiti only):

```json
{
  "plugins": {
    "slots": { "memory": "openclaw-memory-rebac" },
    "entries": {
      "openclaw-memory-rebac": {
        "enabled": true,
        "config": {
          "backend": "graphiti",
          "spicedb": { "endpoint": "localhost:50051", "token": "dev_token", "insecure": true },
          "graphiti": { "endpoint": "http://localhost:8000", "defaultGroupId": "main" },
          "subjectType": "agent",
          "subjectId": "my-agent",
          "identities": { "my-agent": "U0123ABC" }
        }
      }
    }
  }
}
```

**Hybrid mode** (Graphiti + EverMemOS):

```json
{
  "plugins": {
    "slots": { "memory": "openclaw-memory-rebac" },
    "entries": {
      "openclaw-memory-rebac": {
        "enabled": true,
        "config": {
          "backend": "graphiti",
          "liminal": "evermemos",
          "spicedb": { "endpoint": "localhost:50051", "token": "dev_token", "insecure": true },
          "graphiti": { "endpoint": "http://localhost:8000", "defaultGroupId": "main" },
          "evermemos": { "endpoint": "http://localhost:1995" },
          "subjectType": "agent",
          "subjectId": "my-agent",
          "identities": { "my-agent": "U0123ABC" }
        }
      }
    }
  }
}
```

The plugin must be discoverable — either symlinked into `extensions/openclaw-memory-rebac` in the OpenClaw installation, or loaded via `plugins.load.paths`.

### Migrating from openclaw-memory-graphiti

openclaw-memory-rebac is the successor to openclaw-memory-graphiti. The key difference: authorization and storage are decoupled, and the backend is pluggable. To migrate:

1. Disable openclaw-memory-graphiti in `~/.openclaw/openclaw.json`
2. Enable openclaw-memory-rebac with the same SpiceDB and Graphiti endpoints
3. Existing memories in Graphiti are preserved — no data migration needed

The `import` command migrates workspace markdown files into the backend:

```bash
# Preview what will be imported
rebac-mem import --dry-run

# Import workspace files
rebac-mem import

# Also import session transcripts
rebac-mem import --include-sessions
```

## Docker Compose

The `docker/` directory contains modular Docker Compose stacks:

```bash
# Unified mode: Graphiti + SpiceDB
cd docker && docker compose -f docker-compose.graphiti.yml up -d

# Hybrid mode: add EverMemOS (shares SpiceDB with Graphiti stack)
cd docker && docker compose -f docker-compose.evermemos.yml up -d
```

Both stacks share the same SpiceDB sub-stack — same authorization schema, same permissions model.

### Graphiti Stack (`docker/graphiti/`)

| Service | Port | Description |
|---------|------|-------------|
| `neo4j` | 7687, 7474 | Graph database (Bolt protocol) + browser UI |
| `graphiti` | 8000 | Custom Graphiti FastAPI server (REST) |

The custom Docker image extends `zepai/graphiti:latest` with:
- **`OpenClawGraphiti`** — subclass of base `Graphiti` (bypasses `ZepGraphiti` to properly forward embedder/cross_encoder)
- **`ExtendedSettings`** — per-component LLM, embedder, and reranker configuration
- **BGE reranker** — local sentence-transformers model (no API needed)
- **Runtime patches** — singleton client lifecycle, Neo4j attribute sanitization, resilient AsyncWorker, startup retry with backoff

### SpiceDB Stack (`docker/spicedb/`)

| Service | Port | Description |
|---------|------|-------------|
| `postgres` | 5432 | SpiceDB backing store (PostgreSQL 16) |
| `spicedb-migrate` | — | One-shot: runs SpiceDB DB migrations |
| `spicedb` | 50051, 8080 | Authorization engine (gRPC, HTTP health) |

### EverMemOS Stack (`docker/evermemos/`)

Single all-in-one container bundling all required services via supervisord:

| Component | Internal Port | Description |
|-----------|---------------|-------------|
| MongoDB 7.0 | 27017 | Document store |
| Elasticsearch 8 | 9200 | Keyword search |
| Milvus v2.5.2 | 19530 | Vector database (standalone with embedded etcd) |
| Redis 7 | 6379 | Cache |
| EverMemOS API | **1995 (exposed)** | FastAPI server (built from source) |

The image is built from the [EverMemOS](https://github.com/EverMind-AI/EverMemOS) repository, pinned to release tag `v1.1.0`. Update `EVERMEMOS_VERSION` in `docker/evermemos/docker-compose.yml` to upgrade. Requires ~4 GB RAM.

Requires API keys in `docker/evermemos/.env` for LLM, embedding (vectorize), and reranking services. See `.env.example` for all options.

### Running Stacks Independently

```bash
# Graphiti only
cd docker/graphiti && docker compose up -d

# EverMemOS only (without SpiceDB)
cd docker/evermemos && docker compose up -d

# SpiceDB only
cd docker/spicedb && docker compose up -d
```

## Development

### Running Tests

```bash
# Unit tests (no running services required)
npm test

# E2E tests (requires running infrastructure)
OPENCLAW_LIVE_TEST=1 npm run test:e2e
```

### Project Structure

```
├── index.ts                  # Plugin entry: tools, hooks, composite routing
├── backend.ts                # MemoryBackend interface
├── config.ts                 # Config schema, validation, backend + liminal factory
├── cli.ts                    # Shared CLI commands (plugin + standalone)
├── search.ts                 # Multi-group parallel search, dedup, formatting
├── authorization.ts          # Authorization logic (SpiceDB operations)
├── spicedb.ts                # SpiceDB gRPC client wrapper
├── schema.zed                # SpiceDB authorization schema
├── openclaw.plugin.json      # Plugin manifest
├── package.json
├── backends/
│   ├── graphiti.ts           # Graphiti REST backend implementation
│   ├── evermemos.ts          # EverMemOS REST backend implementation
│   └── registry.ts           # Static backend registry
├── bin/
│   └── rebac-mem.ts          # Standalone CLI entry point
├── docker/
│   ├── docker-compose.graphiti.yml   # Graphiti + SpiceDB
│   ├── docker-compose.evermemos.yml # EverMemOS + SpiceDB
│   ├── graphiti/
│   │   ├── docker-compose.yml
│   │   ├── Dockerfile        # Custom Graphiti image with patches
│   │   ├── config_overlay.py # ExtendedSettings (per-component config)
│   │   ├── graphiti_overlay.py # OpenClawGraphiti class
│   │   ├── startup.py        # Runtime patches and uvicorn launch
│   │   └── .env.example
│   ├── evermemos/
│   │   ├── docker-compose.yml # EverMemOS all-in-one container
│   │   ├── Dockerfile         # All-in-one: MongoDB+ES+Milvus+Redis+EverMemOS
│   │   ├── supervisord.conf   # Process manager config
│   │   └── .env.example       # LLM, vectorize, rerank API keys
│   └── spicedb/
│       └── docker-compose.yml
├── *.test.ts                 # Unit tests (186)
├── e2e.test.ts               # Graphiti E2E tests (14, live services)
├── e2e-backend.test.ts       # Backend-agnostic E2E contract (13)
├── e2e-evermemos.test.ts     # EverMemOS-specific E2E (7)
├── vitest.config.ts          # Unit test config
└── vitest.e2e.config.ts      # E2E test config
```

## License

MIT
