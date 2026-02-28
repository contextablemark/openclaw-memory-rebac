import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { GraphitiBackend } from "./graphiti.js";
import type { GraphitiConfig } from "./graphiti.js";

const defaultConfig: GraphitiConfig = {
  endpoint: "http://localhost:8000",
  defaultGroupId: "main",
  uuidPollIntervalMs: 100,
  uuidPollMaxAttempts: 5,
};

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe("GraphitiBackend", () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("has correct name", () => {
    const backend = new GraphitiBackend(defaultConfig);
    expect(backend.name).toBe("graphiti");
  });

  describe("store", () => {
    test("returns StoreResult with fragmentId Promise", async () => {
      const backend = new GraphitiBackend(defaultConfig);

      // Mock initialize
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "session-123"]]),
        text: vi.fn().mockResolvedValue('data: {"jsonrpc":"2.0","id":1,"result":{}}\n'),
      });

      // Mock notifications/initialized
      mockFetch.mockResolvedValueOnce({ ok: true });

      // Mock add_memory tool call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: JSON.stringify({ episode_uuid: "ep-123" }) }] },
        }),
      });

      // Mock get_episodes polling (return episode on first poll)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          jsonrpc: "2.0",
          id: 3,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  episodes: [{ uuid: "real-uuid-123", name: "memory_ep-123", group_id: "main" }],
                }),
              },
            ],
          },
        }),
      });

      const result = await backend.store({
        content: "Test memory",
        groupId: "main",
      });

      expect(result.fragmentId).toBeInstanceOf(Promise);
      const uuid = await result.fragmentId;
      expect(uuid).toBe("real-uuid-123");
    });

    test("passes customPrompt in episode_body with instructions wrapper", async () => {
      const backend = new GraphitiBackend(defaultConfig);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "s1"]]),
        text: vi.fn().mockResolvedValue('data: {"jsonrpc":"2.0","id":1,"result":{}}\n'),
      });
      mockFetch.mockResolvedValueOnce({ ok: true });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: JSON.stringify({ episode_uuid: "ep-1" }) }] },
        }),
      });

      await backend.store({
        content: "Important fact",
        groupId: "main",
        customPrompt: "Extract only names",
      });

      const addMemoryCall = mockFetch.mock.calls[2];
      const body = JSON.parse(addMemoryCall[1].body as string);
      expect(body.params.arguments.episode_body).toContain("[Extraction Instructions]");
      expect(body.params.arguments.episode_body).toContain("Extract only names");
      expect(body.params.arguments.episode_body).toContain("[End Instructions]");
      expect(body.params.arguments.episode_body).toContain("Important fact");
    });
  });

  describe("searchGroup", () => {
    test("calls searchNodes and searchFacts in parallel", async () => {
      const backend = new GraphitiBackend(defaultConfig);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "s1"]]),
        text: vi.fn().mockResolvedValue('data: {"jsonrpc":"2.0","id":1,"result":{}}\n'),
      });
      mockFetch.mockResolvedValueOnce({ ok: true });

      // Mock search_nodes
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          jsonrpc: "2.0",
          id: 2,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  nodes: [{ uuid: "n1", name: "Mark", summary: "A developer", group_id: "g1", created_at: "2026-01-15" }],
                }),
              },
            ],
          },
        }),
      });

      // Mock search_memory_facts
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          jsonrpc: "2.0",
          id: 3,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  facts: [
                    {
                      uuid: "f1",
                      fact: "Mark got promoted",
                      source_node_name: "Mark",
                      target_node_name: "Promotion",
                      group_id: "g1",
                      created_at: "2026-01-16",
                    },
                  ],
                }),
              },
            ],
          },
        }),
      });

      const results = await backend.searchGroup({
        query: "Mark work",
        groupId: "g1",
        limit: 10,
      });

      expect(results).toHaveLength(2);
      expect(results[0].type).toBe("node");
      expect(results[0].uuid).toBe("n1");
      expect(results[1].type).toBe("fact");
      expect(results[1].uuid).toBe("f1");
    });

    test("maps nodes to SearchResult with type=node", async () => {
      const backend = new GraphitiBackend(defaultConfig);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "s1"]]),
        text: vi.fn().mockResolvedValue('data: {"jsonrpc":"2.0","id":1,"result":{}}\n'),
      });
      mockFetch.mockResolvedValueOnce({ ok: true });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          jsonrpc: "2.0",
          id: 2,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  nodes: [{ uuid: "n1", name: "EntityName", summary: "Entity summary", group_id: "g1", created_at: "2026-01-15" }],
                }),
              },
            ],
          },
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          jsonrpc: "2.0",
          id: 3,
          result: { content: [{ type: "text", text: JSON.stringify({ facts: [] }) }] },
        }),
      });

      const results = await backend.searchGroup({
        query: "entity",
        groupId: "g1",
        limit: 10,
      });

      expect(results[0]).toMatchObject({
        type: "node",
        uuid: "n1",
        group_id: "g1",
        summary: "Entity summary",
        context: "EntityName",
      });
    });

    test("maps facts to SearchResult with type=fact", async () => {
      const backend = new GraphitiBackend(defaultConfig);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "s1"]]),
        text: vi.fn().mockResolvedValue('data: {"jsonrpc":"2.0","id":1,"result":{}}\n'),
      });
      mockFetch.mockResolvedValueOnce({ ok: true });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: JSON.stringify({ nodes: [] }) }] },
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          jsonrpc: "2.0",
          id: 3,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  facts: [
                    {
                      uuid: "f1",
                      fact: "A → B",
                      name: "RELATES_TO",
                      source_node_name: "A",
                      target_node_name: "B",
                      group_id: "g1",
                      created_at: "2026-01-16",
                    },
                  ],
                }),
              },
            ],
          },
        }),
      });

      const results = await backend.searchGroup({
        query: "relation",
        groupId: "g1",
        limit: 10,
      });

      expect(results[0]).toMatchObject({
        type: "fact",
        uuid: "f1",
        group_id: "g1",
        summary: "A → B",
        context: "A -[RELATES_TO]→ B",
      });
    });
  });

  describe("healthCheck", () => {
    test("returns true when /health responds ok", async () => {
      const backend = new GraphitiBackend(defaultConfig);
      mockFetch.mockResolvedValueOnce({ ok: true });

      const healthy = await backend.healthCheck();
      expect(healthy).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8000/health",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    test("returns false when /health fails", async () => {
      const backend = new GraphitiBackend(defaultConfig);
      mockFetch.mockResolvedValueOnce({ ok: false });

      const healthy = await backend.healthCheck();
      expect(healthy).toBe(false);
    });

    test("returns false when /health throws", async () => {
      const backend = new GraphitiBackend(defaultConfig);
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const healthy = await backend.healthCheck();
      expect(healthy).toBe(false);
    });
  });

  describe("getStatus", () => {
    test("returns status object with backend name and healthy flag", async () => {
      const backend = new GraphitiBackend(defaultConfig);
      mockFetch.mockResolvedValueOnce({ ok: true });

      const status = await backend.getStatus();
      expect(status.backend).toBe("graphiti");
      expect(status.endpoint).toBe("http://localhost:8000");
      expect(status.healthy).toBe(true);
    });

    test("reports unhealthy when health check fails", async () => {
      const backend = new GraphitiBackend(defaultConfig);
      mockFetch.mockRejectedValueOnce(new Error("Down"));

      const status = await backend.getStatus();
      expect(status.healthy).toBe(false);
    });
  });

  describe("deleteFragment", () => {
    test("calls delete_entity_edge tool", async () => {
      const backend = new GraphitiBackend(defaultConfig);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "s1"]]),
        text: vi.fn().mockResolvedValue('data: {"jsonrpc":"2.0","id":1,"result":{}}\n'),
      });
      mockFetch.mockResolvedValueOnce({ ok: true });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: "Deleted" }] },
        }),
      });

      const result = await backend.deleteFragment?.("fact-uuid-123");
      expect(result).toBe(true);

      const deleteCall = mockFetch.mock.calls[2];
      const body = JSON.parse(deleteCall[1].body as string);
      expect(body.method).toBe("tools/call");
      expect(body.params.name).toBe("delete_entity_edge");
      expect(body.params.arguments.uuid).toBe("fact-uuid-123");
    });
  });

  describe("deleteGroup", () => {
    test("calls clear_graph tool with group_ids", async () => {
      const backend = new GraphitiBackend(defaultConfig);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "s1"]]),
        text: vi.fn().mockResolvedValue('data: {"jsonrpc":"2.0","id":1,"result":{}}\n'),
      });
      mockFetch.mockResolvedValueOnce({ ok: true });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: "Cleared" }] },
        }),
      });

      await backend.deleteGroup("old-group");

      const clearCall = mockFetch.mock.calls[2];
      const body = JSON.parse(clearCall[1].body as string);
      expect(body.method).toBe("tools/call");
      expect(body.params.name).toBe("clear_graph");
      expect(body.params.arguments.group_ids).toEqual(["old-group"]);
    });
  });

  describe("listGroups", () => {
    test("returns empty array (not implemented)", async () => {
      const backend = new GraphitiBackend(defaultConfig);
      const groups = await backend.listGroups();
      expect(groups).toEqual([]);
    });
  });

  describe("getConversationHistory", () => {
    test("maps getEpisodes to ConversationTurn[]", async () => {
      const backend = new GraphitiBackend(defaultConfig);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "s1"]]),
        text: vi.fn().mockResolvedValue('data: {"jsonrpc":"2.0","id":1,"result":{}}\n'),
      });
      mockFetch.mockResolvedValueOnce({ ok: true });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          jsonrpc: "2.0",
          id: 2,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  episodes: [
                    { uuid: "e1", name: "Turn 1", content: "User: Hi\nAssistant: Hello", created_at: "2026-01-15" },
                    { uuid: "e2", name: "Turn 2", content: "User: Bye\nAssistant: Goodbye", created_at: "2026-01-16" },
                  ],
                }),
              },
            ],
          },
        }),
      });

      const turns = await backend.getConversationHistory("session-123", 10);
      expect(turns).toHaveLength(2);
      expect(turns[0]).toMatchObject({
        query: "Turn 1",
        answer: "User: Hi\nAssistant: Hello",
        created_at: "2026-01-15",
      });
    });

    test("returns empty array on error", async () => {
      const backend = new GraphitiBackend(defaultConfig);
      mockFetch.mockRejectedValueOnce(new Error("Fail"));

      const turns = await backend.getConversationHistory("session-123");
      expect(turns).toEqual([]);
    });
  });
});
