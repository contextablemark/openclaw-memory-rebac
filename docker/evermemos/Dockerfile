###############################################################################
# EverMemOS All-in-One Container
#
# Bundles all required services into a single container:
#   - MongoDB 7.0      (port 27017)
#   - Elasticsearch 8   (port 9200, internal only)
#   - Milvus standalone (port 19530, with embedded etcd)
#   - Redis 7           (port 6379, internal only)
#   - EverMemOS API     (port 1995, exposed)
#
# Managed by supervisord. All data stored under /data.
#
# Pinned to EverMemOS commit SHA for reproducibility.
# Update EVERMEMOS_COMMIT to upgrade.
#
# Build:
#   docker compose build evermemos
#
# Override version at build time:
#   docker compose build --build-arg EVERMEMOS_COMMIT=<sha> evermemos
###############################################################################

# Stage 1: Extract Milvus binaries from official image
FROM milvusdb/milvus:v2.5.2 AS milvus-source

# Stage 2: All-in-one container
FROM ubuntu:22.04

ARG EVERMEMOS_COMMIT=3c9a2d02460748310c7707048f7ed6b6bb078ab4
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
# Base packages + supervisord
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
      supervisor curl wget gnupg git ca-certificates \
      python3 python3-pip python3-venv \
      redis-server \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# MongoDB 7.0
# ---------------------------------------------------------------------------
RUN curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | \
      gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg && \
    echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] \
      https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" \
      > /etc/apt/sources.list.d/mongodb-org-7.0.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends mongodb-org && \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Elasticsearch 8.11 (no security, single-node)
# ---------------------------------------------------------------------------
RUN curl -fsSL https://artifacts.elastic.co/GPG-KEY-elasticsearch | \
      gpg --dearmor -o /usr/share/keyrings/elasticsearch.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/elasticsearch.gpg] \
      https://artifacts.elastic.co/packages/8.x/apt stable main" \
      > /etc/apt/sources.list.d/elasticsearch.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends elasticsearch && \
    rm -rf /var/lib/apt/lists/*

# ES config: single-node, no security, limit heap
RUN sed -i 's/xpack.security.enabled: true/xpack.security.enabled: false/' /etc/elasticsearch/elasticsearch.yml && \
    sed -i '/cluster.initial_master_nodes/d' /etc/elasticsearch/elasticsearch.yml && \
    echo "discovery.type: single-node" >> /etc/elasticsearch/elasticsearch.yml && \
    echo "network.host: 127.0.0.1" >> /etc/elasticsearch/elasticsearch.yml && \
    echo "-Xms512m" > /etc/elasticsearch/jvm.options.d/heap.options && \
    echo "-Xmx512m" >> /etc/elasticsearch/jvm.options.d/heap.options

# ---------------------------------------------------------------------------
# Milvus standalone (copied from official Docker image)
# ---------------------------------------------------------------------------
COPY --from=milvus-source /milvus /opt/milvus
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgomp1 libtbb2 libopenblas-dev libaio1 && \
    rm -rf /var/lib/apt/lists/*

# Milvus config for embedded etcd + local storage (no minio)
RUN mkdir -p /data/milvus /opt/milvus/configs && \
    printf '%s\n' \
      'listen-client-urls: http://0.0.0.0:2379' \
      'advertise-client-urls: http://0.0.0.0:2379' \
      'quota-backend-bytes: 4294967296' \
      'auto-compaction-mode: revision' \
      "auto-compaction-retention: '1000'" \
      > /opt/milvus/configs/embedEtcd.yaml

ENV LD_LIBRARY_PATH=/opt/milvus/lib:$LD_LIBRARY_PATH
ENV PATH=/opt/milvus/bin:$PATH

# ---------------------------------------------------------------------------
# EverMemOS (Python app from source)
# ---------------------------------------------------------------------------
RUN pip install --no-cache-dir uv

WORKDIR /app
RUN git clone https://github.com/EverMind-AI/EverMemOS.git . && \
    git checkout "$EVERMEMOS_COMMIT" && \
    uv sync --no-dev

# ---------------------------------------------------------------------------
# Data directories
# ---------------------------------------------------------------------------
RUN mkdir -p /data/mongodb /data/elasticsearch /data/milvus /data/redis

# ---------------------------------------------------------------------------
# Supervisord configuration
# ---------------------------------------------------------------------------
COPY supervisord.conf /etc/supervisor/conf.d/evermemos.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# ---------------------------------------------------------------------------
# Healthcheck — verify the EverMemOS API responds
# ---------------------------------------------------------------------------
HEALTHCHECK --interval=15s --timeout=10s --retries=10 --start-period=60s \
  CMD curl -sf http://localhost:1995/health || exit 1

EXPOSE 1995

CMD ["/entrypoint.sh"]
