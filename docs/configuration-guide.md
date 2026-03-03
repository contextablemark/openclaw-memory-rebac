# Configuration Guide

This guide walks through setting up openclaw-memory-rebac with the Graphiti backend, from infrastructure to production-ready configuration.

## Quick Start

```bash
# 1. Start full infrastructure (Graphiti + SpiceDB)
cd docker
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

The `docker/docker-compose.yml` orchestrates the full stack via two sub-stacks:

**Graphiti stack** (`docker/graphiti/`):

| Service | Port | Purpose |
|---------|------|---------|
| **Neo4j** | 7687 | Graph database (Bolt protocol) |
| **Neo4j Browser** | 7474 | Browser-based graph explorer |
| **Graphiti** | 8000 | Custom FastAPI REST server |

**SpiceDB stack** (`docker/spicedb/`):

| Service | Port | Purpose |
|---------|------|---------|
| **PostgreSQL** | 5432 | SpiceDB backing store |
| **SpiceDB** | 50051 | Authorization engine (gRPC) |
| **SpiceDB** | 8080 | Health/metrics endpoint |

```bash
# Start everything
cd docker
docker compose up -d

# Or start stacks independently
cd docker/graphiti && docker compose up -d
cd docker/spicedb && docker compose up -d
```

SpiceDB migrations run automatically via the `spicedb-migrate` service.

### Environment Variables (Docker)

Create a `.env` file in `docker/graphiti/` to configure the Graphiti stack:

```bash
# LLM for Graphiti's entity extraction
OPENAI_API_KEY=none                                      # Required by base image; "none" for Ollama
OPENAI_BASE_URL=http://host.docker.internal:11434/v1     # LLM endpoint
MODEL_NAME=qwen2.5:14b                                   # LLM model

# Embeddings for Graphiti's vector search
EMBEDDING_BASE_URL=http://host.docker.internal:11434/v1  # Embedder endpoint
EMBEDDING_MODEL_NAME=nomic-embed-text                    # Embedding model
EMBEDDING_DIM=768                                        # Embedding dimensions

# Reranker (default: BGE local model, no API needed)
RERANKER_PROVIDER=bge                                    # "bge" (local) or "openai" (remote)

# Neo4j
NEO4J_URI=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=graphiti-password
```

The custom Docker image (`docker/graphiti/Dockerfile`) extends `zepai/graphiti:latest` with `ExtendedSettings` that reads these environment variables for per-component configuration. This is critical for local-model setups where the LLM, embedder, and reranker may all use different endpoints and models.

#### Using a Remote GPU Server

If your LLM and embeddings run on a remote GPU server (e.g., Ollama on a separate machine):

```bash
OPENAI_BASE_URL=http://192.168.1.100:11434/v1
EMBEDDING_BASE_URL=http://192.168.1.100:11434/v1
```

The Graphiti container uses `extra_hosts: host.docker.internal:host-gateway` by default, so `host.docker.internal` resolves to the Docker host. For remote servers, use the IP directly.

### Manual Setup

If you prefer to run services outside Docker:

1. **Neo4j**: `docker run -p 7687:7687 -p 7474:7474 neo4j:5.26.2` (pin to 5.26.2 — later versions cause IncompleteCommit errors)
2. **Graphiti**: Build the custom image from `docker/graphiti/Dockerfile`, or run the base `zepai/graphiti` image with the overlay files
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
| `endpoint` | string | `"http://localhost:8000"` | Graphiti REST server URL |
| `defaultGroupId` | string | `"main"` | Default group for memory storage |
| `uuidPollIntervalMs` | integer | `3000` | How often to poll for episode UUID (ms) |
| `uuidPollMaxAttempts` | integer | `60` | Max polls before giving up (timeout = interval x attempts) |
| `requestTimeoutMs` | integer | `30000` | HTTP request timeout for REST calls (ms) |

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

Graphiti's LLM and embedding configuration is set via Docker environment variables on the Graphiti container, not the plugin config. The plugin only controls the Graphiti endpoint URL.

Our custom Docker image uses `ExtendedSettings` to support per-component configuration:

| Variable | Purpose | Example |
|----------|---------|---------|
| `OPENAI_BASE_URL` | LLM endpoint | `http://gpu-server:11434/v1` |
| `MODEL_NAME` | LLM model | `qwen2.5:14b` |
| `EMBEDDING_BASE_URL` | Embedding endpoint (defaults to `OPENAI_BASE_URL`) | `http://gpu-server:11434/v1` |
| `EMBEDDING_MODEL_NAME` | Embedding model | `nomic-embed-text` |
| `EMBEDDING_DIM` | Embedding dimensions | `768` |
| `RERANKER_PROVIDER` | `bge` (local) or `openai` (remote) | `bge` |
| `RERANKER_MODEL` | Remote reranker model (ignored for BGE) | — |
| `RERANKER_BASE_URL` | Remote reranker endpoint (ignored for BGE) | — |

GPU-accelerated embeddings are strongly recommended. Graphiti runs ~300 embedding calls per episode — on CPU this can take 15+ minutes; on GPU it completes in under 60 seconds.

### UUID Polling

When Graphiti processes an episode, entity extraction is asynchronous. The plugin polls for the resulting episode UUID so it can register the memory fragment in SpiceDB.

- **`uuidPollIntervalMs`** (default: 3000) — polling interval in milliseconds
- **`uuidPollMaxAttempts`** (default: 60) — max polls before giving up

Total timeout = `interval × attempts` = 3000ms × 60 = **180 seconds** by default.

If your LLM is slow (CPU embeddings, large models), increase `uuidPollMaxAttempts`. If your LLM is fast (GPU, small models), you can decrease `uuidPollIntervalMs` for snappier SpiceDB registration.

### Neo4j

Neo4j runs on port 7687 (Bolt protocol). The Graphiti container connects via `NEO4J_URI=bolt://neo4j:7687` (inside Docker) or `bolt://localhost:7687` (outside Docker).

The Neo4j browser is available at `http://localhost:7474` for browsing the knowledge graph visually.

**Important**: Pin Neo4j to version `5.26.2`. Later versions cause `IncompleteCommit` errors during concurrent DDL operations.

### Custom Docker Image

The custom Graphiti image (`docker/graphiti/Dockerfile`) extends `zepai/graphiti:latest` with several runtime patches applied in `startup.py`. These patches address issues that surface when running Graphiti with local models (Ollama) rather than OpenAI:

| Patch | Problem | Fix |
|-------|---------|-----|
| **OpenClawGraphiti** | `ZepGraphiti.__init__` drops `embedder` and `cross_encoder` params | Subclass base `Graphiti` directly, forwarding all params |
| **Singleton client** | Upstream creates/closes a client per-request; background AsyncWorker outlives request scope | Process-lifetime singleton via `dependency_overrides` |
| **Startup retry** | Neo4j not ready when Graphiti starts | Exponential backoff retry for `build_indices_and_constraints()` |
| **Resilient AsyncWorker** | Upstream worker only catches `CancelledError`; any other exception kills it silently | Catch all exceptions, log, and continue processing |
| **Attribute sanitization** | Local LLMs return nested dicts/lists in entity attributes; Neo4j rejects non-primitive property values | Flatten to JSON strings before Neo4j write for both entity nodes and edges |
| **Safe extract_edges** | Local LLMs sometimes return `None` for node indices | Catch `TypeError`, log warning, return empty list |

These are runtime monkey-patches applied via `importlib` — they depend on upstream's internal module structure and may need updating when the base image changes.

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
2. Check Neo4j is healthy — Graphiti won't start without it
3. Check Graphiti logs: `docker compose logs graphiti`

### Slow episode processing (15+ minutes)

Graphiti runs ~300 LLM and embedding calls per episode. If processing is very slow:

1. **Check if embeddings are on CPU** — this is the most common cause
2. Move embeddings to GPU: set `EMBEDDING_BASE_URL` to a GPU-accelerated Ollama instance
3. Expected processing times with GPU: 20-60 seconds per episode

### UUID polling timeout

If you see "UUID poll max attempts exceeded":

1. The LLM may be too slow — check Graphiti logs for processing times
2. Increase `graphiti.uuidPollMaxAttempts` (e.g., 60 for a 3-minute timeout)
3. Or increase `graphiti.uuidPollIntervalMs` if you're overwhelming the server with polls

### Neo4j "Property values can only be of primitive types"

If you see `GqlError` mentioning `MAP` or `LIST` types:

1. This means the attribute sanitization patch isn't running — likely a Docker image issue
2. Rebuild the custom image: `cd docker/graphiti && docker compose build --no-cache`
3. Restart with: `docker compose up -d --force-recreate`

The custom startup.py flattens nested LLM-extracted attributes to JSON strings before they reach Neo4j. This is necessary because local LLMs (unlike OpenAI) sometimes return nested objects in entity/edge attributes.

### Auto-recall returns no memories

1. Verify the subject has group membership: `rebac-mem groups`
2. Check that memories exist: `rebac-mem search "test" --limit 5`
3. Ensure the SpiceDB schema is written: `rebac-mem schema-write`
4. Check that `autoRecall` is `true` in the plugin config
