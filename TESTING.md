# Testing Guide

## Quick Start

```bash
# Unit tests (no services required)
npm test

# E2E tests (requires live services)
cd docker && docker compose up -d
OPENCLAW_LIVE_TEST=1 npm run test:e2e
```

## Test Suites

### Unit Tests (`npm test`)

96 tests, no external services required. All dependencies mocked.

- **search.test.ts** (22 tests) — Backend-agnostic search orchestration
- **config.test.ts** (20 tests) — Config parsing and backend factory
- **backends/graphiti.test.ts** (15 tests) — GraphitiBackend with mocked REST API
- **cli.test.ts** (17 tests) — All CLI commands
- **index.test.ts** (19 tests) — Plugin registration and tools
- **authorization.test.ts** (3 tests) — Type signatures

### E2E Tests (`npm run test:e2e`)

15 tests, requires live services. Set `OPENCLAW_LIVE_TEST=1` to enable.

- **e2e.test.ts** — Full lifecycle integration:
  - SpiceDB schema write and authorization enforcement
  - Memory store → authorize → search → forget lifecycle
  - Group membership and unauthorized access blocking
  - Simple 2-turn conversation extraction
  - Complex multi-entity professional relationships
  - Temporal references and work artifacts
  - Multi-turn technical conversation extraction
  - Backend-specific features (deleteFragment)

E2E tests have 600-second (10-minute) timeouts to accommodate Ollama/local model processing times.

## Running Live Tests

### 1. Start Backend Services

```bash
# Full stack (Graphiti + SpiceDB)
cd docker
docker compose up -d

# Wait for services to be ready
docker compose ps
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` if needed (defaults work for docker-compose stack):

```bash
OPENCLAW_LIVE_TEST=1
REBAC_MEM_BACKEND=graphiti
SPICEDB_TOKEN=dev_token
```

### 3. Run Tests

```bash
OPENCLAW_LIVE_TEST=1 npm run test:e2e
```

## Test Organization

### Backend-Agnostic Tests

Most functionality is backend-agnostic and tested via mocks:

- **Authorization logic** (authorization.test.ts) — Pure SpiceDB
- **Search orchestration** (search.test.ts) — Parallel group search
- **Config parsing** (config.test.ts) — All config variations
- **CLI commands** (cli.test.ts) — Command registration
- **Plugin registration** (index.test.ts) — Tool registration

### Backend-Specific Tests

Each backend implementation has its own test file with mocked dependencies:

- **backends/graphiti.test.ts** — Graphiti REST API client
  - Episode creation via POST /messages and UUID resolution via GET /episodes
  - Fact/entity search via POST /search
  - Group deletion, health checks, status

### E2E Tests

**e2e.test.ts** runs against live services:

1. Start with clean slate (SpiceDB schema write)
2. Store memories (backend + SpiceDB authorization)
3. Search with authorization (parallel group queries)
4. Test authorization boundaries (unauthorized access blocked)
5. Complex relationship extraction (multi-entity, temporal, multi-turn)
6. Forget memories (backend deletion + SpiceDB cleanup)

## Debugging

### View Backend Logs

```bash
# Graphiti
cd docker/graphiti && docker compose logs -f graphiti

# Neo4j
cd docker/graphiti && docker compose logs -f neo4j

# SpiceDB
cd docker/spicedb && docker compose logs -f spicedb
```

### Manual Testing

Use the CLI for manual backend testing:

```bash
# Configure via environment
export SPICEDB_TOKEN=dev_token
export GRAPHITI_ENDPOINT=http://localhost:8000

# Test commands
npm run cli -- status
npm run cli -- search "test query"
npm run cli -- groups
npm run cli -- episodes --last 5
```

### Clean Up

```bash
# Stop all services
cd docker && docker compose down

# Remove volumes (fresh start)
cd docker && docker compose down -v
```

## CI/CD Considerations

Unit tests run in CI without external dependencies.

E2E tests require:
- Docker compose (or Kubernetes for cloud CI)
- GPU support (optional but recommended for performance)
- Adequate timeout (10+ minutes per test suite with local models)

Example GitHub Actions:

```yaml
test:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
    - run: npm ci
    - run: npm test

e2e:
  runs-on: ubuntu-latest
  timeout-minutes: 20
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
    - run: npm ci
    - run: cd docker && docker compose up -d
    - run: OPENCLAW_LIVE_TEST=1 npm run test:e2e
    - run: cd docker && docker compose down
```
