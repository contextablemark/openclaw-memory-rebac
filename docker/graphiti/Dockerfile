###############################################################################
# Custom Graphiti FastAPI server — built from source (Contextable fork).
#
# Clones graphiti-core v0.28.1 + graph_service server from GitHub at build
# time, pinned to a specific commit for reproducibility.  Overlays our
# per-component config, client factory, and runtime patches.
#
# Overlay patches still applied in startup.py:
#   - AsyncWorker crash-on-error recovery
#   - Neo4j nested attribute sanitization
#   - IS_DUPLICATE_OF edge filtering
#   - Self-referential edge filtering
#   - Singleton client / per-request fix
#   - Empty batch embedder guard
#   - Think token suppression (reasoning models)
#   - Episodes edges endpoint (custom)
###############################################################################

FROM python:3.12-slim

ARG GRAPHITI_REPO=https://github.com/Contextable/graphiti.git
ARG GRAPHITI_COMMIT=aa68b38

RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc g++ git \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 app \
    && pip install --no-cache-dir uv

WORKDIR /app

# Clone graphiti from source, pinned to specific commit
RUN git clone "$GRAPHITI_REPO" /tmp/graphiti \
    && cd /tmp/graphiti && git checkout "$GRAPHITI_COMMIT"

# Install core library (with sentence-transformers for BGE reranker) + server
RUN cd /tmp/graphiti && uv pip install --system ".[sentence-transformers]" \
    && cd /tmp/graphiti/server && uv pip install --system . \
    && python -c "import graphiti_core; import graph_service; print('OK')" \
    && rm -rf /tmp/graphiti

# Find the installed graph_service package location and overlay our files there.
# startup.py goes to /app/ (the working directory).
COPY config_overlay.py graphiti_overlay.py /tmp/overlay/
RUN SITE=$(python -c "import graph_service, os; print(os.path.dirname(graph_service.__file__))") \
    && cp /tmp/overlay/config_overlay.py "$SITE/config_overlay.py" \
    && cp /tmp/overlay/graphiti_overlay.py "$SITE/graphiti_overlay.py" \
    && rm -rf /tmp/overlay
COPY startup.py /app/startup.py

RUN chown -R app:app /app
USER app

CMD ["python", "/app/startup.py"]
