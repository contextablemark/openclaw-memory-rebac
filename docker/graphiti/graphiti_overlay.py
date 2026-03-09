"""
Extended Graphiti initialization with per-component client configuration.

Defines OpenClawGraphiti — a subclass of the base Graphiti class that:
  1. Properly forwards all constructor params (embedder, cross_encoder)
  2. Adds the CRUD methods the FastAPI routes require

We bypass ZepGraphiti because its __init__ only forwards (uri, user,
password, llm_client) to super(), silently dropping embedder and
cross_encoder. This causes all embedding calls to use the hardcoded
default model (text-embedding-3-small) instead of the configured one.
"""

import logging

from graphiti_core import Graphiti
from graphiti_core.edges import EntityEdge
from graphiti_core.errors import (
    EdgeNotFoundError,
    GroupsEdgesNotFoundError,
    NodeNotFoundError,
)
from graphiti_core.llm_client.config import LLMConfig
from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
from graphiti_core.nodes import EntityNode, EpisodicNode

from fastapi import HTTPException

from graph_service.config_overlay import ExtendedSettings

logger = logging.getLogger(__name__)


class OpenClawGraphiti(Graphiti):
    """Graphiti subclass with server-specific CRUD methods.

    Unlike ZepGraphiti, this properly forwards ALL constructor params
    (including embedder and cross_encoder) to the base Graphiti class,
    so they are wired into GraphitiClients at construction time.
    """

    async def get_entity_edge(self, uuid: str):
        try:
            edge = await EntityEdge.get_by_uuid(self.driver, uuid)
            return edge
        except EdgeNotFoundError as e:
            raise HTTPException(status_code=404, detail=e.message) from e

    async def delete_entity_edge(self, uuid: str):
        try:
            edge = await EntityEdge.get_by_uuid(self.driver, uuid)
            await edge.delete(self.driver)
        except EdgeNotFoundError as e:
            raise HTTPException(status_code=404, detail=e.message) from e

    async def delete_group(self, group_id: str):
        try:
            edges = await EntityEdge.get_by_group_ids(self.driver, [group_id])
        except GroupsEdgesNotFoundError:
            logger.warning(f"No edges found for group {group_id}")
            edges = []

        nodes = await EntityNode.get_by_group_ids(self.driver, [group_id])
        episodes = await EpisodicNode.get_by_group_ids(self.driver, [group_id])

        for edge in edges:
            await edge.delete(self.driver)
        for node in nodes:
            await node.delete(self.driver)
        for episode in episodes:
            await episode.delete(self.driver)

    async def delete_episodic_node(self, uuid: str):
        try:
            episode = await EpisodicNode.get_by_uuid(self.driver, uuid)
            await episode.delete(self.driver)
        except NodeNotFoundError as e:
            raise HTTPException(status_code=404, detail=e.message) from e


def _create_reranker(settings: ExtendedSettings, llm_client):
    """Create the appropriate reranker based on RERANKER_PROVIDER."""
    if settings.reranker_provider == "openai":
        from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient

        reranker_config = LLMConfig(
            api_key=settings.reranker_api_key or settings.openai_api_key,
            base_url=settings.reranker_base_url or settings.openai_base_url,
        )
        if settings.reranker_model:
            reranker_config.model = settings.reranker_model
        return OpenAIRerankerClient(client=llm_client, config=reranker_config)

    # Default: BGE reranker (runs locally via sentence-transformers, no API needed)
    from graphiti_core.cross_encoder.bge_reranker_client import BGERerankerClient

    return BGERerankerClient()


def create_graphiti(settings: ExtendedSettings) -> OpenClawGraphiti:
    """Create an OpenClawGraphiti instance with per-component client configuration."""

    # -- LLM client (entity extraction) --
    llm_config = LLMConfig(
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
    )
    if settings.model_name:
        llm_config.model = settings.model_name
        llm_config.small_model = settings.model_name
    llm_client = OpenAIGenericClient(config=llm_config)

    # -- Embedder --
    embedder_api_key = settings.embedding_api_key or settings.openai_api_key
    embedder_base_url = settings.embedding_base_url or settings.openai_base_url
    embedder_kwargs = {
        "api_key": embedder_api_key,
        "base_url": embedder_base_url,
    }
    if settings.embedding_model_name:
        embedder_kwargs["embedding_model"] = settings.embedding_model_name
    if settings.embedding_dim is not None:
        embedder_kwargs["embedding_dim"] = settings.embedding_dim
    embedder_config = OpenAIEmbedderConfig(**embedder_kwargs)
    embedder = OpenAIEmbedder(config=embedder_config)

    # -- Reranker / cross-encoder --
    reranker = _create_reranker(settings, llm_client)

    # -- Construct with all params forwarded to base Graphiti --
    client = OpenClawGraphiti(
        uri=settings.neo4j_uri,
        user=settings.neo4j_user,
        password=settings.neo4j_password,
        llm_client=llm_client,
        embedder=embedder,
        cross_encoder=reranker,
    )

    return client
