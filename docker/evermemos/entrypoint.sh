#!/bin/bash
# Generate /app/.env from environment variables for EverMemOS.
# Docker Compose sets these via env_file + environment directives.
# EverMemOS's setup_environment() expects a .env file at /app/.env.

env | grep -E '^(LLM_|VECTORIZE_|RERANK_|MONGODB_|ES_|MILVUS_|REDIS_|LOG_LEVEL|ENV|MEMORY_LANGUAGE|MOCK_MODE|MEMSYS_)' > /app/.env

exec /usr/bin/supervisord -n -c /etc/supervisor/conf.d/evermemos.conf
