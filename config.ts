/**
 * Unified configuration for openclaw-memory-rebac.
 *
 * backend: "graphiti" — Graphiti REST knowledge graph
 *
 * Backend-specific config lives under the graphiti key.
 */

import type { MemoryBackend } from "./backend.js";
import { GraphitiBackend } from "./backends/graphiti.js";
import type { GraphitiConfig } from "./backends/graphiti.js";

// ============================================================================
// Config type
// ============================================================================

export type { GraphitiConfig };

export type RebacMemoryConfig = {
  backend: "graphiti";
  spicedb: {
    endpoint: string;
    token: string;
    insecure: boolean;
  };
  graphiti: GraphitiConfig;
  subjectType: "agent" | "person";
  subjectId: string;
  autoCapture: boolean;
  autoRecall: boolean;
  customInstructions: string;
  maxCaptureMessages: number;
};

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_SPICEDB_ENDPOINT = "localhost:50051";
const DEFAULT_GRAPHITI_ENDPOINT = "http://localhost:8000";
const DEFAULT_GROUP_ID = "main";
const DEFAULT_UUID_POLL_INTERVAL_MS = 3000;
const DEFAULT_UUID_POLL_MAX_ATTEMPTS = 60;
const DEFAULT_SUBJECT_TYPE = "agent";
const DEFAULT_MAX_CAPTURE_MESSAGES = 10;

const DEFAULT_CUSTOM_INSTRUCTIONS = `Extract key facts about:
- Identity: names, roles, titles, contact info
- Preferences: likes, dislikes, preferred tools/methods
- Goals: objectives, plans, deadlines
- Relationships: connections between people, teams, organizations
- Decisions: choices made, reasoning, outcomes
- Routines: habits, schedules, recurring patterns
Do not extract: greetings, filler, meta-commentary about the conversation itself.`;

// ============================================================================
// Helpers
// ============================================================================

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
  }
}

// ============================================================================
// Config schema
// ============================================================================

export const rebacMemoryConfigSchema = {
  parse(value: unknown): RebacMemoryConfig {
    if (Array.isArray(value)) {
      throw new Error("openclaw-memory-rebac config must be an object, not an array");
    }
    const cfg = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      [
        "backend", "spicedb", "graphiti",
        "subjectType", "subjectId",
        "autoCapture", "autoRecall", "customInstructions", "maxCaptureMessages",
      ],
      "openclaw-memory-rebac config",
    );

    const backend = "graphiti" as const;

    // SpiceDB config (shared)
    const spicedb = (cfg.spicedb as Record<string, unknown>) ?? {};
    assertAllowedKeys(spicedb, ["endpoint", "token", "insecure"], "spicedb config");

    // Graphiti config
    const graphitiRaw = (cfg.graphiti as Record<string, unknown>) ?? {};
    assertAllowedKeys(
      graphitiRaw,
      ["endpoint", "defaultGroupId", "uuidPollIntervalMs", "uuidPollMaxAttempts", "requestTimeoutMs"],
      "graphiti config",
    );

    const subjectType = cfg.subjectType === "person" ? "person" : DEFAULT_SUBJECT_TYPE;
    const subjectId =
      typeof cfg.subjectId === "string" ? resolveEnvVars(cfg.subjectId) : "default";

    const graphitiConfig: GraphitiConfig = {
      endpoint:
        typeof graphitiRaw.endpoint === "string"
          ? graphitiRaw.endpoint
          : DEFAULT_GRAPHITI_ENDPOINT,
      defaultGroupId:
        typeof graphitiRaw.defaultGroupId === "string"
          ? graphitiRaw.defaultGroupId
          : DEFAULT_GROUP_ID,
      uuidPollIntervalMs:
        typeof graphitiRaw.uuidPollIntervalMs === "number" && graphitiRaw.uuidPollIntervalMs > 0
          ? graphitiRaw.uuidPollIntervalMs
          : DEFAULT_UUID_POLL_INTERVAL_MS,
      uuidPollMaxAttempts:
        typeof graphitiRaw.uuidPollMaxAttempts === "number" && graphitiRaw.uuidPollMaxAttempts > 0
          ? Math.round(graphitiRaw.uuidPollMaxAttempts)
          : DEFAULT_UUID_POLL_MAX_ATTEMPTS,
      requestTimeoutMs:
        typeof graphitiRaw.requestTimeoutMs === "number" && graphitiRaw.requestTimeoutMs > 0
          ? graphitiRaw.requestTimeoutMs
          : 30000,
    };

    return {
      backend,
      spicedb: {
        endpoint:
          typeof spicedb.endpoint === "string" ? spicedb.endpoint : DEFAULT_SPICEDB_ENDPOINT,
        token: typeof spicedb.token === "string" ? resolveEnvVars(spicedb.token) : "",
        insecure: spicedb.insecure !== false,
      },
      graphiti: graphitiConfig,
      subjectType,
      subjectId,
      autoCapture: cfg.autoCapture !== false,
      autoRecall: cfg.autoRecall !== false,
      customInstructions:
        typeof cfg.customInstructions === "string"
          ? cfg.customInstructions
          : DEFAULT_CUSTOM_INSTRUCTIONS,
      maxCaptureMessages:
        typeof cfg.maxCaptureMessages === "number" && cfg.maxCaptureMessages > 0
          ? cfg.maxCaptureMessages
          : DEFAULT_MAX_CAPTURE_MESSAGES,
    };
  },
};

// ============================================================================
// Backend factory
// ============================================================================

/**
 * Instantiate the configured MemoryBackend from the parsed config.
 * Call this once during plugin registration — the returned backend is stateful.
 */
export function createBackend(cfg: RebacMemoryConfig): MemoryBackend {
  if (!cfg.graphiti) throw new Error("graphiti config is required");
  return new GraphitiBackend(cfg.graphiti);
}

/**
 * Return the default group ID for the active backend.
 */
export function defaultGroupId(cfg: RebacMemoryConfig): string {
  return cfg.graphiti?.defaultGroupId ?? "main";
}
