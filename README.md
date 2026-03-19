# @contextableai/openclaw-memory-rebac

Two-layer memory plugin for OpenClaw: **SpiceDB** for authorization, **pluggable backends** for knowledge storage.

Agents remember conversations as structured knowledge. SpiceDB enforces who can read and write which memories — authorization lives at the data layer, not in prompts. The backend is swappable: start with Graphiti's knowledge graph today, add new storage engines tomorrow.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                    OpenClaw Agent                 │
│                                                  │
│  memory_recall ──► SpiceDB ──► Backend Search    │
│  memory_store  ──► SpiceDB ──► Backend Write     │
│  memory_forget ──► SpiceDB ──► Backend Delete    │
│  auto-recall   ──► SpiceDB ──► Backend Search    │
│  auto-capture  ──► SpiceDB ──► Backend Write     │
└──────────────────────────────────────────────────┘
         │                           │
    ┌────▼────┐                ┌─────▼─────┐
    │ SpiceDB │                │  Backend   │
    │ (authz) │                │ (storage)  │
    └─────────┘                └───────────┘
```

**SpiceDB** determines which `group_id`s a subject (agent or person) can access. The **backend** stores and searches memories scoped to those groups. Authorization is enforced before any read or write reaches the backend.

### Why Two Layers?

Most memory systems bundle authorization with storage — you get dataset isolation, but it's tied to the storage engine's auth model. That creates conflicts when you need external authorization (like SpiceDB) or want to swap backends without re-implementing access control.

openclaw-memory-rebac separates these concerns:
- **SpiceDB** owns the authorization model (relationships, permissions, consistency)
- **Backends** own the storage model (indexing, search, extraction)
- The plugin orchestrates both — authorization check first, then backend operation

This means you can change your storage engine without touching authorization, and vice versa.

## Backends

### Graphiti (default)

[Graphiti](https://github.com/getzep/graphiti) builds a knowledge graph from conversations. It extracts entities, facts, and relationships, storing them in Neo4j for structured retrieval.

- **Storage**: Neo4j graph database
- **Transport**: Direct REST API to Graphiti FastAPI server
- **Extraction**: LLM-powered entity and relationship extraction (~300 embedding calls per episode)
- **Search**: Dual-mode — searches both nodes (entities) and facts (relationships) in parallel
- **Docker image**: Custom image (`docker/graphiti/`) with per-component LLM/embedder/reranker configuration, BGE reranker support, and runtime patches for local-model compatibility
- **Best for**: Rich entity-relationship extraction, structured knowledge

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
- A running LLM endpoint (Graphiti uses an LLM for entity extraction and embeddings)

### 1. Start Infrastructure

```bash
cd docker
cp graphiti/.env.example graphiti/.env
# Edit graphiti/.env — set your LLM endpoint and API key
docker compose up -d
```

This starts the full stack:
- **Neo4j** on port 7687 (graph database, browser on port 7474)
- **Graphiti** on port 8000 (FastAPI REST server)
- **PostgreSQL** on port 5432 (persistent datastore for SpiceDB)
- **SpiceDB** on port 50051 (authorization engine)

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

The plugin registers four tools available to the agent:

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

## Automatic Behaviors

### Auto-Recall

When enabled (default: `true`), the plugin searches relevant memories before each agent turn and injects them into the conversation context as `<relevant-memories>` blocks.

- Searches up to 5 long-term memories and 3 session memories per turn
- Deduplicates session results against long-term results
- Only triggers when the user prompt is at least 5 characters

### Auto-Capture

When enabled (default: `true`), the plugin captures the last N messages from each completed agent turn and stores them as a batch episode.

- Captures up to `maxCaptureMessages` messages (default: 10)
- Stores to the current session group by default
- Skips messages shorter than 5 characters and injected context blocks
- Uses custom extraction instructions for entity/fact extraction

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
| `backend` | string | `graphiti` | Storage backend (`graphiti`) |
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

```json
{
  "plugins": {
    "slots": {
      "memory": "openclaw-memory-rebac"
    },
    "entries": {
      "openclaw-memory-rebac": {
        "enabled": true,
        "config": {
          "backend": "graphiti",
          "spicedb": {
            "endpoint": "localhost:50051",
            "token": "dev_token",
            "insecure": true
          },
          "graphiti": {
            "endpoint": "http://localhost:8000",
            "defaultGroupId": "main"
          },
          "subjectType": "agent",
          "subjectId": "my-agent",
          "identities": {
            "my-agent": "U0123ABC"
          },
          "autoCapture": true,
          "autoRecall": true
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

The `docker/` directory contains a modular Docker Compose stack. The top-level `docker/docker-compose.yml` includes both sub-stacks:

```bash
# Start the full stack (Graphiti + SpiceDB)
cd docker
docker compose up -d
```

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

### Running Stacks Independently

```bash
# Graphiti only
cd docker/graphiti && docker compose up -d

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
├── index.ts                  # Plugin entry: tools, hooks, CLI, service
├── backend.ts                # MemoryBackend interface (all backends implement this)
├── config.ts                 # Config schema, validation, backend factory
├── cli.ts                    # Shared CLI commands (plugin + standalone)
├── search.ts                 # Multi-group parallel search, dedup, formatting
├── authorization.ts          # Authorization logic (SpiceDB operations)
├── spicedb.ts                # SpiceDB gRPC client wrapper
├── schema.zed                # SpiceDB authorization schema
├── openclaw.plugin.json      # Plugin manifest
├── package.json
├── backends/
│   └── graphiti.ts           # Graphiti REST backend implementation
├── bin/
│   └── rebac-mem.ts          # Standalone CLI entry point
├── docker/
│   ├── docker-compose.yml    # Combined stack (includes both sub-stacks)
│   ├── graphiti/
│   │   ├── docker-compose.yml
│   │   ├── Dockerfile        # Custom Graphiti image with patches
│   │   ├── config_overlay.py # ExtendedSettings (per-component config)
│   │   ├── graphiti_overlay.py # OpenClawGraphiti class
│   │   ├── startup.py        # Runtime patches and uvicorn launch
│   │   └── .env.example
│   └── spicedb/
│       └── docker-compose.yml
├── *.test.ts                 # Unit tests (96)
├── e2e.test.ts               # End-to-end tests (15, live services)
├── vitest.config.ts          # Unit test config
└── vitest.e2e.config.ts      # E2E test config
```

## License

MIT
