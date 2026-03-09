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
        records, _, _ = await singleton_client.driver.execute_query(
            query, {"episode_uuid": episode_uuid}
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
    # See: https://github.com/contextablemark/openclaw-memory-rebac/issues/6
    RESERVED_EDGE_KEYS = {
        'uuid', 'source_node_uuid', 'target_node_uuid', 'name',
        'fact', 'fact_embedding', 'group_id', 'episodes',
        'created_at', 'expired_at', 'valid_at', 'invalid_at',
    }
    RESERVED_NODE_KEYS = {
        'uuid', 'name', 'name_embedding', 'group_id', 'summary',
        'created_at', 'labels',
    }

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
            # DIAGNOSTIC: log clobber attempts BEFORE stripping (so we can
            # verify the fix is catching them).  Keep until confirmed in prod.
            if edge.attributes and 'fact_embedding' in edge.attributes:
                logger.warning(
                    "DIAG attributes_clobber: edge=%s has 'fact_embedding' in attributes! "
                    "value_type=%s (will be stripped)", edge.uuid,
                    type(edge.attributes.get('fact_embedding')),
                )
            if edge.attributes:
                edge.attributes = _sanitize_attributes(edge.attributes, RESERVED_EDGE_KEYS)
            # DIAGNOSTIC: log edges with missing/invalid embeddings
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
        return await original_bulk_add(
            driver, episodic_nodes, episodic_edges,
            entity_nodes, entity_edges, embedder,
        )

    bulk_mod.add_nodes_and_edges_bulk = patched_bulk_add

    # Also patch the local binding in graphiti.py (uses `from ... import`)
    graphiti_mod = importlib.import_module("graphiti_core.graphiti")
    graphiti_mod.add_nodes_and_edges_bulk = patched_bulk_add

    # -- Fix TypeError in extract_edges when LLM returns None for node indices --
    # graphiti-core does `if not (-1 < source_idx < len(nodes) and -1 < target_idx < len(nodes))`
    # which crashes with TypeError if the LLM returns None for an index.
    #
    # Primary fix: filter bad edges at model-parse level so valid edges from the same
    # episode are preserved. Only applies when the Edge model has int fields (old
    # index-based validation); a no-op for newer name-based validation.
    # Fallback: catch TypeError from the whole function (loses all edges for that episode).
    edge_ops_mod = importlib.import_module(
        "graphiti_core.utils.maintenance.edge_operations"
    )
    original_extract_edges = edge_ops_mod.extract_edges

    try:
        _ep_mod = importlib.import_module("graphiti_core.prompts.extract_edges")
        _OrigExtractedEdges = _ep_mod.ExtractedEdges
        _OrigEdge = _ep_mod.Edge

        # Collect Optional[int] fields (present in old index-based Edge model)
        _int_fields = []
        for _fname, _finfo in _OrigEdge.model_fields.items():
            _ann = _finfo.annotation
            if _ann is int:
                _int_fields.append(_fname)
            elif hasattr(_ann, "__args__") and int in _ann.__args__:
                _int_fields.append(_fname)

        if _int_fields:
            _orig_mv = _OrigExtractedEdges.model_validate

            @classmethod  # type: ignore[misc]
            def _filtered_model_validate(cls, obj, *a, **kw):
                result = _orig_mv.__func__(cls, obj, *a, **kw)
                if result.edges:
                    valid = [e for e in result.edges if all(getattr(e, f) is not None for f in _int_fields)]
                    dropped = len(result.edges) - len(valid)
                    if dropped:
                        logger.warning("extract_edges: filtered %d edge(s) with None index fields", dropped)
                    result.edges = valid
                return result

            _OrigExtractedEdges.model_validate = _filtered_model_validate
            logger.info("Patched ExtractedEdges.model_validate to filter None int fields: %s", _int_fields)
        else:
            logger.info("ExtractedEdges uses name-based validation — None-index filter not needed")
    except Exception as _patch_err:
        logger.warning("Could not patch ExtractedEdges for None-index filtering: %s", _patch_err)

    # Fallback: catch any remaining TypeError from the whole function
    async def safe_extract_edges(*args, **kwargs):
        try:
            return await original_extract_edges(*args, **kwargs)
        except TypeError as e:
            if "not supported between instances" in str(e):
                logger.warning("extract_edges skipped due to LLM output issue: %s", e)
                return []
            raise

    edge_ops_mod.extract_edges = safe_extract_edges
    # Patch the local binding in graphiti.py
    graphiti_mod.extract_edges = safe_extract_edges

    return app


if __name__ == "__main__":
    import uvicorn

    app = patch()

    port = ExtendedSettings().port
    uvicorn.run(app, host="0.0.0.0", port=port)
