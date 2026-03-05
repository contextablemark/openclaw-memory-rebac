import { describe, test, expect, beforeAll } from "vitest";
import { rebacMemoryConfigSchema, createBackend, defaultGroupId } from "./config.js";
import { GraphitiBackend } from "./backends/graphiti.js";
import { initRegistry } from "./backends/registry.js";

beforeAll(async () => { await initRegistry(); });

describe("rebacMemoryConfigSchema", () => {
  test("parses minimal config with defaults", () => {
    const cfg = rebacMemoryConfigSchema.parse({});
    expect(cfg.backend).toBe("graphiti");
    expect(cfg.spicedb.endpoint).toBe("localhost:50051");
    expect(cfg.spicedb.insecure).toBe(true);
    expect(cfg.subjectType).toBe("agent");
    expect(cfg.autoCapture).toBe(true);
    expect(cfg.autoRecall).toBe(true);
  });

  test("parses backend=graphiti", () => {
    const cfg = rebacMemoryConfigSchema.parse({ backend: "graphiti" });
    expect(cfg.backend).toBe("graphiti");
    expect(cfg.backendConfig["endpoint"]).toBe("http://localhost:8000");
  });

  test("accepts graphiti sub-config", () => {
    const cfg = rebacMemoryConfigSchema.parse({
      backend: "graphiti",
      graphiti: {
        endpoint: "http://graphiti:9000",
        defaultGroupId: "team-x",
        uuidPollIntervalMs: 5000,
        uuidPollMaxAttempts: 50,
      },
    });
    expect(cfg.backendConfig["endpoint"]).toBe("http://graphiti:9000");
    expect(cfg.backendConfig["defaultGroupId"]).toBe("team-x");
    expect(cfg.backendConfig["uuidPollIntervalMs"]).toBe(5000);
    expect(cfg.backendConfig["uuidPollMaxAttempts"]).toBe(50);
  });

  test("accepts spicedb config", () => {
    const cfg = rebacMemoryConfigSchema.parse({
      spicedb: {
        endpoint: "spicedb:50051",
        token: "secret-token",
        insecure: false,
      },
    });
    expect(cfg.spicedb.endpoint).toBe("spicedb:50051");
    expect(cfg.spicedb.token).toBe("secret-token");
    expect(cfg.spicedb.insecure).toBe(false);
  });

  test("resolves environment variables in token", () => {
    process.env.TEST_TOKEN = "resolved-token";
    const cfg = rebacMemoryConfigSchema.parse({
      spicedb: { token: "${TEST_TOKEN}" },
    });
    expect(cfg.spicedb.token).toBe("resolved-token");
    delete process.env.TEST_TOKEN;
  });

  test("resolves environment variables in subjectId", () => {
    process.env.TEST_SUBJECT_ID = "agent-123";
    const cfg = rebacMemoryConfigSchema.parse({
      subjectId: "${TEST_SUBJECT_ID}",
    });
    expect(cfg.subjectId).toBe("agent-123");
    delete process.env.TEST_SUBJECT_ID;
  });

  test("throws on missing environment variable", () => {
    expect(() =>
      rebacMemoryConfigSchema.parse({ spicedb: { token: "${MISSING_VAR}" } }),
    ).toThrow("Environment variable MISSING_VAR is not set");
  });

  test("accepts subjectType person", () => {
    const cfg = rebacMemoryConfigSchema.parse({ subjectType: "person" });
    expect(cfg.subjectType).toBe("person");
  });

  test("defaults to agent subjectType", () => {
    const cfg = rebacMemoryConfigSchema.parse({ subjectType: "invalid" });
    expect(cfg.subjectType).toBe("agent");
  });

  test("accepts graphiti custom instructions", () => {
    const cfg = rebacMemoryConfigSchema.parse({
      graphiti: { customInstructions: "Extract only technical details" },
    });
    expect(cfg.backendConfig["customInstructions"]).toBe("Extract only technical details");
  });

  test("defaults graphiti customInstructions to empty string", () => {
    const cfg = rebacMemoryConfigSchema.parse({});
    expect(cfg.backendConfig["customInstructions"]).toBe("");
  });

  test("accepts maxCaptureMessages", () => {
    const cfg = rebacMemoryConfigSchema.parse({ maxCaptureMessages: 20 });
    expect(cfg.maxCaptureMessages).toBe(20);
  });

  test("rejects unknown top-level keys", () => {
    expect(() =>
      rebacMemoryConfigSchema.parse({ unknownKey: "value" }),
    ).toThrow("has unknown keys: unknownKey");
  });

  test("rejects unknown spicedb keys", () => {
    expect(() =>
      rebacMemoryConfigSchema.parse({ spicedb: { invalidKey: "value" } }),
    ).toThrow("spicedb config has unknown keys: invalidKey");
  });

  test("rejects unknown graphiti keys", () => {
    expect(() =>
      rebacMemoryConfigSchema.parse({ graphiti: { invalidKey: "value" } }),
    ).toThrow("graphiti config has unknown keys: invalidKey");
  });

  test("accepts array input throws error", () => {
    expect(() => rebacMemoryConfigSchema.parse([])).toThrow(
      "openclaw-memory-rebac config must be an object, not an array",
    );
  });
});

describe("createBackend", () => {
  test("creates GraphitiBackend when backend=graphiti", () => {
    const cfg = rebacMemoryConfigSchema.parse({
      backend: "graphiti",
      graphiti: { endpoint: "http://localhost:8000", defaultGroupId: "main" },
    });
    const backend = createBackend(cfg);
    expect(backend).toBeInstanceOf(GraphitiBackend);
    expect(backend.name).toBe("graphiti");
  });

  test("defaults to GraphitiBackend when backend not specified", () => {
    const cfg = rebacMemoryConfigSchema.parse({
      graphiti: { endpoint: "http://localhost:8000", defaultGroupId: "main" },
    });
    const backend = createBackend(cfg);
    expect(backend).toBeInstanceOf(GraphitiBackend);
  });

  test("throws when backendConfig missing for backend=graphiti", () => {
    const cfg = rebacMemoryConfigSchema.parse({ backend: "graphiti" });
    // Simulate missing backendConfig by using an unregistered backend name
    const badCfg = { ...cfg, backend: "nonexistent" };
    expect(() => createBackend(badCfg)).toThrow(`Unknown backend: "nonexistent"`);
  });
});

describe("defaultGroupId", () => {
  test("returns backendConfig defaultGroupId when backend=graphiti", () => {
    const cfg = rebacMemoryConfigSchema.parse({
      backend: "graphiti",
      graphiti: { defaultGroupId: "graphiti-group" },
    });
    expect(defaultGroupId(cfg)).toBe("graphiti-group");
  });

  test("falls back to 'main' when backendConfig defaultGroupId missing", () => {
    const cfg = rebacMemoryConfigSchema.parse({ backend: "graphiti" });
    const modded = { ...cfg, backendConfig: { ...cfg.backendConfig, defaultGroupId: undefined } };
    expect(defaultGroupId(modded)).toBe("main");
  });
});
