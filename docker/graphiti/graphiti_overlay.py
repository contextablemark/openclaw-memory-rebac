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


class JsonSafeLLMClient(OpenAIGenericClient):
    """LLM client with structured output support for Ollama and other local providers.

    Two fixes over base OpenAIGenericClient (v0.22.0):

    1. **Structured output**: When a response_model (Pydantic class) is provided,
       sends its JSON schema via response_format={'type': 'json_schema', ...}
       instead of plain {'type': 'json_object'}.  This forces Ollama (0.18+) to
       conform to the exact schema — fixing entity node extraction with local models.
       (Backported from graphiti-core v0.28.2; remove after upgrade.)

    2. **JSON keyword injection**: Groq and some providers require the word 'json'
       in messages when response_format is used.  Graphiti's prompts don't always
       include it, causing 400 errors.
    """

    async def _generate_response(self, messages, response_model=None, **kwargs):
        import json as _json
        from openai.types.chat import ChatCompletionMessageParam

        openai_messages: list[ChatCompletionMessageParam] = []
        for m in messages:
            m.content = self._clean_input(m.content)
            if m.role == 'user':
                openai_messages.append({'role': 'user', 'content': m.content})
            elif m.role == 'system':
                openai_messages.append({'role': 'system', 'content': m.content})

        # Ensure 'json' appears in messages (Groq/Ollama requirement)
        has_json_mention = any('json' in (m.get('content') or '').lower() for m in openai_messages)
        if not has_json_mention:
            for m in openai_messages:
                if m['role'] == 'system':
                    m['content'] += '\nRespond in JSON format.'
                    break
            else:
                openai_messages.insert(0, {'role': 'system', 'content': 'Respond in JSON format.'})

        # Build response_format: use json_schema when we have a model, plain json otherwise
        if response_model is not None:
            schema_name = getattr(response_model, '__name__', 'structured_response')
            json_schema = response_model.model_json_schema()
            response_format = {
                'type': 'json_schema',
                'json_schema': {
                    'name': schema_name,
                    'schema': json_schema,
                },
            }
        else:
            response_format = {'type': 'json_object'}

        try:
            response = await self.client.chat.completions.create(
                model=self.model or 'gpt-4.1-mini',
                messages=openai_messages,
                temperature=self.temperature,
                max_tokens=self.max_tokens,
                response_format=response_format,
            )
            result = response.choices[0].message.content or ''
            return _json.loads(result)
        except Exception as e:
            logger.error(f'Error in generating LLM response: {e}')
            raise


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
    llm_client = JsonSafeLLMClient(config=llm_config)

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
