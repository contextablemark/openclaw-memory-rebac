/**
 * Memory Plugin (ReBAC) Tests
 *
 * Tests plugin registration, tool wiring, configuration parsing,
 * and backend factory with mocked dependencies.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

// Mock @authzed/authzed-node before importing the plugin
vi.mock("@authzed/authzed-node", () => {
  const mockPromises = {
    writeSchema: vi.fn().mockResolvedValue({}),
    readSchema: vi.fn().mockResolvedValue({ schemaText: "" }),
    writeRelationships: vi.fn().mockResolvedValue({ writtenAt: { token: "write-token-1" } }),
    deleteRelationships: vi.fn().mockResolvedValue({ deletedAt: { token: "delete-token" } }),
    bulkImportRelationships: vi.fn(),
    checkPermission: vi.fn().mockResolvedValue({
      permissionship: 2, // HAS_PERMISSION
    }),
    lookupResources: vi.fn().mockResolvedValue([
      { resourceObjectId: "main" },
    ]),
    readRelationships: vi.fn().mockResolvedValue([]),
    deleteRelationshipsByFilter: vi.fn().mockResolvedValue({ deletedAt: { token: "delete-token" } }),
  };

  return {
    v1: {
      NewClient: vi.fn(() => ({
        promises: mockPromises,
      })),
      ClientSecurity: { INSECURE_LOCALHOST_ALLOWED: 1 },
      WriteSchemaRequest: { create: vi.fn((v: unknown) => v) },
      ReadSchemaRequest: { create: vi.fn((v: unknown) => v) },
      WriteRelationshipsRequest: { create: vi.fn((v: unknown) => v) },
      DeleteRelationshipsRequest: { create: vi.fn((v: unknown) => v) },
      RelationshipFilter: { create: vi.fn((v: unknown) => v) },
      CheckPermissionRequest: { create: vi.fn((v: unknown) => v) },
      CheckPermissionResponse_Permissionship: { HAS_PERMISSION: 2 },
      LookupResourcesRequest: { create: vi.fn((v: unknown) => v) },
      ReadRelationshipsRequest: { create: vi.fn((v: unknown) => v) },
      SubjectFilter: { create: vi.fn((v: unknown) => v) },
      RelationshipUpdate: { create: vi.fn((v: unknown) => v) },
      RelationshipUpdate_Operation: { TOUCH: 1, DELETE: 2 },
      Relationship: { create: vi.fn((v: unknown) => v) },
      ObjectReference: { create: vi.fn((v: unknown) => v) },
      SubjectReference: { create: vi.fn((v: unknown) => v) },
      BulkImportRelationshipsRequest: { create: vi.fn((v: unknown) => v) },
      Consistency: { create: vi.fn((v: unknown) => v) },
      ZedToken: { create: vi.fn((v: unknown) => v) },
    },
  };
});

// Mock global fetch for backend HTTP requests
const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe("openclaw-memory-rebac plugin", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let registeredTools: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let registeredClis: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let registeredServices: any[];
  let logs: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockApi: any;

  beforeEach(async () => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
    registeredTools = [];
    registeredClis = [];
    registeredServices = [];
    logs = [];

    mockApi = {
      pluginConfig: {
        backend: "graphiti",
        spicedb: {
          endpoint: "localhost:50051",
          token: "test-token",
          insecure: true,
        },
        graphiti: {
          endpoint: "http://localhost:8000",
          defaultGroupId: "main",
        },
      },
      registerTool: vi.fn((toolOrFactory, _meta?: unknown) => {
        if (typeof toolOrFactory === "function") {
          // Tool factory pattern: invoke with mock context to get the tool object
          registeredTools.push(toolOrFactory({ agentId: "test-agent" }));
        } else {
          registeredTools.push(toolOrFactory);
        }
      }),
      registerCli: vi.fn((handler) => {
        registeredClis.push(handler);
      }),
      registerService: vi.fn((service) => {
        registeredServices.push(service);
      }),
      on: vi.fn(),
      logger: {
        info: vi.fn((...args) => logs.push(`[INFO] ${args.join(" ")}`)),
        warn: vi.fn((...args) => logs.push(`[WARN] ${args.join(" ")}`)),
      },
    };

    // Mock backend health checks
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/health")) {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  });

  test("exports plugin with correct id and metadata", async () => {
    const plugin = await import("./index.js");
    expect(plugin.default.id).toBe("openclaw-memory-rebac");
    expect(plugin.default.name).toBe("Memory (ReBAC)");
    expect(plugin.default.kind).toBe("memory");
  });

  test("registers 4 tools: memory_recall, memory_store, memory_forget, memory_status", async () => {
    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    expect(registeredTools).toHaveLength(4);
    expect(registeredTools.map((t) => t.name)).toEqual([
      "memory_recall",
      "memory_store",
      "memory_forget",
      "memory_status",
    ]);
  });

  test("registers CLI handler", async () => {
    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    expect(registeredClis).toHaveLength(1);
  });

  test("registers service", async () => {
    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    expect(registeredServices).toHaveLength(1);
    expect(registeredServices[0].id).toBe("openclaw-memory-rebac");
  });

  test("logs backend selection on registration", async () => {
    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    expect(logs.some(log => log.includes("backend: graphiti"))).toBe(true);
  });

  test("throws when spicedb.token is missing", async () => {
    const plugin = await import("./index.js");
    const badApi = {
      ...mockApi,
      pluginConfig: {
        ...mockApi.pluginConfig,
        spicedb: { ...mockApi.pluginConfig.spicedb, token: "" },
      },
    };

    expect(() => plugin.default.register(badApi)).toThrow("spicedb.token is not configured");
  });

  test("creates GraphitiBackend when backend=graphiti", async () => {
    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    expect(logs.some(log => log.includes("backend: graphiti"))).toBe(true);
  });

  test("memory_recall tool has correct parameters", async () => {
    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    const recallTool = registeredTools.find((t) => t.name === "memory_recall");
    expect(recallTool).toBeDefined();
    expect(recallTool.label).toBe("Memory Recall");
    expect(recallTool.parameters.properties.query).toBeDefined();
    expect(recallTool.parameters.properties.limit).toBeDefined();
    expect(recallTool.parameters.properties.scope).toBeDefined();
  });

  test("memory_store tool has correct parameters", async () => {
    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    const storeTool = registeredTools.find((t) => t.name === "memory_store");
    expect(storeTool).toBeDefined();
    expect(storeTool.label).toBe("Memory Store");
    expect(storeTool.parameters.properties.content).toBeDefined();
    expect(storeTool.parameters.properties.source_description).toBeDefined();
    expect(storeTool.parameters.properties.involves).toBeDefined();
    expect(storeTool.parameters.properties.group_id).toBeDefined();
    expect(storeTool.parameters.properties.longTerm).toBeDefined();
  });

  test("memory_forget tool has correct parameters", async () => {
    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    const forgetTool = registeredTools.find((t) => t.name === "memory_forget");
    expect(forgetTool).toBeDefined();
    expect(forgetTool.label).toBe("Memory Forget");
    expect(forgetTool.parameters.properties.id).toBeDefined();
  });

  test("memory_status tool has empty parameters", async () => {
    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    const statusTool = registeredTools.find((t) => t.name === "memory_status");
    expect(statusTool).toBeDefined();
    expect(statusTool.label).toBe("Memory Status");
    expect(Object.keys(statusTool.parameters.properties)).toHaveLength(0);
  });

  test("registers before_agent_start hook when autoRecall=true", async () => {
    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    expect(mockApi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
  });

  test("registers agent_end hook when autoCapture=true", async () => {
    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    expect(mockApi.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
  });

  test("does not register before_agent_start when autoRecall=false", async () => {
    const plugin = await import("./index.js");
    const noRecallApi = {
      ...mockApi,
      pluginConfig: {
        ...mockApi.pluginConfig,
        autoRecall: false,
      },
    };

    plugin.default.register(noRecallApi);

    const hookCalls = mockApi.on.mock.calls.filter((c: unknown[]) => c[0] === "before_agent_start");
    expect(hookCalls).toHaveLength(0);
  });

  test("does not register agent_end when autoCapture=false", async () => {
    const plugin = await import("./index.js");
    const noCaptureApi = {
      ...mockApi,
      pluginConfig: {
        ...mockApi.pluginConfig,
        autoCapture: false,
      },
    };

    plugin.default.register(noCaptureApi);

    const hookCalls = mockApi.on.mock.calls.filter((c: unknown[]) => c[0] === "agent_end");
    expect(hookCalls).toHaveLength(0);
  });

  test("service.start() writes SpiceDB schema on first run", async () => {
    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = v1.NewClient();

    // Simulate empty schema (first run)
    mockClient.promises.readSchema = vi.fn().mockResolvedValue({ schemaText: "" });

    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    const service = registeredServices[0];
    await service.start();

    expect(mockClient.promises.writeSchema).toHaveBeenCalled();
    expect(logs.some(log => log.includes("writing SpiceDB schema"))).toBe(true);
  });

  test("service.start() skips schema write when already exists", async () => {
    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = v1.NewClient();

    mockClient.promises.readSchema = vi.fn().mockResolvedValue({
      schemaText: "definition memory_fragment {...}",
    });
    mockClient.promises.writeSchema = vi.fn();

    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    const service = registeredServices[0];
    await service.start();

    expect(mockClient.promises.writeSchema).not.toHaveBeenCalled();
  });

  test("service.start() ensures default group membership", async () => {
    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = v1.NewClient();

    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    const service = registeredServices[0];
    await service.start();

    expect(mockClient.promises.writeRelationships).toHaveBeenCalled();
  });

  // ==========================================================================
  // memory_forget authorization tests
  // ==========================================================================

  test("memory_forget succeeds when fragment-level delete permission exists", async () => {
    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = v1.NewClient();

    // checkPermission returns HAS_PERMISSION for the fragment-level delete check
    mockClient.promises.checkPermission = vi.fn().mockResolvedValue({
      permissionship: 2, // HAS_PERMISSION
    });

    // Mock backend deleteFragment endpoint
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes("/episode/")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({ success: true }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    const forgetTool = registeredTools.find((t) => t.name === "memory_forget");
    const result = await forgetTool.execute("call-1", { id: "fact:test-uuid-123" });

    expect(result.content[0].text).toBe("Memory forgotten.");
    expect(result.details.action).toBe("deleted");
    // lookupResources should NOT have been called (fragment check passed)
    expect(mockClient.promises.lookupResources).not.toHaveBeenCalled();
  });

  test("memory_forget falls back to group-level authorization when fragment check fails", async () => {
    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = v1.NewClient();

    let checkCallCount = 0;
    mockClient.promises.checkPermission = vi.fn().mockImplementation(() => {
      checkCallCount++;
      if (checkCallCount === 1) {
        // First call: canDeleteFragment → NO_PERMISSION
        return Promise.resolve({ permissionship: 1 });
      }
      // Second call: canWriteToGroup → HAS_PERMISSION
      return Promise.resolve({ permissionship: 2 });
    });

    // lookupAuthorizedGroups returns groups
    mockClient.promises.lookupResources = vi.fn().mockResolvedValue([
      { resourceObjectId: "main" },
    ]);

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/episode/")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({ success: true }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    const forgetTool = registeredTools.find((t) => t.name === "memory_forget");
    const result = await forgetTool.execute("call-1", { id: "fact:orphan-uuid-456" });

    expect(result.content[0].text).toBe("Memory forgotten.");
    expect(result.details.action).toBe("deleted");
    // lookupResources was called for the group-level fallback
    expect(mockClient.promises.lookupResources).toHaveBeenCalled();
    // Info log about fallback authorization
    expect(logs.some(log => log.includes("authorized via group membership"))).toBe(true);
  });

  test("memory_forget denies when both fragment and group-level checks fail", async () => {
    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = v1.NewClient();

    // All permission checks return NO_PERMISSION
    mockClient.promises.checkPermission = vi.fn().mockResolvedValue({
      permissionship: 1, // NO_PERMISSION
    });

    // No authorized groups
    mockClient.promises.lookupResources = vi.fn().mockResolvedValue([]);

    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    const forgetTool = registeredTools.find((t) => t.name === "memory_forget");
    const result = await forgetTool.execute("call-1", { id: "fact:unauth-uuid-789" });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.details.action).toBe("denied");
  });

  test("memory_forget denies when fragment check fails and user has groups but no contribute permission", async () => {
    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = v1.NewClient();

    // All checkPermission calls return NO_PERMISSION (fragment delete + group contribute)
    mockClient.promises.checkPermission = vi.fn().mockResolvedValue({
      permissionship: 1,
    });

    // User has groups (access) but no contribute permission
    mockClient.promises.lookupResources = vi.fn().mockResolvedValue([
      { resourceObjectId: "read-only-group" },
    ]);

    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    const forgetTool = registeredTools.find((t) => t.name === "memory_forget");
    const result = await forgetTool.execute("call-1", { id: "some-uuid" });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.details.action).toBe("denied");
  });

  test("memory_forget rejects entity type IDs", async () => {
    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    const forgetTool = registeredTools.find((t) => t.name === "memory_forget");
    const result = await forgetTool.execute("call-1", { id: "entity:some-uuid" });

    expect(result.content[0].text).toContain("Entities cannot be deleted directly");
    expect(result.details.action).toBe("error");
  });

  // ==========================================================================
  // Per-agent identity tests
  // ==========================================================================

  test("tool factory uses agentId from context for subject identity", async () => {
    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = v1.NewClient();

    // Track what subject is used in checkPermission calls
    const checkCalls: unknown[] = [];
    mockClient.promises.checkPermission = vi.fn().mockImplementation((req: unknown) => {
      checkCalls.push(req);
      return Promise.resolve({ permissionship: 2 }); // HAS_PERMISSION
    });

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/episode/")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({ success: true }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const plugin = await import("./index.js");

    // Register with a custom mock that invokes factory with specific agentId
    const toolsByAgent: Record<string, ReturnType<typeof vi.fn>[]> = {};
    const agentApi = {
      ...mockApi,
      registerTool: vi.fn((toolOrFactory: unknown, _meta?: unknown) => {
        if (typeof toolOrFactory === "function") {
          // Register tools for "stenographer" agent
          const tool = (toolOrFactory as Function)({ agentId: "stenographer" });
          if (!toolsByAgent["stenographer"]) toolsByAgent["stenographer"] = [];
          toolsByAgent["stenographer"].push(tool);
        }
      }),
    };

    await plugin.default.register(agentApi);

    // The forget tool for "stenographer" should use agent:stenographer as subject
    const forgetTool = toolsByAgent["stenographer"]?.find((t: { name: string }) => t.name === "memory_forget");
    expect(forgetTool).toBeDefined();

    await forgetTool.execute("call-1", { id: "fact:test-uuid" });

    // checkPermission should have been called with subject type "agent" and id "stenographer"
    expect(checkCalls.length).toBeGreaterThan(0);
  });

  test("tool factory falls back to config subject when agentId is absent", async () => {
    const plugin = await import("./index.js");

    // Register with undefined agentId
    const noAgentTools: ReturnType<typeof vi.fn>[] = [];
    const noAgentApi = {
      ...mockApi,
      registerTool: vi.fn((toolOrFactory: unknown, _meta?: unknown) => {
        if (typeof toolOrFactory === "function") {
          const tool = (toolOrFactory as Function)({ agentId: undefined });
          noAgentTools.push(tool);
        }
      }),
    };

    await plugin.default.register(noAgentApi);

    const statusTool = noAgentTools.find((t: { name: string }) => t.name === "memory_status");
    expect(statusTool).toBeDefined();
    expect(statusTool.name).toBe("memory_status");
  });

  // ==========================================================================
  // Identity linking tests
  // ==========================================================================

  test("service.start() writes agent→owner relationships from identities config", async () => {
    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = v1.NewClient();

    const writeRelCalls: unknown[] = [];
    mockClient.promises.writeRelationships = vi.fn().mockImplementation((req: unknown) => {
      writeRelCalls.push(req);
      return Promise.resolve({ writtenAt: { token: "write-token-identity" } });
    });

    const plugin = await import("./index.js");
    const identityApi = {
      ...mockApi,
      pluginConfig: {
        ...mockApi.pluginConfig,
        identities: {
          main: "U0123ABC",
          work: "U0456DEF",
        },
      },
    };

    await plugin.default.register(identityApi);
    const service = registeredServices[0];
    await service.start();

    // Should have logged the identity links
    expect(logs.some(log => log.includes("linked agent:main") && log.includes("person:U0123ABC"))).toBe(true);
    expect(logs.some(log => log.includes("linked agent:work") && log.includes("person:U0456DEF"))).toBe(true);
  });

  test("service.start() handles empty identities config gracefully", async () => {
    const plugin = await import("./index.js");
    // Default config has no identities
    await plugin.default.register(mockApi);
    const service = registeredServices[0];

    // Should not throw
    await service.start();

    // No identity-link logs
    expect(logs.some(log => log.includes("linked agent:"))).toBe(false);
  });

  // ==========================================================================
  // Owner-aware recall tests
  // ==========================================================================

  test("memory_recall includes fragments viewable by agent's owner", async () => {
    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = v1.NewClient();

    // lookupResources: first call for authorized groups, later for viewable fragments
    let lookupCallCount = 0;
    mockClient.promises.lookupResources = vi.fn().mockImplementation(() => {
      lookupCallCount++;
      if (lookupCallCount === 1) {
        // lookupAuthorizedGroups → agent has access to "main" group
        return Promise.resolve([{ resourceObjectId: "main" }]);
      }
      // lookupViewableFragments → owner can view extra fragments
      return Promise.resolve([
        { resourceObjectId: "owner-fragment-1" },
        { resourceObjectId: "owner-fragment-2" },
      ]);
    });

    // readRelationships → agent has an owner (must match @authzed/authzed-node response shape)
    mockClient.promises.readRelationships = vi.fn().mockResolvedValue([
      {
        relationship: {
          resource: { objectType: "agent", objectId: "test-agent" },
          relation: "owner",
          subject: { object: { objectType: "person", objectId: "U0123ABC" } },
        },
      },
    ]);

    // Mock backend search + fragment fetch
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/search")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({
            facts: [
              { uuid: "group-fact-1", name: "Group fact", fact: "From group search", created_at: "2026-01-01T00:00:00Z" },
            ],
          }),
        });
      }
      if (url.includes("/entity-edge/owner-fragment-1")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({
            uuid: "owner-fragment-1", name: "Owner fact 1", fact: "Decision about widget", created_at: "2026-01-02T00:00:00Z",
          }),
        });
      }
      if (url.includes("/entity-edge/owner-fragment-2")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({
            uuid: "owner-fragment-2", name: "Owner fact 2", fact: "Decision about database", created_at: "2026-01-03T00:00:00Z",
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    const recallTool = registeredTools.find((t) => t.name === "memory_recall");
    const result = await recallTool.execute("call-1", { query: "widget decisions" });

    // Should include both group results and owner fragment results
    expect(result.details.count).toBe(3);
    expect(result.details.ownerFragmentCount).toBe(2);
    expect(result.details.memories.some((m: { uuid: string }) => m.uuid === "owner-fragment-1")).toBe(true);
    expect(result.details.memories.some((m: { uuid: string }) => m.uuid === "owner-fragment-2")).toBe(true);
  });

  test("memory_recall skips owner lookup when subject is not an agent", async () => {
    const { v1 } = await import("@authzed/authzed-node");
    const mockClient = v1.NewClient();

    mockClient.promises.lookupResources = vi.fn().mockResolvedValue([
      { resourceObjectId: "main" },
    ]);

    // Reset readRelationships to track only calls from this test
    mockClient.promises.readRelationships = vi.fn().mockResolvedValue([]);

    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/search")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({ facts: [] }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const plugin = await import("./index.js");

    // Register with person subject (no agentId) — forces config fallback
    const personTools: ReturnType<typeof vi.fn>[] = [];
    const personApi = {
      ...mockApi,
      pluginConfig: {
        ...mockApi.pluginConfig,
        subjectType: "person",
        subjectId: "U0123ABC",
      },
      registerTool: vi.fn((toolOrFactory: unknown, _meta?: unknown) => {
        if (typeof toolOrFactory === "function") {
          // No agentId → falls back to config person subject
          const tool = (toolOrFactory as Function)({ agentId: undefined });
          personTools.push(tool);
        }
      }),
      registerCli: mockApi.registerCli,
      registerService: mockApi.registerService,
      on: mockApi.on,
      logger: mockApi.logger,
    };

    await plugin.default.register(personApi);

    const recallTool = personTools.find((t: { name: string }) => t.name === "memory_recall");
    const result = await recallTool.execute("call-1", { query: "test" });

    // readRelationships should NOT have been called (no owner lookup for person subjects)
    expect(mockClient.promises.readRelationships).not.toHaveBeenCalled();
  });

  // ==========================================================================

  test("CLI registration calls backend-agnostic registerCommands", async () => {
    const plugin = await import("./index.js");
    await plugin.default.register(mockApi);

    const cliHandler = registeredClis[0];
    const mockCmd: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const m of ["command", "description", "argument", "option", "action"]) {
      mockCmd[m] = vi.fn().mockReturnValue(mockCmd);
    }
    const mockProgram = {
      command: vi.fn().mockReturnValue(mockCmd),
    };

    cliHandler({ program: mockProgram });

    expect(mockProgram.command).toHaveBeenCalledWith("rebac-mem");
  });
});
