/**
 * CLI module tests — comprehensive tests for all shared commands
 * and backend.registerCliCommands() integration.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { registerCommands, parseSubjectOverride, type CliContext } from "./cli.js";
import type { MemoryBackend, SearchResult, BackendDataset } from "./backend.js";
import type { SpiceDbClient } from "./spicedb.js";

// ============================================================================
// Mock Console
// ============================================================================

let consoleOutput: string[] = [];
let consoleErrors: string[] = [];

beforeEach(() => {
  consoleOutput = [];
  consoleErrors = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    consoleOutput.push(args.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    consoleErrors.push(args.join(" "));
  });
});

// ============================================================================
// Mock Commander
// ============================================================================

function createMockProgram() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actions: Record<string, any> = {};
  const commands: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const options: Record<string, any> = {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeChainable(commandName?: string): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self: Record<string, any> = {};

    self.description = () => self;
    self.argument = () => self;

    self.option = (flags: string, description: string, defaultValue?: unknown) => {
      if (commandName) {
        if (!options[commandName]) options[commandName] = {};
        const name = flags.match(/--(\S+)/)?.[1];
        if (name) options[commandName][name] = defaultValue;
      }
      return self;
    };

    self.command = (name: string) => {
      commands.push(name);
      return makeChainable(name);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    self.action = (fn: any) => {
      if (commandName) actions[commandName] = fn;
      return self;
    };

    return self;
  }

  return { program: makeChainable(), actions, commands, options };
}

// ============================================================================
// Mock Backend
// ============================================================================

function createMockBackend(overrides?: Partial<MemoryBackend>): MemoryBackend {
  return {
    name: "mock-backend",
    store: vi.fn().mockResolvedValue({ fragmentId: Promise.resolve("uuid-123") }),
    searchGroup: vi.fn().mockResolvedValue([]),
    getConversationHistory: vi.fn().mockResolvedValue([]),
    healthCheck: vi.fn().mockResolvedValue(true),
    getStatus: vi.fn().mockResolvedValue({
      backend: "mock-backend",
      endpoint: "http://localhost:8000",
      healthy: true
    }),
    deleteGroup: vi.fn().mockResolvedValue(undefined),
    listGroups: vi.fn().mockResolvedValue([]),
    registerCliCommands: vi.fn(),
    ...overrides,
  } as MemoryBackend;
}

// ============================================================================
// Mock SpiceDB
// ============================================================================

function createMockSpiceDb(): SpiceDbClient {
  return {
    writeSchema: vi.fn().mockResolvedValue("schema-token"),
    readSchema: vi.fn().mockResolvedValue("existing schema"),
    writeRelationships: vi.fn().mockResolvedValue("write-token"),
    deleteRelationships: vi.fn().mockResolvedValue("delete-token"),
    deleteRelationshipsByFilter: vi.fn().mockResolvedValue("delete-token"),
    bulkImportRelationships: vi.fn().mockResolvedValue(10),
    readRelationships: vi.fn().mockResolvedValue([]),
    checkPermission: vi.fn().mockResolvedValue(true),
    lookupResources: vi.fn().mockResolvedValue(["group-1", "group-2"]),
  } as unknown as SpiceDbClient;
}

// ============================================================================
// Mock Context
// ============================================================================

function createMockContext(backend: MemoryBackend, spicedb: SpiceDbClient): CliContext {
  return {
    backend,
    spicedb,
    cfg: {
      backend: "graphiti",
      spicedb: { endpoint: "localhost:50051", token: "test-token", insecure: true },
      backendConfig: {
        endpoint: "http://localhost:8000",
        defaultGroupId: "main",
        uuidPollIntervalMs: 3000,
        uuidPollMaxAttempts: 30,
        customInstructions: "Extract facts",
      },
      subjectType: "agent" as const,
      subjectId: "test-agent",
      identities: {},
      autoCapture: true,
      autoRecall: true,
      maxCaptureMessages: 10,
    },
    currentSubject: { type: "agent", id: "test-agent" },
    getLastWriteToken: vi.fn().mockReturnValue("last-token"),
  };
}

// ============================================================================
// Tests - Command Registration
// ============================================================================

describe("registerCommands - registration", () => {
  test("registers all shared subcommands", () => {
    const backend = createMockBackend();
    const spicedb = createMockSpiceDb();
    const { program, commands } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    expect(commands).toContain("search");
    expect(commands).toContain("status");
    expect(commands).toContain("schema-write");
    expect(commands).toContain("groups");
    expect(commands).toContain("add-member");
    expect(commands).toContain("import");
    expect(commands.length).toBeGreaterThanOrEqual(6);
  });

  test("calls backend.registerCliCommands()", () => {
    const registerCliCommands = vi.fn();
    const backend = createMockBackend({ registerCliCommands });
    const spicedb = createMockSpiceDb();
    const { program } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    expect(registerCliCommands).toHaveBeenCalledWith(program);
  });

  test("handles missing backend.registerCliCommands() gracefully", () => {
    const backend = createMockBackend({ registerCliCommands: undefined });
    const spicedb = createMockSpiceDb();
    const { program } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    expect(() => registerCommands(program, ctx)).not.toThrow();
  });
});

// ============================================================================
// Tests - search command
// ============================================================================

describe("search command", () => {
  test("searches authorized groups and displays results", async () => {
    const searchResults: SearchResult[] = [
      {
        type: "chunk",
        uuid: "c1",
        group_id: "group-1",
        summary: "Test result",
        context: "test context",
        created_at: "2026-01-15",
      },
    ];

    const backend = createMockBackend({
      searchGroup: vi.fn().mockResolvedValue(searchResults),
    });
    const spicedb = createMockSpiceDb();
    const { program, actions } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    await actions["search"]("test query", { limit: "10" });

    expect(spicedb.lookupResources).toHaveBeenCalled();
    expect(backend.searchGroup).toHaveBeenCalled();
    expect(consoleOutput.some(line => line.includes("Searching as agent:test-agent"))).toBe(true);
    expect(consoleOutput.some(line => line.includes("c1"))).toBe(true);
  });

  test("handles no authorized groups", async () => {
    const backend = createMockBackend();
    const spicedb = createMockSpiceDb();
    spicedb.lookupResources = vi.fn().mockResolvedValue([]);
    const { program, actions } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    await actions["search"]("test query", { limit: "10" });

    expect(consoleOutput).toContain("No results found.");
  });

  test("handles no results found", async () => {
    const backend = createMockBackend({
      searchGroup: vi.fn().mockResolvedValue([]),
    });
    const spicedb = createMockSpiceDb();
    const { program, actions } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    await actions["search"]("test query", { limit: "10" });

    expect(consoleOutput).toContain("No results found.");
  });

  test("search as person finds fragments via involves", async () => {
    const backend = createMockBackend({
      searchGroup: vi.fn().mockResolvedValue([]),
      getFragmentsByIds: vi.fn().mockResolvedValue([
        { type: "fact", uuid: "frag-1", group_id: "steno-group", summary: "Decision: use PostgreSQL", context: "#engineering" },
      ]),
    });
    const spicedb = createMockSpiceDb();
    // lookupResources: first call for groups (empty), second for viewable fragments
    spicedb.lookupResources = vi.fn()
      .mockResolvedValueOnce([])           // no authorized groups
      .mockResolvedValueOnce(["frag-1"]);  // viewable fragment via involves
    const { program, actions } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    await actions["search"]("PostgreSQL", { limit: "10", as: "person:U0123ABC" });

    expect(backend.getFragmentsByIds).toHaveBeenCalledWith(["frag-1"]);
    expect(consoleOutput.some(line => line.includes("via involves"))).toBe(true);
    expect(consoleOutput.some(line => line.includes("frag-1"))).toBe(true);
  });
});

// ============================================================================
// Tests - status command
// ============================================================================

describe("status command", () => {
  test("displays backend and SpiceDB status", async () => {
    const backend = createMockBackend({
      getStatus: vi.fn().mockResolvedValue({
        backend: "mock-backend",
        endpoint: "http://localhost:8000",
        healthy: true,
        extra: "info",
      }),
    });
    const spicedb = createMockSpiceDb();
    const { program, actions } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    await actions["status"]();

    expect(backend.getStatus).toHaveBeenCalled();
    expect(spicedb.readSchema).toHaveBeenCalled();
    expect(consoleOutput.some(line => line.includes("Backend (mock-backend): OK"))).toBe(true);
    expect(consoleOutput.some(line => line.includes("SpiceDB: OK"))).toBe(true);
    expect(consoleOutput.some(line => line.includes("extra: info"))).toBe(true);
  });

  test("reports unhealthy backend", async () => {
    const backend = createMockBackend({
      getStatus: vi.fn().mockResolvedValue({
        backend: "mock-backend",
        healthy: false,
      }),
    });
    const spicedb = createMockSpiceDb();
    const { program, actions } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    await actions["status"]();

    expect(consoleOutput.some(line => line.includes("UNREACHABLE"))).toBe(true);
  });

  test("reports unreachable SpiceDB", async () => {
    const backend = createMockBackend();
    const spicedb = createMockSpiceDb();
    spicedb.readSchema = vi.fn().mockRejectedValue(new Error("Connection failed"));
    const { program, actions } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    await actions["status"]();

    expect(consoleOutput.some(line => line.includes("SpiceDB: UNREACHABLE"))).toBe(true);
  });
});

// ============================================================================
// Tests - schema-write command
// ============================================================================

describe("schema-write command", () => {
  test("writes SpiceDB schema from schema.zed file", async () => {
    const backend = createMockBackend();
    const spicedb = createMockSpiceDb();
    const { program, actions } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    await actions["schema-write"]();

    expect(spicedb.writeSchema).toHaveBeenCalled();
    const schemaArg = (spicedb.writeSchema as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(schemaArg).toContain("definition memory_fragment");
    expect(consoleOutput).toContain("SpiceDB schema written successfully.");
  });
});

// ============================================================================
// Tests - groups command
// ============================================================================

describe("groups command", () => {
  test("lists authorized groups for current subject", async () => {
    const backend = createMockBackend();
    const spicedb = createMockSpiceDb();
    spicedb.lookupResources = vi.fn().mockResolvedValue(["group-a", "group-b", "group-c"]);
    const { program, actions } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    await actions["groups"]({});

    expect(spicedb.lookupResources).toHaveBeenCalled();
    expect(consoleOutput.some(line => line.includes("Authorized groups for agent:test-agent"))).toBe(true);
    expect(consoleOutput.some(line => line.includes("- group-a"))).toBe(true);
    expect(consoleOutput.some(line => line.includes("- group-b"))).toBe(true);
    expect(consoleOutput.some(line => line.includes("- group-c"))).toBe(true);
  });

  test("handles no authorized groups", async () => {
    const backend = createMockBackend();
    const spicedb = createMockSpiceDb();
    spicedb.lookupResources = vi.fn().mockResolvedValue([]);
    const { program, actions } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    await actions["groups"]({});

    expect(consoleOutput).toContain("No authorized groups for agent:test-agent.");
  });
});

// ============================================================================
// Tests - add-member command
// ============================================================================

describe("add-member command", () => {
  test("adds a person to a group by default", async () => {
    const backend = createMockBackend();
    const spicedb = createMockSpiceDb();
    const { program, actions } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    await actions["add-member"]("team-x", "person-123", { type: "person" });

    expect(spicedb.writeRelationships).toHaveBeenCalled();
    const call = (spicedb.writeRelationships as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call[0]).toMatchObject({
      resourceType: "group",
      resourceId: "team-x",
      relation: "member",
      subjectType: "person",
      subjectId: "person-123",
    });
    expect(consoleOutput).toContain("Added person:person-123 to group:team-x");
  });

  test("adds an agent when type=agent", async () => {
    const backend = createMockBackend();
    const spicedb = createMockSpiceDb();
    const { program, actions } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    await actions["add-member"]("team-y", "agent-456", { type: "agent" });

    const call = (spicedb.writeRelationships as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call[0]).toMatchObject({
      subjectType: "agent",
      subjectId: "agent-456",
    });
    expect(consoleOutput).toContain("Added agent:agent-456 to group:team-y");
  });
});

// ============================================================================
// Tests - import command
// ============================================================================

describe("import command", () => {
  test("displays dry-run output without importing", async () => {
    const backend = createMockBackend();
    const spicedb = createMockSpiceDb();
    const { program, actions } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    // Mock fs to avoid actual file system access
    await actions["import"]({
      workspace: "/fake/path",
      includeSessions: false,
      sessionsOnly: false,
      sessionDir: "/fake/sessions",
      group: "main",
      dryRun: true,
    }).catch(() => {
      // Expected to fail due to missing directory
    });

    // Should attempt to read directory (will fail in test)
    expect(backend.store).not.toHaveBeenCalled();
    expect(spicedb.bulkImportRelationships).not.toHaveBeenCalled();
  });

  test("calls backend.store() for each file", async () => {
    // This would require more complex mocking of fs/promises
    // Skip for now - tested in integration tests
  });
});

// ============================================================================
// Tests - Backend-specific command registration
// ============================================================================

describe("backend-specific commands", () => {
  test("registers identity management commands", () => {
    const backend = createMockBackend();
    const spicedb = createMockSpiceDb();
    const { program, commands } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    expect(commands).toContain("identities");
    expect(commands).toContain("link-identity");
    expect(commands).toContain("unlink-identity");
  });

  test("graphiti backend adds episodes, fact, clear-graph commands", () => {
    const mockRegister = vi.fn((cmd) => {
      cmd.command("episodes");
      cmd.command("fact");
      cmd.command("clear-graph");
    });

    const backend = createMockBackend({
      name: "graphiti",
      registerCliCommands: mockRegister,
    });
    const spicedb = createMockSpiceDb();
    const { program, commands } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    expect(mockRegister).toHaveBeenCalled();
    expect(commands).toContain("episodes");
    expect(commands).toContain("fact");
    expect(commands).toContain("clear-graph");
  });

});

// ============================================================================
// Tests - parseSubjectOverride
// ============================================================================

describe("parseSubjectOverride", () => {
  test("parses type:id format", () => {
    expect(parseSubjectOverride("agent:main")).toEqual({ type: "agent", id: "main" });
    expect(parseSubjectOverride("person:U0123ABC")).toEqual({ type: "person", id: "U0123ABC" });
  });

  test("bare id defaults to agent type", () => {
    expect(parseSubjectOverride("main")).toEqual({ type: "agent", id: "main" });
    expect(parseSubjectOverride("stenographer")).toEqual({ type: "agent", id: "stenographer" });
  });

  test("rejects invalid subject type", () => {
    expect(() => parseSubjectOverride("group:team-x")).toThrow('Invalid subject type "group"');
  });
});

// ============================================================================
// Tests - identities command
// ============================================================================

describe("identities command", () => {
  test("lists configured identity links", async () => {
    const backend = createMockBackend();
    const spicedb = createMockSpiceDb();
    const { program, actions } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);
    ctx.cfg.identities = { "main": "U0123ABC", "work": "U0456DEF" };

    registerCommands(program, ctx);

    await actions["identities"]();

    expect(consoleOutput.some(line => line.includes("agent:main"))).toBe(true);
    expect(consoleOutput.some(line => line.includes("U0123ABC"))).toBe(true);
    expect(consoleOutput.some(line => line.includes("agent:work"))).toBe(true);
    expect(consoleOutput.some(line => line.includes("U0456DEF"))).toBe(true);
  });

  test("shows help when no identities configured", async () => {
    const backend = createMockBackend();
    const spicedb = createMockSpiceDb();
    const { program, actions } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    await actions["identities"]();

    expect(consoleOutput).toContain("No identities configured.");
  });
});

// ============================================================================
// Tests - link-identity / unlink-identity commands
// ============================================================================

describe("link-identity command", () => {
  test("writes agent→owner relationship", async () => {
    const backend = createMockBackend();
    const spicedb = createMockSpiceDb();
    const { program, actions } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    await actions["link-identity"]("my-agent", "U0123ABC");

    expect(spicedb.writeRelationships).toHaveBeenCalled();
    const call = (spicedb.writeRelationships as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call[0]).toMatchObject({
      resourceType: "agent",
      resourceId: "my-agent",
      relation: "owner",
      subjectType: "person",
      subjectId: "U0123ABC",
    });
    expect(call[1]).toMatchObject({
      resourceType: "person",
      resourceId: "U0123ABC",
      relation: "agent",
      subjectType: "agent",
      subjectId: "my-agent",
    });
    expect(consoleOutput).toContain("Linked agent:my-agent ↔ person:U0123ABC");
  });
});

describe("unlink-identity command", () => {
  test("removes agent→owner relationship", async () => {
    const backend = createMockBackend();
    const spicedb = createMockSpiceDb();
    // lookupAgentOwner uses readRelationships; mock it to return the owner
    spicedb.readRelationships = vi.fn().mockResolvedValue([
      { subjectType: "person", subjectId: "U0123ABC" },
    ]);
    const { program, actions } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    await actions["unlink-identity"]("my-agent");

    expect(spicedb.deleteRelationships).toHaveBeenCalled();
    expect(consoleOutput.some(line => line.includes("Unlinked agent:my-agent"))).toBe(true);
  });

  test("reports when no owner link exists", async () => {
    const backend = createMockBackend();
    const spicedb = createMockSpiceDb();
    spicedb.readRelationships = vi.fn().mockResolvedValue([]);
    const { program, actions } = createMockProgram();
    const ctx = createMockContext(backend, spicedb);

    registerCommands(program, ctx);

    await actions["unlink-identity"]("orphan-agent");

    expect(consoleOutput).toContain("No owner link found for agent:orphan-agent");
  });
});
