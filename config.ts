/**
 * Unified configuration for openclaw-memory-rebac.
 *
 * Backend-specific defaults live in backends/<name>.defaults.json.
 * Available backends are listed in backends/backends.json.
 * No backend names appear in this file.
 */

import type { MemoryBackend } from "./backend.js";
import { backendRegistry } from "./backends/registry.js";
import pluginDefaults from "./plugin.defaults.json" with { type: "json" };

// ============================================================================
// Config type
// ============================================================================

export type RebacMemoryConfig = {
  backend: string;
  spicedb: {
    endpoint: string;
    token: string;
    insecure: boolean;
  };
  backendConfig: Record<string, unknown>;
  subjectType: "agent" | "person";
  subjectId: string;
  autoCapture: boolean;
  autoRecall: boolean;
  maxCaptureMessages: number;
};

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

    const backendName =
      typeof cfg.backend === "string" ? cfg.backend : pluginDefaults.backend;

    const entry = backendRegistry[backendName];
    if (!entry) throw new Error(`Unknown backend: "${backendName}"`);

    // Top-level allowed keys: shared keys + the backend name key
    assertAllowedKeys(
      cfg,
      [
        "backend", "spicedb",
        "subjectType", "subjectId",
        "autoCapture", "autoRecall", "maxCaptureMessages",
        backendName,
      ],
      "openclaw-memory-rebac config",
    );

    // SpiceDB config (shared)
    const spicedb = (cfg.spicedb as Record<string, unknown>) ?? {};
    assertAllowedKeys(spicedb, ["endpoint", "token", "insecure"], "spicedb config");

    // Backend config: user overrides merged over JSON defaults
    const backendRaw = (cfg[backendName] as Record<string, unknown>) ?? {};
    assertAllowedKeys(backendRaw, Object.keys(entry.defaults), `${backendName} config`);
    const backendConfig = { ...entry.defaults, ...backendRaw };

    const subjectType =
      cfg.subjectType === "person" ? "person" : (pluginDefaults.subjectType as "agent" | "person");
    const subjectId =
      typeof cfg.subjectId === "string" ? resolveEnvVars(cfg.subjectId) : pluginDefaults.subjectId;

    return {
      backend: backendName,
      spicedb: {
        endpoint:
          typeof spicedb.endpoint === "string"
            ? spicedb.endpoint
            : pluginDefaults.spicedb.endpoint,
        token: typeof spicedb.token === "string" ? resolveEnvVars(spicedb.token) : "",
        insecure:
          typeof spicedb.insecure === "boolean"
            ? spicedb.insecure
            : pluginDefaults.spicedb.insecure,
      },
      backendConfig,
      subjectType,
      subjectId,
      autoCapture: cfg.autoCapture !== false,
      autoRecall: cfg.autoRecall !== false,
      maxCaptureMessages:
        typeof cfg.maxCaptureMessages === "number" && cfg.maxCaptureMessages > 0
          ? cfg.maxCaptureMessages
          : pluginDefaults.maxCaptureMessages,
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
  const entry = backendRegistry[cfg.backend];
  if (!entry) throw new Error(`Unknown backend: "${cfg.backend}"`);
  return entry.create(cfg.backendConfig);
}

/**
 * Return the default group ID for the active backend.
 */
export function defaultGroupId(cfg: RebacMemoryConfig): string {
  return (cfg.backendConfig["defaultGroupId"] as string) ?? "main";
}
