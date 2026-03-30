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
  /** Liminal backend name for hook-driven auto-recall/capture. Defaults to `backend`. */
  liminal: string;
  /** True when liminal differs from backend (hybrid mode: separate backends for hooks vs tools). */
  isHybrid: boolean;
  spicedb: {
    endpoint: string;
    token: string;
    insecure: boolean;
  };
  backendConfig: Record<string, unknown>;
  /** Liminal backend config (same as backendConfig when unified, separate in hybrid mode). */
  liminalConfig: Record<string, unknown>;
  subjectType: "agent" | "person";
  subjectId: string;
  /** Maps agent IDs to their owner person IDs (e.g., Slack user IDs). */
  identities: Record<string, string>;
  /** Maps group IDs to their owner person IDs (for admin-level sharing). */
  groupOwners: Record<string, string[]>;
  autoCapture: boolean;
  autoRecall: boolean;
  maxCaptureMessages: number;
  sessionFilter?: {
    excludePatterns?: string[];
    includePatterns?: string[];
  };
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

function parseSessionFilter(raw: unknown): RebacMemoryConfig["sessionFilter"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  assertAllowedKeys(obj, ["excludePatterns", "includePatterns"], "sessionFilter config");
  const excludePatterns = Array.isArray(obj.excludePatterns)
    ? obj.excludePatterns.filter((p): p is string => typeof p === "string")
    : undefined;
  const includePatterns = Array.isArray(obj.includePatterns)
    ? obj.includePatterns.filter((p): p is string => typeof p === "string")
    : undefined;
  if (!excludePatterns?.length && !includePatterns?.length) return undefined;
  return { excludePatterns, includePatterns };
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

    // Liminal backend: defaults to the primary backend (unified mode).
    // Set to a different backend name for hybrid mode (e.g., "evermemos").
    const liminalName =
      typeof cfg.liminal === "string" ? cfg.liminal : backendName;
    const liminalEntry = backendRegistry[liminalName];
    if (!liminalEntry) throw new Error(`Unknown liminal backend: "${liminalName}"`);
    const isHybrid = liminalName !== backendName;

    // Top-level allowed keys: shared keys + backend name keys
    const allowedKeys = [
      "backend", "liminal", "spicedb",
      "subjectType", "subjectId", "identities", "groupOwners",
      "autoCapture", "autoRecall", "maxCaptureMessages", "sessionFilter",
      backendName,
    ];
    if (isHybrid) allowedKeys.push(liminalName);
    assertAllowedKeys(cfg, allowedKeys, "openclaw-memory-rebac config");

    // SpiceDB config (shared)
    const spicedb = (cfg.spicedb as Record<string, unknown>) ?? {};
    assertAllowedKeys(spicedb, ["endpoint", "token", "insecure"], "spicedb config");

    // Primary backend config: user overrides merged over JSON defaults
    const backendRaw = (cfg[backendName] as Record<string, unknown>) ?? {};
    assertAllowedKeys(backendRaw, Object.keys(entry.defaults), `${backendName} config`);
    const backendConfig = { ...entry.defaults, ...backendRaw };

    // Liminal backend config: same as primary in unified mode, separate in hybrid
    let liminalConfig: Record<string, unknown>;
    if (isHybrid) {
      const liminalRaw = (cfg[liminalName] as Record<string, unknown>) ?? {};
      assertAllowedKeys(liminalRaw, Object.keys(liminalEntry.defaults), `${liminalName} config`);
      liminalConfig = { ...liminalEntry.defaults, ...liminalRaw };
    } else {
      liminalConfig = backendConfig;
    }

    const subjectType =
      cfg.subjectType === "person" ? "person" : (pluginDefaults.subjectType as "agent" | "person");
    const subjectId =
      typeof cfg.subjectId === "string" ? resolveEnvVars(cfg.subjectId) : pluginDefaults.subjectId;

    // Parse identities: { "main": "U0123ABC", "work": "U0456DEF" }
    const identitiesRaw = cfg.identities;
    const identities: Record<string, string> = {};
    if (identitiesRaw && typeof identitiesRaw === "object" && !Array.isArray(identitiesRaw)) {
      for (const [agentId, personId] of Object.entries(identitiesRaw as Record<string, unknown>)) {
        if (typeof personId === "string" && personId.trim()) {
          identities[agentId] = personId.trim();
        }
      }
    }

    // Parse groupOwners: { "slack-engineering": ["U0123", "U0456"] }
    const groupOwnersRaw = cfg.groupOwners;
    const groupOwners: Record<string, string[]> = {};
    if (groupOwnersRaw && typeof groupOwnersRaw === "object" && !Array.isArray(groupOwnersRaw)) {
      for (const [groupId, owners] of Object.entries(groupOwnersRaw as Record<string, unknown>)) {
        if (Array.isArray(owners)) {
          groupOwners[groupId] = owners.filter((o): o is string => typeof o === "string" && o.trim() !== "");
        } else if (typeof owners === "string" && owners.trim()) {
          groupOwners[groupId] = [owners.trim()];
        }
      }
    }

    return {
      backend: backendName,
      liminal: liminalName,
      isHybrid,
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
      liminalConfig,
      subjectType,
      subjectId,
      identities,
      groupOwners,
      autoCapture: cfg.autoCapture !== false,
      autoRecall: cfg.autoRecall !== false,
      maxCaptureMessages:
        typeof cfg.maxCaptureMessages === "number" && cfg.maxCaptureMessages > 0
          ? cfg.maxCaptureMessages
          : pluginDefaults.maxCaptureMessages,
      sessionFilter: parseSessionFilter(cfg.sessionFilter),
    };
  },
};

// ============================================================================
// Backend factory
// ============================================================================

/**
 * Instantiate the primary MemoryBackend (used for tools + SpiceDB auth).
 * Call this once during plugin registration — the returned backend is stateful.
 */
export function createBackend(cfg: RebacMemoryConfig): MemoryBackend {
  const entry = backendRegistry[cfg.backend];
  if (!entry) throw new Error(`Unknown backend: "${cfg.backend}"`);
  return entry.create(cfg.backendConfig);
}

/**
 * Instantiate the liminal MemoryBackend (used for hook-driven auto-recall/capture).
 * In unified mode (liminal === backend), callers should reuse the primary instance.
 * In hybrid mode, this creates a separate instance from the liminal backend's config.
 */
export function createLiminalBackend(cfg: RebacMemoryConfig): MemoryBackend {
  const entry = backendRegistry[cfg.liminal];
  if (!entry) throw new Error(`Unknown liminal backend: "${cfg.liminal}"`);
  return entry.create(cfg.liminalConfig);
}

/**
 * Return the default group ID for the active backend.
 */
export function defaultGroupId(cfg: RebacMemoryConfig): string {
  return (cfg.backendConfig["defaultGroupId"] as string) ?? "main";
}
