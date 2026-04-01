"""
Custom startup that configures the Graphiti FastAPI server to use our
extended per-component embedder/reranker settings before launching uvicorn.

Uses FastAPI's app.dependency_overrides to replace get_graphiti —
the proper mechanism that works with Annotated[..., Depends()] captures.
"""

import asyncio
import importlib
import logging

from graph_service.config_overlay import ExtendedSettings
from graph_service.graphiti_overlay import create_graphiti

logger = logging.getLogger(__name__)

MAX_RETRIES = 5
RETRY_BASE_DELAY = 3  # seconds, doubles each retry


def patch():
    """
    Override graph_service modules so the app uses ExtendedSettings
    (with per-component embedder/reranker config) instead of the base
    Settings class.
    """
    settings = ExtendedSettings()

    # -- Patch Settings class on config module --
    # The @lru_cache get_settings() does `return Settings()`.
    # Replacing the class on the module + clearing cache makes it
    # return our ExtendedSettings (which has all base fields plus extras).
    config_mod = importlib.import_module("graph_service.config")
    config_mod.Settings = ExtendedSettings
    config_mod.get_settings.cache_clear()

    # -- Create the singleton client ONCE (loads BGE reranker weights) --
    # Used for both index initialization and per-request dependency injection.
    # Upstream get_graphiti creates/closes a client per-request, but POST
    # /messages queues background work via AsyncWorker that outlives the
    # request scope.  A process-lifetime singleton avoids "Driver closed" errors.
    singleton_client = create_graphiti(settings)

    # -- Patch initialize_graphiti on upstream modules --
    # main.py does `from graph_service.zep_graphiti import initialize_graphiti`
    # creating a local binding we must also replace.
    zep_mod = importlib.import_module("graph_service.zep_graphiti")

    async def patched_initialize_graphiti(s=None):
        """Initialize graph DB indices with retry for Neo4j readiness."""
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                await singleton_client.build_indices_and_constraints()
                logger.info("Graph indices built successfully (attempt %d)", attempt)
                return
            except Exception as e:
                logger.warning(
                    "build_indices_and_constraints failed (attempt %d/%d): %s",
                    attempt, MAX_RETRIES, e,
                )
                if attempt == MAX_RETRIES:
                    logger.error("All %d attempts failed, giving up", MAX_RETRIES)
                    raise
                delay = RETRY_BASE_DELAY * (2 ** (attempt - 1))
                logger.info("Retrying in %ds...", delay)
                await asyncio.sleep(delay)

    zep_mod.initialize_graphiti = patched_initialize_graphiti

    main_mod = importlib.import_module("graph_service.main")
    main_mod.initialize_graphiti = patched_initialize_graphiti

    # -- Override get_graphiti via FastAPI dependency_overrides --
    # This is the proper mechanism: app.dependency_overrides replaces
    # the function that Depends(get_graphiti) captured at import time.
    # We must import the app AFTER patching initialize_graphiti above
    # (the app's lifespan calls initialize_graphiti on startup).
    from graph_service.main import app

    original_get_graphiti = zep_mod.get_graphiti

    async def patched_get_graphiti(settings_dep=None):
        """Yield the long-lived Graphiti client."""
        yield singleton_client

    app.dependency_overrides[original_get_graphiti] = patched_get_graphiti

    # -- Endpoint: entity edges extracted from a specific episode --
    # graphiti-core stores an `episodes` list on each RELATES_TO relationship
    # tracking which episodes contributed to that fact.  This endpoint exposes
    # those UUIDs so the plugin can write per-fact SpiceDB relationships.
    @app.get("/episodes/{episode_uuid}/edges")
    async def get_episode_edges(episode_uuid: str):
        """Return entity edge UUIDs that reference a specific episode."""
        query = (
            "MATCH ()-[r:RELATES_TO]-() "
            "WHERE $episode_uuid IN r.episodes "
            "RETURN DISTINCT r.uuid AS uuid"
        )
        # Use the raw Neo4j async driver directly to avoid differences
        # in the Graphiti Neo4jDriver.execute_query() wrapper across versions.
        raw_driver = singleton_client.driver.client
        records, _, _ = await raw_driver.execute_query(
            query, parameters_={"episode_uuid": episode_uuid}
        )
        return [{"uuid": r["uuid"]} for r in records]

    # -- Fix upstream AsyncWorker crash-on-error bug --
    # The worker loop only catches CancelledError; any other exception from
    # add_episode() kills the worker silently and no more jobs are processed.
    ingest_mod = importlib.import_module("graph_service.routers.ingest")

    async def resilient_worker(self):
        """Worker loop with exception logging and recovery."""
        while True:
            try:
                job = await self.queue.get()
                logger.info("AsyncWorker processing job (queue size: %d)", self.queue.qsize())
                await job()
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("AsyncWorker job failed")

    ingest_mod.AsyncWorker.worker = resilient_worker

    # -- Fix Neo4j CypherTypeError for nested attribute maps --
    # graphiti-core does `entity_data.update(node.attributes or {})` for nodes
    # and `edge_data.update(edge.attributes or {})` for edges, merging raw
    # LLM-extracted attributes directly into Neo4j properties.
    # Some LLMs (e.g., qwen2.5 via Ollama) return nested dicts/lists for
    # attributes, which Neo4j rejects: "Property values can only be of
    # primitive types."  Sanitize both entity nodes AND entity edges.
    import json

    bulk_mod = importlib.import_module("graphiti_core.utils.bulk_utils")
    original_bulk_add = bulk_mod.add_nodes_and_edges_bulk

    # Reserved keys that must not be overwritten by LLM-extracted attributes.
    RESERVED_EDGE_KEYS = {
        'uuid', 'source_node_uuid', 'target_node_uuid', 'name',
        'fact', 'fact_embedding', 'group_id', 'episodes',
        'created_at', 'expired_at', 'valid_at', 'invalid_at',
    }
    RESERVED_NODE_KEYS = {
        'uuid', 'name', 'name_embedding', 'group_id', 'summary',
        'created_at', 'labels',
    }

    # Edge names that represent deduplication artifacts, not real semantic facts.
    RESERVED_EDGE_NAMES = {
        'IS_DUPLICATE_OF',
        'DUPLICATE_OF',
        'HAS_DUPLICATE',
        'DUPLICATES',
    }

    def _is_reserved_edge_name(name):
        """Check if an edge name is a deduplication artifact."""
        if not name:
            return False
        return name.strip().upper().replace(" ", "_") in RESERVED_EDGE_NAMES

    def _sanitize_attributes(attrs, reserved_keys):
        """Flatten non-primitive values and strip reserved keys to prevent clobber."""
        if not attrs:
            return attrs
        sanitized = {}
        for k, v in attrs.items():
            if k in reserved_keys:
                logger.debug("Stripped reserved key %r from attributes", k)
                continue
            if isinstance(v, (dict, list, set, tuple)):
                sanitized[k] = json.dumps(v, default=str)
            else:
                sanitized[k] = v
        return sanitized

    async def patched_bulk_add(driver, episodic_nodes, episodic_edges,
                                entity_nodes, entity_edges, embedder):
        for node in entity_nodes:
            if node.attributes:
                node.attributes = _sanitize_attributes(node.attributes, RESERVED_NODE_KEYS)
        for edge in entity_edges:
            if edge.attributes and 'fact_embedding' in edge.attributes:
                logger.warning(
                    "DIAG attributes_clobber: edge=%s has 'fact_embedding' in attributes! "
                    "value_type=%s (will be stripped)", edge.uuid,
                    type(edge.attributes.get('fact_embedding')),
                )
            if edge.attributes:
                edge.attributes = _sanitize_attributes(edge.attributes, RESERVED_EDGE_KEYS)
            # Diagnostic: log edges with missing/invalid embeddings
            emb = edge.fact_embedding
            emb_ok = isinstance(emb, list) and len(emb) > 0 and all(isinstance(x, (int, float)) for x in emb[:5])
            if not emb_ok:
                logger.warning(
                    "DIAG bad_embedding: edge=%s name=%r type=%s len=%s "
                    "sample=%r fact=%r attrs_keys=%s src=%s tgt=%s",
                    edge.uuid, edge.name,
                    type(emb).__name__, len(emb) if isinstance(emb, (list, tuple)) else 'N/A',
                    emb[:3] if isinstance(emb, list) else emb,
                    edge.fact[:200] if edge.fact else None,
                    list((edge.attributes or {}).keys()),
                    edge.source_node_uuid, edge.target_node_uuid,
                )

        # Filter deduplication-artifact edges (IS_DUPLICATE_OF and variants).
        original_edge_count = len(entity_edges)
        entity_edges = [e for e in entity_edges if not _is_reserved_edge_name(e.name)]
        dup_filtered = original_edge_count - len(entity_edges)
        if dup_filtered:
            logger.warning(
                "DIAG duplicate_edge_filtered: removed %d IS_DUPLICATE_OF-family "
                "edge(s) at bulk_add level", dup_filtered,
            )

        # Filter self-referential edges (entity relating to itself).
        pre_self_count = len(entity_edges)
        entity_edges = [
            e for e in entity_edges
            if e.source_node_uuid != e.target_node_uuid
        ]
        self_ref_count = pre_self_count - len(entity_edges)
        if self_ref_count:
            logger.warning(
                "DIAG self_ref_edge_filtered: removed %d self-referential edge(s)",
                self_ref_count,
            )

        return await original_bulk_add(
            driver, episodic_nodes, episodic_edges,
            entity_nodes, entity_edges, embedder,
        )

    bulk_mod.add_nodes_and_edges_bulk = patched_bulk_add

    # Also patch the local binding in graphiti.py (uses `from ... import`)
    graphiti_mod = importlib.import_module("graphiti_core.graphiti")
    graphiti_mod.add_nodes_and_edges_bulk = patched_bulk_add

    # -- Filter IS_DUPLICATE_OF edges early in extract_edges --
    # Catches them before embedding computation to save resources.
    edge_ops_mod = importlib.import_module(
        "graphiti_core.utils.maintenance.edge_operations"
    )
    original_extract_edges = edge_ops_mod.extract_edges

    async def safe_extract_edges(*args, **kwargs):
        result = await original_extract_edges(*args, **kwargs)
        if result:
            original_len = len(result)
            result = [e for e in result if not _is_reserved_edge_name(e.name)]
            dropped = original_len - len(result)
            if dropped:
                logger.warning(
                    "DIAG duplicate_edge_filtered: removed %d IS_DUPLICATE_OF-family "
                    "edge(s) at extract_edges level", dropped,
                )
        return result

    edge_ops_mod.extract_edges = safe_extract_edges
    graphiti_mod.extract_edges = safe_extract_edges

    # -- Guard embedder.create_batch against None/non-string inputs --
    # Some LLMs (e.g., gemma3) extract entity nodes with None names.
    # Ollama's /v1/embeddings endpoint returns 400 "invalid input" if any
    # element in the batch is null.  Replace None/non-string values with
    # empty strings so the batch succeeds and the rest of the pipeline
    # can proceed.
    original_create_batch = singleton_client.embedder.create_batch

    async def safe_create_batch(inputs):
        sanitized = [s if isinstance(s, str) else "" for s in inputs]
        if not sanitized:
            return []
        return await original_create_batch(sanitized)

    singleton_client.embedder.create_batch = safe_create_batch

    # -- Disable thinking/reasoning tokens for reasoning models (deepseek-r1, qwen3) --
    # These models emit long <think>...</think> blocks before answering, wasting
    # inference time on extraction prompts.  Ollama supports `think: false` via
    # extra_body to suppress this.  Patch the underlying AsyncOpenAI client's
    # chat.completions.create to always inject it.
    llm_client = singleton_client.llm_client
    if hasattr(llm_client, 'client'):
        original_create = llm_client.client.chat.completions.create

        async def no_think_create(*args, **kwargs):
            extra = kwargs.get('extra_body') or {}
            extra['think'] = False
            kwargs['extra_body'] = extra
            return await original_create(*args, **kwargs)

        llm_client.client.chat.completions.create = no_think_create
        logger.info("Patched LLM client chat.completions.create with think=False")

    return app


if __name__ == "__main__":
    import uvicorn

    app = patch()

    port = ExtendedSettings().port
    uvicorn.run(app, host="0.0.0.0", port=port)
