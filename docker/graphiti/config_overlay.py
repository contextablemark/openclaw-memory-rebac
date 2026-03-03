"""
Extended Graphiti Settings with per-component embedder/reranker configuration.

Adds these env vars beyond the base Settings:
  EMBEDDING_BASE_URL  — separate base URL for embedder (defaults to OPENAI_BASE_URL)
  EMBEDDING_API_KEY   — separate API key for embedder (defaults to OPENAI_API_KEY)
  EMBEDDING_DIM       — embedding dimensions (default: unset, uses model default)
  RERANKER_PROVIDER   — "bge" (local, default) or "openai" (remote API)
  RERANKER_MODEL      — model name for remote reranker (ignored when provider=bge)
  RERANKER_BASE_URL   — base URL for remote reranker (ignored when provider=bge)
  RERANKER_API_KEY    — API key for remote reranker (ignored when provider=bge)
"""

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class ExtendedSettings(BaseSettings):
    # -- LLM (entity extraction) --
    openai_api_key: str
    openai_base_url: str | None = Field(None)
    model_name: str | None = Field(None)

    # -- Embedder --
    embedding_model_name: str | None = Field(None)
    embedding_base_url: str | None = Field(None)
    embedding_api_key: str | None = Field(None)
    embedding_dim: int | None = Field(None)

    # -- Reranker / cross-encoder --
    reranker_provider: str = "bge"  # "bge" (local) or "openai" (remote)
    reranker_model: str | None = Field(None)
    reranker_base_url: str | None = Field(None)
    reranker_api_key: str | None = Field(None)

    # -- Neo4j --
    neo4j_uri: str = "bolt://localhost:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = "password"

    # -- Server --
    port: int = 8000

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
