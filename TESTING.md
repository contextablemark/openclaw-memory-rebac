# Testing Guide

## Quick Start

```bash
# Unit tests (no services required)
npm test

# E2E tests — Graphiti backend (requires Graphiti + SpiceDB)
cd docker && docker compose -f docker-compose.graphiti.yml up -d
OPENCLAW_LIVE_TEST=1 npm run test:e2e

# E2E tests — EverMemOS backend (requires EverMemOS + SpiceDB)
cd docker/evermemos && cp .env.example .env   # configure API keys first
cd docker && docker compose -f docker-compose.evermemos.yml up -d
E2E_BACKEND=evermemos npm run test:e2e:backend
npm run test:e2e:evermemos
```

## Test Suites

### Unit Tests (`npm test`)

178 tests, no external services required. All dependencies mocked.

- **search.test.ts** (23 tests) — Backend-agnostic search orchestration
- **config.test.ts** (27 tests) — Config parsing and backend factory
- **backends/graphiti.test.ts** (19 tests) — GraphitiBackend with mocked REST API
- **backends/evermemos.test.ts** (25 tests) — EverMemOSBackend with mocked REST API
- **cli.test.ts** (27 tests) — All CLI commands
- **index.test.ts** (54 tests) — Plugin registration, tools, share/unshare
- **authorization.test.ts** (3 tests) — Type signatures

### E2E Tests

All E2E tests require live services and have 600-second timeouts.

| Suite | Script | Tests | Backend | Purpose |
|---|---|---|---|---|
| `e2e.test.ts` | `npm run test:e2e` | 14 | Graphiti | Extraction, CLI, stenographer, IS_DUPLICATE_OF |
| `e2e-backend.test.ts` | `npm run test:e2e:backend` | 13 | Any (via `E2E_BACKEND`) | Contract: health, lifecycle, auth, share/unshare |
| `e2e-evermemos.test.ts` | `npm run test:e2e:evermemos` | 7 | EverMemOS | fragmentId semantics, type mapping, anchor auth |

## Running Live Tests

### Graphiti Backend

```bash
# 1. Start services
cd docker
docker compose -f docker-compose.graphiti.yml up -d
docker compose -f docker-compose.graphiti.yml ps   # wait for all healthy

# 2. Run tests
OPENCLAW_LIVE_TEST=1 npm run test:e2e

# 3. (Optional) Run backend-agnostic suite against Graphiti
E2E_BACKEND=graphiti npm run test:e2e:backend
```

### EverMemOS Backend

EverMemOS requires LLM, embedding, and reranking API keys. The all-in-one Docker image bundles MongoDB, Elasticsearch, Milvus, Redis, and EverMemOS in a single container (~4 GB RAM).

```bash
# 1. Configure API keys
cd docker/evermemos
cp .env.example .env
# Edit .env — set LLM_API_KEY, VECTORIZE_API_KEY, RERANK_API_KEY

# 2. Start services (builds image on first run, ~5 min)
cd docker
docker compose -f docker-compose.evermemos.yml up -d

# Watch build progress:
docker compose -f docker-compose.evermemos.yml logs -f evermemos

# 3. Verify services are healthy (allow ~60s for internal services to start)
docker compose -f docker-compose.evermemos.yml ps

# 4. Run tests
E2E_BACKEND=evermemos npm run test:e2e:backend    # backend-agnostic contract
npm run test:e2e:evermemos                         # EverMemOS-specific tests
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENCLAW_LIVE_TEST` | — | Set to `1` to enable E2E tests |
| `E2E_BACKEND` | `graphiti` | Backend for `e2e-backend.test.ts` |
| `SPICEDB_ENDPOINT` | `localhost:50051` | SpiceDB gRPC endpoint |
| `SPICEDB_TOKEN` | `dev_token` | SpiceDB preshared key |
| `GRAPHITI_ENDPOINT` | `http://localhost:8000` | Graphiti REST endpoint |
| `EVERMEMOS_ENDPOINT` | `http://localhost:1995` | EverMemOS REST endpoint |

## Test Organization

### Backend-Agnostic Unit Tests

Most functionality is backend-agnostic and tested via mocks:

- **Authorization logic** (authorization.test.ts) — Pure SpiceDB
- **Search orchestration** (search.test.ts) — Parallel group search
- **Config parsing** (config.test.ts) — All config variations
- **CLI commands** (cli.test.ts) — Command registration
- **Plugin registration** (index.test.ts) — Tool registration, share/unshare

### Backend-Specific Unit Tests

Each backend has its own test file with mocked `global.fetch`:

- **backends/graphiti.test.ts** — Episode creation, UUID polling, fact search, deletion routing
- **backends/evermemos.test.ts** — Immediate fragmentId, memory type mapping, enrichSession, health proxy

### E2E Test Structure

**Backend-agnostic contract** (`e2e-backend.test.ts`):
Uses `backendRegistry` to instantiate whichever backend `E2E_BACKEND` specifies. Tests the `MemoryBackend` interface contract: health, store, search, authorization, share/unshare chain.

**Graphiti-specific** (`e2e.test.ts`):
Entity/fact extraction, IS_DUPLICATE_OF filtering, Graphiti CLI commands, stenographer features (per-agent identity, identity linking, owner-aware recall).

**EverMemOS-specific** (`e2e-evermemos.test.ts`):
Integration tests for our EverMemOS layer: fragmentId resolves immediately (no polling), discoverFragmentIds is undefined, SpiceDB auth on anchor IDs, memory type mapping + context prefixes, enrichSession API, memoryTypes config filtering.

## Debugging

### View Backend Logs

```bash
# Graphiti
cd docker/graphiti && docker compose logs -f graphiti

# Neo4j
cd docker/graphiti && docker compose logs -f neo4j

# EverMemOS (all-in-one — all service logs appear here)
cd docker/evermemos && docker compose logs -f evermemos

# SpiceDB
cd docker/spicedb && docker compose logs -f spicedb
```

### Manual Testing

Use the CLI for manual backend testing:

```bash
# Graphiti
export SPICEDB_TOKEN=dev_token
export GRAPHITI_ENDPOINT=http://localhost:8000
npm run cli -- status
npm run cli -- search "test query"
npm run cli -- episodes --last 5

# EverMemOS
export REBAC_MEM_BACKEND=evermemos
export EVERMEMOS_ENDPOINT=http://localhost:1995
npm run cli -- status
npm run cli -- search "test query"
npm run cli -- foresight --group main
```

### Clean Up

```bash
# Graphiti stack
cd docker && docker compose -f docker-compose.graphiti.yml down
cd docker && docker compose -f docker-compose.graphiti.yml down -v   # remove volumes

# EverMemOS stack
cd docker && docker compose -f docker-compose.evermemos.yml down
cd docker && docker compose -f docker-compose.evermemos.yml down -v
```

## CI/CD Considerations

Unit tests run in CI without external dependencies.

E2E tests require:
- Docker compose (or Kubernetes for cloud CI)
- GPU support (optional but recommended for performance)
- Adequate timeout (10+ minutes per test suite with local models)
- API keys for EverMemOS tests (LLM, vectorize, rerank)

Example GitHub Actions:

```yaml
test:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
    - run: npm ci
    - run: npm test

e2e-graphiti:
  runs-on: ubuntu-latest
  timeout-minutes: 20
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
    - run: npm ci
    - run: cd docker && docker compose -f docker-compose.graphiti.yml up -d
    - run: OPENCLAW_LIVE_TEST=1 npm run test:e2e
    - run: cd docker && docker compose -f docker-compose.graphiti.yml down

e2e-evermemos:
  runs-on: ubuntu-latest
  timeout-minutes: 20
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
    - run: npm ci
    - run: cd docker && docker compose -f docker-compose.evermemos.yml up -d
    - run: E2E_BACKEND=evermemos npm run test:e2e:backend
    - run: npm run test:e2e:evermemos
    - run: cd docker && docker compose -f docker-compose.evermemos.yml down
```
