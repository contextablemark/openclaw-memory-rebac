import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:crypto")>();
  return { ...mod, randomUUID: vi.fn(() => "test-uuid-000") };
});

vi.mock("undici", () => ({
  request: vi.fn(),
}));

import { EverMemOSBackend } from "./evermemos.js";
import type { EverMemOSConfig } from "./evermemos.js";
import { request as mockUndiciRequest } from "undici";

const defaultConfig: EverMemOSConfig = {
  endpoint: "http://localhost:1995",
  defaultGroupId: "main",
  requestTimeoutMs: 5000,
  retrieveMethod: "hybrid",
  memoryTypes: ["episodic_memory", "profile", "foresight", "event_log"],
  defaultSenderId: "system",
};

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const mockUndici = vi.mocked(mockUndiciRequest);

/** Helper to create a mock undici response */
function undiciResponse(body: unknown, statusCode = 200) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: {
      json: vi.fn().mockResolvedValue(body),
      text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    },
  };
}

/** Helper to create a mock JSON response */
function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["content-type", "application/json"]]),
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

describe("EverMemOSBackend", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockUndici.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("has correct name", () => {
    const backend = new EverMemOSBackend(defaultConfig);
    expect(backend.name).toBe("evermemos");
  });

  describe("store", () => {
    test("returns StoreResult with immediately-resolved fragmentId", async () => {
      const backend = new EverMemOSBackend(defaultConfig);

      mockFetch.mockResolvedValueOnce(jsonResponse({ count: 1 }));

      const result = await backend.store({
        content: "Test memory",
        groupId: "main",
      });

      expect(result.fragmentId).toBeInstanceOf(Promise);
      const uuid = await result.fragmentId;
      expect(uuid).toBe("test-uuid-000"); // Our generated UUID anchor for SpiceDB

      // Verify POST /api/v1/memories was called
      const storeCall = mockFetch.mock.calls[0];
      expect(storeCall[0]).toBe("http://localhost:1995/api/v1/memories");
      const body = JSON.parse(storeCall[1].body as string);
      expect(body.message_id).toBe("test-uuid-000");
      expect(body.content).toBe("Test memory");
      expect(body.group_id).toBe("main");
      expect(body.sender).toBe("system");
      expect(body.role).toBe("user");
      expect(body.create_time).toBeDefined();
    });

    test("ignores customPrompt (EverMemOS handles extraction internally)", async () => {
      const backend = new EverMemOSBackend(defaultConfig);

      mockFetch.mockResolvedValueOnce(jsonResponse({ count: 1 }));

      await backend.store({
        content: "Important fact",
        groupId: "main",
        customPrompt: "Extract only names",
      });

      const storeCall = mockFetch.mock.calls[0];
      const body = JSON.parse(storeCall[1].body as string);
      // customPrompt should NOT appear in the content
      expect(body.content).toBe("Important fact");
      expect(body.content).not.toContain("Extract only names");
    });

    test("handles 202 Accepted response (background processing)", async () => {
      const backend = new EverMemOSBackend(defaultConfig);

      mockFetch.mockResolvedValueOnce(jsonResponse({ request_id: "req-123" }, 202));

      const result = await backend.store({
        content: "Background processed memory",
        groupId: "main",
      });

      expect(result.fragmentId).toBeInstanceOf(Promise);
      const uuid = await result.fragmentId;
      expect(uuid).toBe("test-uuid-000"); // Our generated UUID anchor for SpiceDB
    });

    test("includes sourceDescription in group_name when provided", async () => {
      const backend = new EverMemOSBackend(defaultConfig);

      mockFetch.mockResolvedValueOnce(jsonResponse({ count: 1 }));

      await backend.store({
        content: "Test",
        groupId: "eng-team",
        sourceDescription: "slack conversation",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.group_id).toBe("eng-team");
    });
  });

  describe("searchGroup", () => {
    test("calls GET /api/v1/memories/search with JSON body via undici and maps results", async () => {
      const backend = new EverMemOSBackend(defaultConfig);

      mockUndici.mockResolvedValueOnce(undiciResponse({
        status: "ok",
        result: {
          memories: [
            { "eng": [
              { id: "mem-1", episode: "Alice joined the engineering team", subject: "Team update", memory_type: "episodic_memory", group_id: "eng", timestamp: "2026-03-01T00:00:00Z" },
              { id: "mem-2", summary: "Alice prefers TypeScript", subject: "User profile", memory_type: "profile", group_id: "eng", timestamp: "2026-03-02T00:00:00Z" },
              { id: "mem-3", foresight: "Database migration planned for Friday", subject: "Migration plan", memory_type: "foresight", group_id: "eng", timestamp: "2026-03-03T00:00:00Z" },
              { id: "mem-4", summary: "Deployed v2.1 to production", subject: "Deployment", memory_type: "event_log", group_id: "eng", timestamp: "2026-03-04T00:00:00Z" },
            ] },
          ],
          scores: [
            { "eng": [0.95, 0.80, 0.70, 0.60] },
          ],
        },
      }) as never);

      const results = await backend.searchGroup({
        query: "Alice engineering",
        groupId: "eng",
        limit: 10,
      });

      expect(results).toHaveLength(4);

      expect(results[0]).toMatchObject({ type: "chunk", uuid: "mem-1", group_id: "eng", summary: "Alice joined the engineering team", score: 0.95 });
      expect(results[0].context).toContain("episode");
      expect(results[1]).toMatchObject({ type: "summary", uuid: "mem-2", score: 0.80 });
      expect(results[1].context).toContain("profile");
      expect(results[2]).toMatchObject({ type: "summary", uuid: "mem-3", score: 0.70 });
      expect(results[2].context).toContain("foresight");
      expect(results[3]).toMatchObject({ type: "fact", uuid: "mem-4", score: 0.60 });
      expect(results[3].context).toContain("event");

      // Verify GET with JSON body via undici (no user_id sent)
      expect(mockUndici).toHaveBeenCalledTimes(1);
      const callArgs = mockUndici.mock.calls[0];
      expect(callArgs[0]).toBe("http://localhost:1995/api/v1/memories/search");
      expect((callArgs[1] as Record<string, unknown>).method).toBe("GET");
      const body = JSON.parse((callArgs[1] as Record<string, unknown>).body as string);
      expect(body.query).toBe("Alice engineering");
      expect(body.group_id).toBe("eng");
      expect(body.user_id).toBeUndefined();
      expect(body.top_k).toBe(10);
      expect(body.retrieve_method).toBe("hybrid");
      expect(body.memory_types).toEqual(["episodic_memory", "profile", "foresight", "event_log"]);
    });

    test("returns empty array when no memories found", async () => {
      const backend = new EverMemOSBackend(defaultConfig);

      mockUndici.mockResolvedValueOnce(undiciResponse({ status: "ok", result: { memories: [] } }) as never);

      const results = await backend.searchGroup({ query: "nothing", groupId: "g1", limit: 10 });
      expect(results).toEqual([]);
    });

    test("falls back to position-based score when score is missing", async () => {
      const backend = new EverMemOSBackend(defaultConfig);

      mockUndici.mockResolvedValueOnce(undiciResponse({
        status: "ok",
        result: {
          memories: [
            { "g1": [
              { id: "m1", episode: "First", memory_type: "episodic_memory", timestamp: "2026-03-01" },
              { id: "m2", episode: "Second", memory_type: "episodic_memory", timestamp: "2026-03-02" },
            ] },
          ],
          // No scores provided — should fall back to position-based
        },
      }) as never);

      const results = await backend.searchGroup({ query: "test", groupId: "g1", limit: 10 });

      expect(results[0].score).toBe(1.0);
      expect(results[1].score).toBe(0.5);
    });

    test("uses configured retrieveMethod", async () => {
      const backend = new EverMemOSBackend({ ...defaultConfig, retrieveMethod: "agentic" });

      mockUndici.mockResolvedValueOnce(undiciResponse({ status: "ok", result: { memories: [] } }) as never);

      await backend.searchGroup({ query: "test", groupId: "g1", limit: 5 });

      const body = JSON.parse((mockUndici.mock.calls[0][1] as Record<string, unknown>).body as string);
      expect(body.retrieve_method).toBe("agentic");
    });
  });

  describe("healthCheck", () => {
    test("returns true when health endpoint responds ok", async () => {
      const backend = new EverMemOSBackend(defaultConfig);
      mockFetch.mockResolvedValueOnce({ ok: true });

      const healthy = await backend.healthCheck();
      expect(healthy).toBe(true);

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain("/health");
    });

    test("returns false when health endpoint fails", async () => {
      const backend = new EverMemOSBackend(defaultConfig);
      mockFetch.mockResolvedValueOnce({ ok: false });

      const healthy = await backend.healthCheck();
      expect(healthy).toBe(false);
    });

    test("returns false when network error occurs", async () => {
      const backend = new EverMemOSBackend(defaultConfig);
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const healthy = await backend.healthCheck();
      expect(healthy).toBe(false);
    });
  });

  describe("getStatus", () => {
    test("returns status object with backend name and config details", async () => {
      const backend = new EverMemOSBackend(defaultConfig);
      mockFetch.mockResolvedValueOnce({ ok: true });

      const status = await backend.getStatus();
      expect(status.backend).toBe("evermemos");
      expect(status.endpoint).toBe("http://localhost:1995");
      expect(status.retrieveMethod).toBe("hybrid");
      expect(status.memoryTypes).toEqual(["episodic_memory", "profile", "foresight", "event_log"]);
      expect(status.healthy).toBe(true);
    });

    test("reports unhealthy when health check fails", async () => {
      const backend = new EverMemOSBackend(defaultConfig);
      mockFetch.mockRejectedValueOnce(new Error("Down"));

      const status = await backend.getStatus();
      expect(status.healthy).toBe(false);
    });
  });

  describe("deleteFragment", () => {
    test("calls DELETE /api/v1/memories with event_id", async () => {
      const backend = new EverMemOSBackend(defaultConfig);

      mockFetch.mockResolvedValueOnce(jsonResponse({ deleted: 1 }));

      const result = await backend.deleteFragment?.("mem-uuid-123");
      expect(result).toBe(true);

      const call = mockFetch.mock.calls[0];
      expect(call[0]).toBe("http://localhost:1995/api/v1/memories");
      expect(call[1].method).toBe("DELETE");
      const body = JSON.parse(call[1].body as string);
      expect(body.event_id).toBe("mem-uuid-123");
      expect(body.user_id).toBe("__all__");
      expect(body.group_id).toBe("__all__");
    });

    test("returns false on error", async () => {
      const backend = new EverMemOSBackend(defaultConfig);

      mockFetch.mockRejectedValueOnce(new Error("Server error"));

      const result = await backend.deleteFragment?.("mem-uuid-123");
      expect(result).toBe(false);
    });
  });

  describe("deleteGroup", () => {
    test("calls DELETE /api/v1/memories with group_id", async () => {
      const backend = new EverMemOSBackend(defaultConfig);

      mockFetch.mockResolvedValueOnce(jsonResponse({ deleted: 5 }));

      await backend.deleteGroup("old-group");

      const call = mockFetch.mock.calls[0];
      expect(call[0]).toBe("http://localhost:1995/api/v1/memories");
      expect(call[1].method).toBe("DELETE");
      const body = JSON.parse(call[1].body as string);
      expect(body.event_id).toBe("__all__");
      expect(body.user_id).toBe("__all__");
      expect(body.group_id).toBe("old-group");
    });
  });

  describe("listGroups", () => {
    test("returns empty array (not implemented)", async () => {
      const backend = new EverMemOSBackend(defaultConfig);
      const groups = await backend.listGroups();
      expect(groups).toEqual([]);
    });
  });

  describe("getConversationHistory", () => {
    test("fetches episodic memories for session group", async () => {
      const backend = new EverMemOSBackend(defaultConfig);

      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          memories: [
            { id: "m1", episode: "Discussed project timeline", memory_type: "episodic_memory", created_at: "2026-03-01" },
            { id: "m2", episode: "Agreed on tech stack", memory_type: "episodic_memory", created_at: "2026-03-02" },
          ],
        }),
      );

      const turns = await backend.getConversationHistory("session-abc", 10);
      expect(turns).toHaveLength(2);
      expect(turns[0]).toMatchObject({
        query: "",
        answer: "Discussed project timeline",
        created_at: "2026-03-01",
      });

      // Verify query params
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get("group_id")).toBe("session-session-abc");
      expect(url.searchParams.get("memory_type")).toBe("episodic_memory");
    });

    test("returns empty array on error", async () => {
      const backend = new EverMemOSBackend(defaultConfig);
      mockFetch.mockRejectedValueOnce(new Error("Fail"));

      const turns = await backend.getConversationHistory("session-123");
      expect(turns).toEqual([]);
    });
  });

  describe("enrichSession", () => {
    test("posts conversation metadata", async () => {
      const backend = new EverMemOSBackend(defaultConfig);

      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }));

      await backend.enrichSession({
        sessionId: "s1",
        groupId: "session-s1",
        userMsg: "Hello there",
        assistantMsg: "Hi! How can I help?",
      });

      const call = mockFetch.mock.calls[0];
      expect(call[0]).toBe("http://localhost:1995/api/v1/memories/conversation-meta");
      const body = JSON.parse(call[1].body as string);
      expect(body.group_id).toBe("session-s1");
      expect(body.user_details).toBeDefined();
      expect(body.user_details.system.role).toBe("user");
    });

    test("does not throw on error (best-effort)", async () => {
      const backend = new EverMemOSBackend(defaultConfig);
      mockFetch.mockRejectedValueOnce(new Error("Server error"));

      // Should not throw
      await expect(
        backend.enrichSession({
          sessionId: "s1",
          groupId: "session-s1",
          userMsg: "Hello",
          assistantMsg: "Hi",
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("REST error handling", () => {
    test("throws on non-OK response (search via undici)", async () => {
      const backend = new EverMemOSBackend(defaultConfig);

      mockUndici.mockResolvedValueOnce({
        statusCode: 500,
        headers: { "content-type": "text/plain" },
        body: {
          text: vi.fn().mockResolvedValue("Internal Server Error"),
          json: vi.fn().mockRejectedValue(new Error("not json")),
        },
      } as never);

      await expect(
        backend.searchGroup({ query: "test", groupId: "g1", limit: 10 }),
      ).rejects.toThrow("EverMemOS REST GET /api/v1/memories/search failed: 500");
    });

    test("handles network errors", async () => {
      const backend = new EverMemOSBackend(defaultConfig);
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await expect(
        backend.store({ content: "test", groupId: "main" }),
      ).rejects.toThrow("ECONNREFUSED");
    });
  });

  describe("module exports", () => {
    test("exports defaults matching evermemos.defaults.json", async () => {
      const { defaults } = await import("./evermemos.js");
      expect(defaults.endpoint).toBe("http://localhost:1995");
      expect(defaults.defaultGroupId).toBe("main");
      expect(defaults.retrieveMethod).toBe("hybrid");
      expect(defaults.memoryTypes).toEqual(["episodic_memory", "profile", "foresight", "event_log"]);
      expect(defaults.defaultSenderId).toBe("system");
    });

    test("create() returns MemoryBackend instance", async () => {
      const { create } = await import("./evermemos.js");
      const backend = create(defaultConfig as unknown as Record<string, unknown>);
      expect(backend.name).toBe("evermemos");
    });
  });
});
