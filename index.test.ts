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
      registerTool: vi.fn((tool) => {
        registeredTools.push(tool);
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

    await expect(plugin.default.register(badApi)).rejects.toThrow("spicedb.token is not configured");
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
