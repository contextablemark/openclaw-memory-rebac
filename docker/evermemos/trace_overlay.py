"""
Read-only tracing endpoint: message_id → derived memory ObjectIds.

Mounted on the EverMemOS FastAPI app at startup via Dockerfile append.
This is NOT a monkeypatch — it adds a new read-only endpoint to our Docker
image, following the same pattern as the Graphiti startup.py overlay.

Endpoint:
    GET /api/v1/memories/trace/{message_id}

Returns the MongoDB ObjectIds of all derived memories (episodic, foresight,
event_log) produced from a given ingestion message. Used by the
openclaw-memory-rebac plugin to write SpiceDB fragment relationships
against the actual IDs that appear in search results.

Response:
    {
        "message_id": "uuid-123",
        "status": "complete|processing|not_found",
        "memcell_ids": ["ObjectId-A"],
        "derived_memories": {
            "episodic_memory": ["ObjectId-B", ...],
            "foresight": ["ObjectId-D", ...],
            "event_log": ["ObjectId-E", ...],
        },
        "all_ids": ["ObjectId-B", "ObjectId-D", "ObjectId-E", ...]
    }

Uses pymongo (synchronous) since motor is not installed in EverMemOS.
Blocking MongoDB calls are wrapped in asyncio.to_thread for FastAPI compat.
"""

import asyncio
import os
from pymongo import MongoClient
from fastapi import APIRouter

router = APIRouter(tags=["trace"])

_db = None


def _get_db():
    global _db
    if _db is None:
        host = os.environ.get("MONGODB_HOST", "127.0.0.1")
        port = os.environ.get("MONGODB_PORT", "27017")
        username = os.environ.get("MONGODB_USERNAME", "")
        password = os.environ.get("MONGODB_PASSWORD", "")
        db_name = os.environ.get("MONGODB_DATABASE", "memsys")
        if username and password:
            mongo_uri = f"mongodb://{username}:{password}@{host}:{port}"
        else:
            mongo_uri = f"mongodb://{host}:{port}"
        client = MongoClient(mongo_uri)
        _db = client[db_name]
    return _db


def _trace_sync(message_id: str) -> dict:
    """Synchronous MongoDB trace — run via asyncio.to_thread."""
    db = _get_db()

    # Step 1: Check if message_id exists in memory_request_logs
    log_entry = db.memory_request_logs.find_one({"message_id": message_id})
    if not log_entry:
        return {
            "message_id": message_id,
            "status": "not_found",
            "memcell_ids": [],
            "derived_memories": {},
            "all_ids": [],
        }

    # Step 2: Find memcell that contains this message_id in its original_data
    # The message_id is stored at: original_data[*].messages[*].extend.message_id
    memcell = db.memcells.find_one(
        {"original_data.messages.extend.message_id": message_id}
    )
    if not memcell:
        # Log exists but memcell not yet created — still in boundary detection
        return {
            "message_id": message_id,
            "status": "processing",
            "memcell_ids": [],
            "derived_memories": {},
            "all_ids": [],
        }

    memcell_id = str(memcell["_id"])

    # Step 3: Query derived memory collections
    derived = {
        "episodic_memory": [],
        "foresight": [],
        "event_log": [],
    }

    for doc in db.episodic_memories.find(
        {"memcell_event_id_list": memcell_id}, {"_id": 1}
    ):
        derived["episodic_memory"].append(str(doc["_id"]))

    for doc in db.foresight_records.find(
        {"parent_id": memcell_id, "parent_type": "memcell"}, {"_id": 1}
    ):
        derived["foresight"].append(str(doc["_id"]))

    for doc in db.event_log_records.find(
        {"parent_id": memcell_id, "parent_type": "memcell"}, {"_id": 1}
    ):
        derived["event_log"].append(str(doc["_id"]))

    all_ids = [id_ for ids in derived.values() for id_ in ids]
    status = "complete" if all_ids else "processing"

    return {
        "message_id": message_id,
        "status": status,
        "memcell_ids": [memcell_id],
        "derived_memories": derived,
        "all_ids": all_ids,
    }


@router.get("/api/v1/memories/trace/{message_id}")
async def trace_message(message_id: str):
    return await asyncio.to_thread(_trace_sync, message_id)
