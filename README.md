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

[Graphiti](https://github.com/getzep/graphiti) builds a knowledge graph from conversations. It extracts entities, facts, and relationships, storing them in a graph database (FalkorDB) for structured retrieval.

- **Storage**: FalkorDB (Redis-compatible graph database)
- **Extraction**: LLM-powered entity and relationship extraction (~300 embedding calls per episode)
- **Search**: Dual-mode — searches both nodes (entities) and facts (relationships) in parallel
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
cd docker/graphiti
cp .env.example .env
# Edit .env — set your LLM endpoint and API key
docker compose up -d
```

This starts:
- **FalkorDB** on port 6379 (graph database, web UI on port 3000)
- **Graphiti MCP Server** on port 8000 (knowledge graph API)
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
definition person {}

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

    permission view = involves + shared_by + source_group->access
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

## Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `backend` | string | `graphiti` | Storage backend (`graphiti`) |
| `spicedb.endpoint` | string | `localhost:50051` | SpiceDB gRPC endpoint |
| `spicedb.token` | string | *required* | SpiceDB pre-shared key (supports `${ENV_VAR}`) |
| `spicedb.insecure` | boolean | `true` | Allow insecure gRPC (for localhost dev) |
| `graphiti.endpoint` | string | `http://localhost:8000` | Graphiti MCP server URL |
| `graphiti.defaultGroupId` | string | `main` | Default group for memory storage |
| `graphiti.uuidPollIntervalMs` | integer | `3000` | Polling interval for resolving episode UUIDs (ms) |
| `graphiti.uuidPollMaxAttempts` | integer | `30` | Max polling attempts (total timeout = interval x attempts) |
| `subjectType` | string | `agent` | SpiceDB subject type (`agent` or `person`) |
| `subjectId` | string | `default` | SpiceDB subject ID (supports `${ENV_VAR}`) |
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
| `rebac-mem search <query>` | Search memories with authorization. Options: `--limit`, `--scope` |
| `rebac-mem status` | Check SpiceDB + backend connectivity |
| `rebac-mem schema-write` | Write/update the SpiceDB authorization schema |
| `rebac-mem groups` | List authorized groups for the current subject |
| `rebac-mem add-member <group-id> <subject-id>` | Add a subject to a group. Options: `--type` |
| `rebac-mem import` | Import workspace markdown files. Options: `--workspace`, `--include-sessions`, `--group`, `--dry-run` |

Backend-specific commands (Graphiti):

| Command | Description |
|---------|-------------|
| `rebac-mem episodes` | List recent episodes. Options: `--last`, `--group` |

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

The `docker/graphiti/` directory contains a full-stack Docker Compose configuration:

| Service | Port | Description |
|---------|------|-------------|
| `falkordb` | 6379, 3000 | Graph database (Redis protocol) + web UI |
| `graphiti-mcp` | 8000 | Graphiti MCP server (HTTP/SSE) |
| `postgres` | 5432 | Persistent datastore for SpiceDB |
| `spicedb-migrate` | — | One-shot: runs SpiceDB DB migrations |
| `spicedb` | 50051, 8443, 9090 | Authorization engine (gRPC, HTTP, metrics) |

```bash
# Start infrastructure
cd docker/graphiti
docker compose up -d
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
│   └── graphiti.ts           # Graphiti MCP backend implementation
├── bin/
│   └── rebac-mem.ts          # Standalone CLI entry point
├── docker/
│   └── graphiti/
│       ├── docker-compose.yml
│       └── .env.example
├── *.test.ts                 # Unit tests
├── e2e.test.ts               # End-to-end tests (live services)
├── vitest.config.ts          # Unit test config
└── vitest.e2e.config.ts      # E2E test config
```

## License

MIT
