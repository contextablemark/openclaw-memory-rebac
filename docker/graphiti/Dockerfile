###############################################################################
# Custom Graphiti FastAPI server with per-component LLM/embedder/reranker
# configurability and BGE reranker support.
#
# Extends the base zepai/graphiti image to:
#   1. Install sentence-transformers for BGE reranker
#   2. Overlay per-component config + startup to wire separate clients
#
# UPGRADE AUDIT (vs upstream getzep/graphiti v0.28.2, audited 2026-03-21):
#   Overlay patches in startup.py — 5 of 6 still needed:
#   [NEEDED]  AsyncWorker crash-on-error recovery      (startup.py:109-126)
#   [NEEDED]  Neo4j nested attribute sanitization       (startup.py:128-250)
#   [SAFE]    None-index extract_edges fix              (startup.py:252-298)
#             — fixed upstream (name-based model); patch self-disables
#   [NEEDED]  IS_DUPLICATE_OF edge filtering            (startup.py:152-169,216-227,310-318)
#   [NEEDED]  Self-referential edge filtering           (startup.py:228-239)
#   [NEEDED]  Singleton client / per-request fix        (startup.py:38-87)
###############################################################################

FROM zepai/graphiti:0.22.0

# Base image runs as non-root "app" user; switch to root to install packages
USER root

# Ensure the venv is active for all subsequent RUN and CMD
ENV VIRTUAL_ENV=/app/.venv
ENV PATH="/app/.venv/bin:${PATH}"

# Install sentence-transformers for BGE reranker (runs locally, no API needed)
RUN uv pip install 'sentence-transformers>=3.2.1' \
    && python -c "import sentence_transformers; print('OK')"

# Overlay: per-component config + startup
COPY config_overlay.py /app/graph_service/config_overlay.py
COPY graphiti_overlay.py /app/graph_service/graphiti_overlay.py
COPY startup.py /app/startup.py

# Fix ownership for app user
RUN chown -R app:app /app

# Switch back to non-root user
USER app

# Run startup directly via venv python (not `uv run`, which may reset the venv)
CMD ["/app/.venv/bin/python", "/app/startup.py"]
