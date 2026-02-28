# Testing Guide

## Quick Start

```bash
# Unit tests (no services required)
npm test

# E2E tests (requires live services)
cp .env.example .env
docker compose -f docker/graphiti/docker-compose.yml up -d
OPENCLAW_LIVE_TEST=1 npm run test:e2e
```

## Test Suites

### Unit Tests (`npm test`)

No external services required. All dependencies mocked.

- **search.test.ts** — Backend-agnostic search orchestration
- **config.test.ts** — Config parsing and backend factory
- **backends/graphiti.test.ts** — GraphitiBackend with mocked MCP
- **cli.test.ts** — All CLI commands
- **index.test.ts** — Plugin registration and tools
- **authorization.test.ts** — Type signatures

### E2E Tests (`npm run test:e2e`)

Requires live services. Set `OPENCLAW_LIVE_TEST=1` to enable.

- **e2e.test.ts** — Full lifecycle integration:
  - SpiceDB schema write
  - Memory store → authorize → search → forget
  - Authorization enforcement
  - Group membership
  - Backend-specific features

## Running Live Tests

### 1. Start Backend Services

**Graphiti backend:**
```bash
cd docker/graphiti
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
# For Graphiti backend
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

- **backends/graphiti.test.ts** — Graphiti MCP client
  - Episode creation and UUID resolution
  - Fact/entity search
  - Dataset management

### E2E Tests

**e2e.test.ts** runs against live services:

1. Start with clean slate (SpiceDB schema write)
2. Store memories (backend + SpiceDB authorization)
3. Search with authorization (parallel group queries)
4. Test authorization boundaries (unauthorized access blocked)
5. Forget memories (backend deletion + SpiceDB cleanup)

## Debugging

### View Backend Logs

```bash
# Graphiti
docker compose -f docker/graphiti/docker-compose.yml logs -f graphiti-server

# SpiceDB
docker compose -f docker/graphiti/docker-compose.yml logs -f spicedb
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
```

### Clean Up

```bash
# Stop services
docker compose -f docker/graphiti/docker-compose.yml down

# Remove volumes (fresh start)
docker compose -f docker/graphiti/docker-compose.yml down -v
```

## CI/CD Considerations

Unit tests run in CI without external dependencies.

E2E tests require:
- Docker compose (or Kubernetes for cloud CI)
- GPU support (optional but recommended for performance)
- Adequate timeout (2-3 minutes per test suite)

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
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
    - run: npm ci
    - run: docker compose -f docker/graphiti/docker-compose.yml up -d
    - run: OPENCLAW_LIVE_TEST=1 npm run test:e2e
    - run: docker compose -f docker/graphiti/docker-compose.yml down
```
