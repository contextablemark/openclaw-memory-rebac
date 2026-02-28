# Configuration Guide

This guide walks through setting up openclaw-memory-rebac with the Graphiti backend, from infrastructure to production-ready configuration.

## Quick Start

```bash
# 1. Start infrastructure
cd docker/graphiti
docker compose up -d

# 2. Verify services are healthy
docker compose ps

# 3. Write the SpiceDB authorization schema
npm run cli -- schema-write

# 4. Check connectivity
npm run cli -- status
```

Then add the plugin to your OpenClaw config (`~/.openclaw/openclaw.json`) and restart the gateway.

## Infrastructure

### Docker Compose (Recommended)

The `docker/graphiti/docker-compose.yml` starts all required services:

| Service | Port | Purpose |
|---------|------|---------|
| **FalkorDB** | 6379 | Graph database for Graphiti (Redis-compatible) |
| **FalkorDB UI** | 3000 | Browser-based graph explorer |
| **Graphiti MCP** | 8000 | Knowledge graph API (HTTP + SSE) |
| **PostgreSQL** | 5432 | SpiceDB backing store |
| **SpiceDB** | 50051 | Authorization engine (gRPC) |
| **SpiceDB** | 8080 | Health/metrics endpoint |

```bash
cd docker/graphiti
docker compose up -d
```

SpiceDB migrations run automatically via the `spicedb-migrate` service.

### Environment Variables (Docker)

Create a `.env` file in `docker/graphiti/` to configure the stack:

```bash
# SpiceDB pre-shared key (used by both SpiceDB and the plugin)
SPICEDB_PRESHARED_KEY=dev_token

# LLM for Graphiti's entity extraction
# Default: host.docker.internal:11434 (local Ollama)
GRAPHITI_LLM_BASE_URL=http://host.docker.internal:11434/v1
GRAPHITI_LLM_MODEL=qwen2.5:14b

# Embeddings for Graphiti's vector search
GRAPHITI_EMBEDDER_BASE_URL=http://host.docker.internal:11434/v1
GRAPHITI_EMBEDDER_MODEL=nomic-embed-text

# OpenAI API key (required by Graphiti image, but can be "none" if using Ollama)
OPENAI_API_KEY=none
```

#### Using a Remote GPU Server

If your LLM and embeddings run on a remote GPU server (e.g., Ollama on a separate machine):

```bash
GRAPHITI_LLM_BASE_URL=http://192.168.1.100:11434/v1
GRAPHITI_EMBEDDER_BASE_URL=http://192.168.1.100:11434/v1
```

The Graphiti container uses `extra_hosts: host.docker.internal:host-gateway` by default, so `host.docker.internal` resolves to the Docker host. For remote servers, use the IP directly.

### Manual Setup

If you prefer to run services outside Docker:

1. **FalkorDB**: `docker run -p 6379:6379 falkordb/falkordb:latest`
2. **Graphiti**: See [Graphiti docs](https://github.com/getzep/graphiti) — set `NEO4J_URI=bolt://localhost:6379`
3. **PostgreSQL**: Any PostgreSQL 14+ instance
4. **SpiceDB**: See [SpiceDB docs](https://authzed.com/docs/spicedb/getting-started)

## Plugin Configuration

### OpenClaw Config (`~/.openclaw/openclaw.json`)

Add the plugin to your OpenClaw configuration:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/path/to/openclaw-memory-rebac"
      ]
    },
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

### Config Reference

#### Top-Level

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `backend` | `"graphiti"` | `"graphiti"` | Storage backend |
| `subjectType` | `"agent"` \| `"person"` | `"agent"` | SpiceDB subject type for the current user |
| `subjectId` | string | `"default"` | SpiceDB subject ID (supports `${ENV_VAR}`) |
| `autoCapture` | boolean | `true` | Capture conversations after each agent turn |
| `autoRecall` | boolean | `true` | Inject memories before each agent turn |
| `customInstructions` | string | *(see below)* | Extraction instructions sent to the LLM |
| `maxCaptureMessages` | integer | `10` | Max messages per auto-capture batch (1-50) |

#### SpiceDB (`spicedb.*`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `endpoint` | string | `"localhost:50051"` | gRPC endpoint (host:port) |
| `token` | string | *required* | Pre-shared key (supports `${ENV_VAR}`) |
| `insecure` | boolean | `true` | Allow plaintext gRPC (disable for production TLS) |

#### Graphiti (`graphiti.*`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `endpoint` | string | `"http://localhost:8000"` | Graphiti MCP server URL |
| `defaultGroupId` | string | `"main"` | Default group for memory storage |
| `uuidPollIntervalMs` | integer | `3000` | How often to poll for episode UUID (ms) |
| `uuidPollMaxAttempts` | integer | `30` | Max polls before giving up (timeout = interval x attempts) |

### Default Extraction Instructions

When `customInstructions` is not set, the plugin sends these instructions to Graphiti for entity/fact extraction:

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

Override this to tune extraction for your domain. For example, a medical assistant might use:

```json
{
  "customInstructions": "Extract: patient symptoms, diagnoses, medications, allergies, procedures, provider names, appointment dates. Do not extract: greetings, small talk."
}
```

### Environment Variable Interpolation

String config values support `${VAR_NAME}` syntax. The variable must be set in the process environment — unset variables cause a startup error.

```json
{
  "spicedb": {
    "token": "${SPICEDB_TOKEN}"
  },
  "subjectId": "${OPENCLAW_AGENT_ID}"
}
```

## SpiceDB Setup

### Authorization Schema

The plugin uses a SpiceDB schema with four object types. Write it on first setup:

```bash
# Via OpenClaw CLI
openclaw rebac-mem schema-write

# Or standalone
npm run cli -- schema-write
```

The schema defines:

```zed
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

The plugin auto-writes this schema on startup if it detects it hasn't been written yet.

### Group Membership

The plugin auto-creates membership for the configured `subjectId` in the `defaultGroupId` on startup. To add more members:

```bash
# Add an agent to a group
rebac-mem add-member research-team my-agent --type agent

# Add a person to a group
rebac-mem add-member family mom --type person

# List groups the current subject can access
rebac-mem groups
```

### Token Security

For development, `dev_token` is fine. For production:

1. Generate a strong pre-shared key
2. Store it in an environment variable (not in config files)
3. Reference it via interpolation:

```json
{
  "spicedb": {
    "token": "${SPICEDB_TOKEN}"
  }
}
```

4. Set `insecure: false` and configure TLS on SpiceDB

## Graphiti Tuning

### LLM and Embedding Configuration

Graphiti's LLM and embedding configuration is set via the Docker Compose environment, not the plugin config. The plugin only controls the Graphiti endpoint URL.

**Graphiti MCP server** reads its own config from environment variables or its `config.yaml`:

| Variable | Purpose | Example |
|----------|---------|---------|
| `GRAPHITI_LLM_BASE_URL` | LLM endpoint | `http://gpu-server:11434/v1` |
| `GRAPHITI_LLM_MODEL` | LLM model | `qwen2.5:14b` |
| `GRAPHITI_EMBEDDER_BASE_URL` | Embedding endpoint | `http://gpu-server:11434/v1` |
| `GRAPHITI_EMBEDDER_MODEL` | Embedding model | `nomic-embed-text` |

GPU-accelerated embeddings are strongly recommended. Graphiti runs ~300 embedding calls per episode — on CPU this can take 15+ minutes; on GPU it completes in under 60 seconds. See [The Graphiti Redemption](graphiti-gpu-redemption.md) for benchmarks.

### UUID Polling

When Graphiti processes an episode, entity extraction is asynchronous. The plugin polls for the resulting episode UUID so it can register the memory fragment in SpiceDB.

- **`uuidPollIntervalMs`** (default: 3000) — polling interval in milliseconds
- **`uuidPollMaxAttempts`** (default: 30) — max polls before giving up

Total timeout = `interval × attempts` = 3000ms × 30 = **90 seconds** by default.

If your LLM is slow (CPU embeddings, large models), increase `uuidPollMaxAttempts`. If your LLM is fast (GPU, small models), you can decrease `uuidPollIntervalMs` for snappier SpiceDB registration.

### FalkorDB

FalkorDB uses the Redis protocol on port 6379. The Graphiti MCP server connects to it via `NEO4J_URI=bolt://falkordb:6379` (inside Docker) or `bolt://localhost:6379` (outside Docker).

The web UI is available at `http://localhost:3000` for browsing the knowledge graph visually.

## Standalone CLI

For development and testing without an OpenClaw gateway:

```bash
# Check connectivity
npm run cli -- status

# Search memories
npm run cli -- search "project deadlines" --limit 5

# List groups
npm run cli -- groups

# Import workspace files
npm run cli -- import --workspace /path/to/files --dry-run
```

### CLI Config Resolution

The standalone CLI reads configuration from (highest priority first):

1. **Environment variables**
2. **JSON config file** — `--config <path>`, or auto-discovered from:
   - `./rebac-mem.config.json` (current directory)
   - `~/.config/rebac-mem/config.json` (user config)
3. **Built-in defaults**

Example `rebac-mem.config.json`:

```json
{
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
  "subjectId": "test-agent"
}
```

### CLI Environment Variables

| Variable | Config Equivalent | Default |
|----------|-------------------|---------|
| `SPICEDB_TOKEN` | `spicedb.token` | — |
| `SPICEDB_ENDPOINT` | `spicedb.endpoint` | `localhost:50051` |
| `GRAPHITI_ENDPOINT` | `graphiti.endpoint` | `http://localhost:8000` |
| `REBAC_MEM_DEFAULT_GROUP_ID` | `graphiti.defaultGroupId` | `main` |
| `REBAC_MEM_SUBJECT_TYPE` | `subjectType` | `agent` |
| `REBAC_MEM_SUBJECT_ID` | `subjectId` | `default` |
| `REBAC_MEM_BACKEND` | `backend` | `graphiti` |

## Troubleshooting

### "spicedb.token is not configured"

The plugin requires a SpiceDB pre-shared key. Add it to your config:

```json
{
  "spicedb": {
    "token": "dev_token"
  }
}
```

Or via environment variable: `SPICEDB_TOKEN=dev_token`

### SpiceDB connection refused

1. Verify SpiceDB is running: `docker compose ps` should show `spicedb` as healthy
2. Check the endpoint matches: default is `localhost:50051`
3. If SpiceDB is inside Docker and the plugin is outside, use `localhost:50051`
4. If both are inside Docker, use `spicedb:50051`

### Graphiti connection refused

1. Verify Graphiti is running: `curl http://localhost:8000/health`
2. Check FalkorDB is healthy — Graphiti won't start without it
3. Check Graphiti logs: `docker compose logs graphiti`

### Slow episode processing (15+ minutes)

Graphiti runs ~300 LLM and embedding calls per episode. If processing is very slow:

1. **Check if embeddings are on CPU** — this is the most common cause
2. Move embeddings to GPU: set `GRAPHITI_EMBEDDER_BASE_URL` to a GPU-accelerated Ollama instance
3. Expected processing times with GPU: 20-60 seconds per episode

### UUID polling timeout

If you see "UUID poll max attempts exceeded":

1. The LLM may be too slow — check Graphiti logs for processing times
2. Increase `graphiti.uuidPollMaxAttempts` (e.g., 60 for a 3-minute timeout)
3. Or increase `graphiti.uuidPollIntervalMs` if you're overwhelming the server with polls

### Auto-recall returns no memories

1. Verify the subject has group membership: `rebac-mem groups`
2. Check that memories exist: `rebac-mem search "test" --limit 5`
3. Ensure the SpiceDB schema is written: `rebac-mem schema-write`
4. Check that `autoRecall` is `true` in the plugin config
