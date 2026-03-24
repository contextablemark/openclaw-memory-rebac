/**
 * OpenClaw Memory (ReBAC) Plugin
 *
 * Two-layer memory architecture:
 * - SpiceDB: authorization gateway (who can see what)
 * - MemoryBackend: pluggable storage engine (Graphiti)
 *
 * SpiceDB determines which memories a subject can access.
 * The backend stores the actual knowledge and handles search.
 * Authorization is enforced at the data layer, not in prompts.
 *
 * Backend currently uses Graphiti for knowledge graph storage.
 *
 * Per-agent identity: tools and hooks derive the SpiceDB subject from
 * the runtime agentId (OpenClawPluginToolContext / PluginHookAgentContext),
 * falling back to config-level subjectType/subjectId when agentId is absent.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { rebacMemoryConfigSchema, createBackend, defaultGroupId } from "./config.js";
import { SpiceDbClient } from "./spicedb.js";
import {
  lookupAuthorizedGroups,
  lookupViewableFragments,
  lookupFragmentSourceGroups,
  lookupAgentOwner,
  writeFragmentRelationships,
  deleteFragmentRelationships,
  canDeleteFragment,
  canWriteToGroup,
  ensureGroupMembership,
  type Subject,
} from "./authorization.js";
import {
  searchAuthorizedMemories,
  formatDualResults,
} from "./search.js";
import { registerCommands } from "./cli.js";

// ============================================================================
// Session helpers
// ============================================================================

function sessionGroupId(sessionId: string): string {
  const sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `session-${sanitized}`;
}

function isSessionGroup(groupId: string): boolean {
  return groupId.startsWith("session-");
}

function isSessionAllowed(
  sessionKey: string | undefined,
  filter: import("./config.js").RebacMemoryConfig["sessionFilter"],
): boolean {
  if (!filter) return true;
  if (!sessionKey) return true;

  if (filter.excludePatterns?.length) {
    for (const pattern of filter.excludePatterns) {
      if (sessionKey.includes(pattern)) return false;
    }
  }

  if (filter.includePatterns?.length) {
    for (const pattern of filter.includePatterns) {
      if (sessionKey.includes(pattern)) return true;
    }
    return false;
  }

  return true;
}

// ============================================================================
// Content sanitization
// ============================================================================

/**
 * Strip OpenClaw envelope metadata from message text before Graphiti ingestion.
 * Removes channel headers, sender/message-id meta lines, and memory injection
 * blocks that would pollute entity extraction.
 */
export function stripEnvelopeMetadata(text: string): string {
  let result = text;

  // Strip envelope header: [ChannelName ...metadata...] at start of line
  // Matches: [Telegram Dev Chat +5m 2025-01-02T03:04Z] body
  result = result.replace(/^\[[A-Z][^\]\n]*\]\s*/gm, "");

  // Strip [from: SenderLabel] trailer lines
  result = result.replace(/^\[from:\s*[^\]]*\]\s*$/gm, "");

  // Strip [message_id: ...] hint lines
  result = result.replace(/^\[message_id:\s*[^\]]*\]\s*$/gm, "");

  // Strip memory injection blocks
  result = result.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/g, "");
  result = result.replace(/<memory-tools>[\s\S]*?<\/memory-tools>/g, "");

  // Collapse excess blank lines and trim
  result = result.replace(/\n{3,}/g, "\n\n").trim();

  return result;
}

// ============================================================================
// Per-agent state
// ============================================================================

type AgentState = {
  sessionId?: string;
  lastWriteToken?: string;
};

// ============================================================================
// Plugin Definition
// ============================================================================

const rebacMemoryPlugin = {
  id: "openclaw-memory-rebac",
  name: "Memory (ReBAC)",
  description: "Two-layer memory: SpiceDB authorization + Graphiti knowledge graph",
  kind: "memory" as const,
  configSchema: rebacMemoryConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = rebacMemoryConfigSchema.parse(api.pluginConfig);

    if (!cfg.spicedb.token) {
      throw new Error(
        'openclaw-memory-rebac: spicedb.token is not configured. Add a "config" block to ' +
        "plugins.entries.openclaw-memory-rebac in ~/.openclaw/openclaw.json:\n" +
        '  "config": { "spicedb": { "token": "<your-preshared-key>", "insecure": true } }',
      );
    }

    const backend = createBackend(cfg);
    const spicedb = new SpiceDbClient(cfg.spicedb);
    const backendDefaultGroupId = defaultGroupId(cfg);

    // Suppress transient gRPC rejections from @grpc/grpc-js during connection setup
    const grpcRejectionHandler = (reason: unknown) => {
      const msg = String(reason);
      if (msg.includes("generateMetadata") || msg.includes("grpc")) {
        api.logger.warn(`openclaw-memory-rebac: suppressed grpc-js rejection: ${msg}`);
      } else {
        throw reason;
      }
    };
    process.on("unhandledRejection", grpcRejectionHandler);
    const grpcGuardTimer = setTimeout(() => {
      process.removeListener("unhandledRejection", grpcRejectionHandler);
    }, 10_000);
    grpcGuardTimer.unref();

    // Per-agent state: keyed by agentId (falls back to cfg.subjectId)
    const agentStates = new Map<string, AgentState>();

    function resolveSubject(agentId?: string): Subject {
      if (agentId) return { type: "agent", id: agentId };
      return { type: cfg.subjectType, id: cfg.subjectId };
    }

    function getState(agentId?: string): AgentState {
      const key = agentId ?? cfg.subjectId;
      let state = agentStates.get(key);
      if (!state) {
        state = {};
        agentStates.set(key, state);
      }
      return state;
    }

    // Convenience: read state from the config-level default
    // (used by service start and CLI where no agentId is available)
    function getDefaultState(): AgentState {
      return getState(undefined);
    }

    api.logger.info(
      `openclaw-memory-rebac: registered (backend: ${backend.name}, spicedb: ${cfg.spicedb.endpoint})`,
    );

    // ========================================================================
    // Tools (registered as factories for per-agent identity)
    // ========================================================================

    api.registerTool(
      (ctx) => ({
        name: "memory_recall",
        label: "Memory Recall",
        description:
          "Search through memories using the knowledge graph. Returns results the current user is authorized to see. Supports session, long-term, or combined scope. REQUIRES a search query.",
        parameters: Type.Object({
          query: Type.String({ description: "REQUIRED: Search query for semantic matching" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
          scope: Type.Optional(
            Type.Union(
              [Type.Literal("session"), Type.Literal("long-term"), Type.Literal("all")],
              { description: "Memory scope: 'session', 'long-term', or 'all' (default)" },
            ),
          ),
        }),
        async execute(_toolCallId, params) {
          const { query, limit = 10, scope = "all" } = params as {
            query: string;
            limit?: number;
            scope?: "session" | "long-term" | "all";
          };

          const subject = resolveSubject(ctx.agentId);
          const state = getState(ctx.agentId);

          const authorizedGroups = await lookupAuthorizedGroups(spicedb, subject, state.lastWriteToken);

          let longTermGroups: string[];
          let sessionGroups: string[];

          if (scope === "session") {
            longTermGroups = [];
            sessionGroups = authorizedGroups.filter(isSessionGroup);
            if (state.sessionId) {
              const sg = sessionGroupId(state.sessionId);
              if (!sessionGroups.includes(sg)) sessionGroups.push(sg);
            }
          } else if (scope === "long-term") {
            longTermGroups = authorizedGroups.filter((g) => !isSessionGroup(g));
            sessionGroups = [];
          } else {
            longTermGroups = authorizedGroups.filter((g) => !isSessionGroup(g));
            sessionGroups = authorizedGroups.filter(isSessionGroup);
            if (state.sessionId) {
              const sg = sessionGroupId(state.sessionId);
              if (!sessionGroups.includes(sg)) sessionGroups.push(sg);
            }
          }

          // Single multi-group search — lets the backend rank all results together
          const allGroups = [...longTermGroups, ...sessionGroups];
          const allGroupResults = allGroups.length > 0
            ? await searchAuthorizedMemories(backend, {
                query,
                groupIds: allGroups,
                limit,
                sessionId: state.sessionId,
              })
            : [];

          // Split results by group type for formatting
          const sessionGroupSet = new Set(sessionGroups);
          const longTermResults = allGroupResults.filter((r) => !sessionGroupSet.has(r.group_id));
          const sessionResults = allGroupResults.filter((r) => sessionGroupSet.has(r.group_id));
          const groupResults = allGroupResults;

          // Owner-aware fragment search: if the subject is an agent with an owner,
          // also find fragments where the owner is in `involves`.
          // Uses search-then-post-filter: search the source groups for query relevance,
          // then intersect with the authorized fragment set for security.
          let ownerFragmentResults: typeof groupResults = [];
          if (subject.type === "agent") {
            try {
              const ownerId = await lookupAgentOwner(spicedb, subject.id, state.lastWriteToken);
              if (ownerId) {
                const ownerSubject: Subject = { type: "person", id: ownerId };
                const viewableIds = await lookupViewableFragments(spicedb, ownerSubject, state.lastWriteToken);
                if (viewableIds.length > 0) {
                  const groupResultIds = new Set(groupResults.map((r) => r.uuid));
                  const newIds = viewableIds.filter((id) => !groupResultIds.has(id));
                  if (newIds.length > 0) {
                    // Discover which groups the viewable fragments belong to
                    const ownerGroups = await lookupFragmentSourceGroups(spicedb, newIds, state.lastWriteToken);
                    const alreadySearched = new Set([...longTermGroups, ...sessionGroups]);
                    const newGroups = ownerGroups.filter(g => !alreadySearched.has(g));
                    if (newGroups.length > 0) {
                      const candidateResults = await searchAuthorizedMemories(backend, {
                        query,
                        groupIds: newGroups,
                        limit,
                      });
                      // Post-filter: only keep results the owner is authorized to view
                      const viewableSet = new Set(newIds);
                      ownerFragmentResults = candidateResults.filter(r => viewableSet.has(r.uuid));
                    }
                  }
                }
              }
            } catch (err) {
              api.logger.warn(`openclaw-memory-rebac: owner-aware recall failed: ${String(err)}`);
            }
          }

          const allResults = [...groupResults, ...ownerFragmentResults];
          const totalCount = allResults.length;

          if (totalCount === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0, authorizedGroups },
            };
          }

          const text = ownerFragmentResults.length > 0
            ? formatDualResults(groupResults, ownerFragmentResults)
            : formatDualResults(longTermResults, sessionResults);
          const sanitized = allResults.map((r) => ({
            type: r.type,
            uuid: r.uuid,
            group_id: r.group_id,
            summary: r.summary,
            context: r.context,
          }));

          return {
            content: [{ type: "text", text: `Found ${totalCount} memories:\n\n${text}` }],
            details: {
              count: totalCount,
              memories: sanitized,
              authorizedGroups,
              longTermCount: longTermResults.length,
              sessionCount: sessionResults.length,
              ownerFragmentCount: ownerFragmentResults.length,
            },
          };
        },
      }),
      { name: "memory_recall" },
    );

    api.registerTool(
      (ctx) => ({
        name: "memory_store",
        label: "Memory Store",
        description:
          "Save information to the knowledge graph with authorization tracking. Use longTerm=false to store session-scoped memories.",
        parameters: Type.Object({
          content: Type.String({ description: "Information to remember" }),
          source_description: Type.Optional(
            Type.String({ description: "Context about the source (e.g., 'conversation with Mark')" }),
          ),
          involves: Type.Optional(
            Type.Array(Type.String(), { description: "Person/agent IDs involved in this memory" }),
          ),
          group_id: Type.Optional(
            Type.String({ description: "Target group ID (uses default group if omitted)" }),
          ),
          longTerm: Type.Optional(
            Type.Boolean({ description: "Store as long-term memory (default: true). Set to false for session-scoped." }),
          ),
        }),
        async execute(_toolCallId, params) {
          const {
            content,
            source_description = "conversation",
            involves = [],
            group_id,
            longTerm = true,
          } = params as {
            content: string;
            source_description?: string;
            involves?: string[];
            group_id?: string;
            longTerm?: boolean;
          };

          const subject = resolveSubject(ctx.agentId);
          const state = getState(ctx.agentId);

          const sanitizeGroupId = (id?: string): string | undefined => {
            if (!id) return undefined;
            const trimmed = id.trim();
            if (trimmed.includes(" ") || trimmed.toLowerCase().includes("configured")) {
              return undefined;
            }
            return trimmed;
          };

          let targetGroupId: string;
          const sanitizedGroupId = sanitizeGroupId(group_id);
          if (sanitizedGroupId) {
            targetGroupId = sanitizedGroupId;
          } else if (!longTerm && state.sessionId) {
            targetGroupId = sessionGroupId(state.sessionId);
          } else {
            targetGroupId = backendDefaultGroupId;
          }

          const isOwnSession =
            isSessionGroup(targetGroupId) &&
            state.sessionId != null &&
            targetGroupId === sessionGroupId(state.sessionId);

          if (isOwnSession) {
            try {
              const token = await ensureGroupMembership(spicedb, targetGroupId, subject);
              if (token) state.lastWriteToken = token;
            } catch {
              api.logger.warn(`openclaw-memory-rebac: failed to ensure membership in ${targetGroupId}`);
            }
          } else {
            const allowed = await canWriteToGroup(spicedb, subject, targetGroupId, state.lastWriteToken);
            if (!allowed) {
              return {
                content: [{ type: "text", text: `Permission denied: cannot write to group "${targetGroupId}"` }],
                details: { action: "denied", groupId: targetGroupId },
              };
            }
          }

          const involvedSubjects: Subject[] = involves.map((id) => ({ type: "person" as const, id }));

          const result = await backend.store({
            content,
            groupId: targetGroupId,
            sourceDescription: source_description,
            customPrompt: (cfg.backendConfig["customInstructions"] as string) ?? "",
          });

          // Chain SpiceDB writes to the fragmentId Promise — fires when backend
          // has a stable episode UUID.  Discover extracted fact UUIDs and write
          // per-fact relationships so that fragment-level permissions (view, delete)
          // resolve correctly against the IDs returned by memory_recall.
          result.fragmentId
            .then(async (episodeId) => {
              const factIds = backend.discoverFragmentIds
                ? await backend.discoverFragmentIds(episodeId)
                : [];

              if (factIds.length > 0) {
                for (const factId of factIds) {
                  const writeToken = await writeFragmentRelationships(spicedb, {
                    fragmentId: factId,
                    groupId: targetGroupId,
                    sharedBy: subject,
                    involves: involvedSubjects,
                  });
                  if (writeToken) state.lastWriteToken = writeToken;
                }
                api.logger.info(
                  `openclaw-memory-rebac: wrote SpiceDB relationships for ${factIds.length} fact(s) from episode ${episodeId}`,
                );
              } else {
                // Fallback: write relationships for the episode UUID itself
                const writeToken = await writeFragmentRelationships(spicedb, {
                  fragmentId: episodeId,
                  groupId: targetGroupId,
                  sharedBy: subject,
                  involves: involvedSubjects,
                });
                if (writeToken) state.lastWriteToken = writeToken;
              }
            })
            .catch((err) => {
              api.logger.warn(
                `openclaw-memory-rebac: deferred SpiceDB write failed for memory_store: ${err}`,
              );
            });

          return {
            content: [{ type: "text", text: `Stored memory in group "${targetGroupId}": "${content.slice(0, 100)}..."` }],
            details: {
              action: "created",
              groupId: targetGroupId,
              backend: backend.name,
              longTerm,
              involves,
            },
          };
        },
      }),
      { name: "memory_store" },
    );

    api.registerTool(
      (ctx) => ({
        name: "memory_forget",
        label: "Memory Forget",
        description:
          "Remove a memory fragment by ID. Use type-prefixed IDs from memory_recall (e.g. 'fact:UUID', 'chunk:UUID'). Always de-authorizes from SpiceDB; also deletes from storage if the backend supports individual deletion.",
        parameters: Type.Object({
          id: Type.String({ description: "Memory ID to forget (e.g. 'fact:da8650cb-...' or bare UUID)" }),
        }),
        async execute(_toolCallId, params) {
          const { id } = params as { id: string };

          const subject = resolveSubject(ctx.agentId);
          const state = getState(ctx.agentId);

          // Parse optional type prefix — strip it to get the bare UUID
          const colonIdx = id.indexOf(":");
          let uuid: string;
          let fragmentType: string | undefined;
          if (colonIdx > 0 && colonIdx < 10) {
            const prefix = id.slice(0, colonIdx);
            // "entity" type cannot be deleted this way (graph-backend specific)
            if (prefix === "entity") {
              return {
                content: [{ type: "text", text: "Entities cannot be deleted directly. Delete the facts connected to them instead." }],
                details: { action: "error", id },
              };
            }
            fragmentType = prefix;
            uuid = id.slice(colonIdx + 1);
          } else {
            uuid = id;
          }

          // Check SpiceDB delete permission.
          // Fragment-level relationships may be missing (episode UUID vs fact UUID mismatch),
          // so fall back to group-level authorization: if the subject can contribute to any
          // group they have access to, allow deletion.
          let allowed = await canDeleteFragment(spicedb, subject, uuid, state.lastWriteToken);
          if (!allowed) {
            const groups = await lookupAuthorizedGroups(spicedb, subject, state.lastWriteToken);
            for (const g of groups) {
              if (await canWriteToGroup(spicedb, subject, g, state.lastWriteToken)) {
                allowed = true;
                break;
              }
            }
            if (allowed) {
              api.logger.info(
                `openclaw-memory-rebac: fragment-level delete check failed for "${uuid}", authorized via group membership`,
              );
            }
          }
          if (!allowed) {
            return {
              content: [{ type: "text", text: `Permission denied: cannot delete fragment "${uuid}"` }],
              details: { action: "denied", id },
            };
          }

          // Attempt backend deletion (optional — not all backends support it)
          if (backend.deleteFragment) {
            try {
              await backend.deleteFragment(uuid, fragmentType);
            } catch (err) {
              api.logger.warn(`openclaw-memory-rebac: backend deletion failed for ${uuid}: ${err}`);
              // Continue to SpiceDB de-authorization even if backend deletion fails
            }
          }

          // Always de-authorize in SpiceDB
          const writeToken = await deleteFragmentRelationships(spicedb, uuid);
          if (writeToken) state.lastWriteToken = writeToken;

          return {
            content: [{ type: "text", text: "Memory forgotten." }],
            details: { action: "deleted", id, uuid },
          };
        },
      }),
      { name: "memory_forget" },
    );

    api.registerTool(
      (ctx) => ({
        name: "memory_status",
        label: "Memory Status",
        description: "Check the health of the memory backend and SpiceDB.",
        parameters: Type.Object({}),
        async execute() {
          const state = getState(ctx.agentId);
          const backendStatus = await backend.getStatus();

          let spicedbOk = false;
          try {
            await spicedb.readSchema();
            spicedbOk = true;
          } catch {
            // SpiceDB unreachable
          }

          const status = {
            ...backendStatus,
            spicedb: spicedbOk ? "connected" : "unreachable",
            endpoint_spicedb: cfg.spicedb.endpoint,
            currentSessionId: state.sessionId ?? "none",
            agentId: ctx.agentId ?? "default",
          };

          const statusText = [
            `Backend (${backend.name}): ${backendStatus.healthy ? "connected" : "unreachable"}`,
            `SpiceDB: ${spicedbOk ? "connected" : "unreachable"} (${cfg.spicedb.endpoint})`,
            `Session: ${state.sessionId ?? "none"}`,
            `Agent: ${ctx.agentId ?? "default"}`,
          ].join("\n");

          return {
            content: [{ type: "text", text: statusText }],
            details: status,
          };
        },
      }),
      { name: "memory_status" },
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    const defaultSubject: Subject = { type: cfg.subjectType, id: cfg.subjectId };

    api.registerCli(
      ({ program }) => {
        const mem = program
          .command("rebac-mem")
          .description(`ReBAC memory plugin commands (backend: ${backend.name})`);

        registerCommands(mem, {
          backend,
          spicedb,
          cfg,
          currentSubject: defaultSubject,
          getLastWriteToken: () => getDefaultState().lastWriteToken,
        });
      },
      { commands: ["rebac-mem"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event, ctx) => {
        const subject = resolveSubject(ctx?.agentId);
        const state = getState(ctx?.agentId);
        if (ctx?.sessionKey) state.sessionId = ctx.sessionKey;

        if (!isSessionAllowed(ctx?.sessionKey, cfg.sessionFilter)) return;

        if (!event.prompt || event.prompt.length < 5) return;

        try {
          const authorizedGroups = await lookupAuthorizedGroups(spicedb, subject, state.lastWriteToken);

          const longTermGroups = authorizedGroups.filter((g) => !isSessionGroup(g));
          const sessionGroups = authorizedGroups.filter(isSessionGroup);
          if (state.sessionId) {
            const sg = sessionGroupId(state.sessionId);
            if (!sessionGroups.includes(sg)) sessionGroups.push(sg);
          }

          const autoRecallLimit = 8;
          const allGroups = [...longTermGroups, ...sessionGroups];
          const allResults = allGroups.length > 0
            ? await searchAuthorizedMemories(backend, {
                query: event.prompt,
                groupIds: allGroups,
                limit: autoRecallLimit,
                sessionId: state.sessionId,
              })
            : [];

          const sessionGroupSet = new Set(sessionGroups);
          const longTermResults = allResults.filter((r) => !sessionGroupSet.has(r.group_id));
          const sessionResults = allResults.filter((r) => sessionGroupSet.has(r.group_id));
          const totalCount = allResults.length;

          const toolHint =
            "<memory-tools>\n" +
            "You have knowledge-graph memory tools. Use them proactively:\n" +
            "- memory_recall: Search for facts, preferences, people, decisions, or past context. Use this BEFORE saying you don't know or remember something.\n" +
            "- memory_store: Save important new information (preferences, decisions, facts about people).\n" +
            "</memory-tools>";

          if (totalCount === 0) return { prependContext: toolHint };

          const memoryContext = formatDualResults(longTermResults, sessionResults);
          api.logger.info?.(
            `openclaw-memory-rebac: injecting ${totalCount} memories (${longTermResults.length} long-term, ${sessionResults.length} session)`,
          );

          return {
            prependContext: `${toolHint}\n\n<relevant-memories>\nThe following memories may be relevant:\n${memoryContext}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn(`openclaw-memory-rebac: recall failed: ${String(err)}`);
        }
      });
    }

    if (cfg.autoCapture) {
      api.on("agent_end", async (event, ctx) => {
        const subject = resolveSubject(ctx?.agentId);
        const state = getState(ctx?.agentId);
        if (ctx?.sessionKey) state.sessionId = ctx.sessionKey;

        if (!isSessionAllowed(ctx?.sessionKey, cfg.sessionFilter)) return;

        if (!event.success || !event.messages || event.messages.length === 0) return;

        try {
          const maxMessages = cfg.maxCaptureMessages;
          const conversationLines: string[] = [];
          let messageCount = 0;

          for (const msg of [...event.messages].reverse()) {
            if (messageCount >= maxMessages) break;
            if (!msg || typeof msg !== "object") continue;

            const msgObj = msg as Record<string, unknown>;
            const role = msgObj.role;
            if (role !== "user" && role !== "assistant") continue;

            let text = "";
            const content = msgObj.content;
            if (typeof content === "string") {
              text = content;
            } else if (Array.isArray(content)) {
              const textParts: string[] = [];
              for (const block of content) {
                if (
                  block && typeof block === "object" &&
                  "type" in block &&
                  (block as Record<string, unknown>).type === "text" &&
                  "text" in block &&
                  typeof (block as Record<string, unknown>).text === "string"
                ) {
                  textParts.push((block as Record<string, unknown>).text as string);
                }
              }
              text = textParts.join("\n");
            }

            // Strip envelope metadata and injected blocks — keep the user's actual content
            text = stripEnvelopeMetadata(text);
            if (!text || text.length < 5) continue;

            const roleLabel = role === "user" ? "User" : "Assistant";
            conversationLines.unshift(`${roleLabel}: ${text}`);
            messageCount++;
          }

          if (conversationLines.length === 0) return;

          const episodeBody = conversationLines.join("\n");
          const targetGroupId = state.sessionId
            ? sessionGroupId(state.sessionId)
            : backendDefaultGroupId;

          const isOwnSession =
            isSessionGroup(targetGroupId) &&
            state.sessionId != null &&
            targetGroupId === sessionGroupId(state.sessionId);

          if (isOwnSession) {
            try {
              const token = await ensureGroupMembership(spicedb, targetGroupId, subject);
              if (token) state.lastWriteToken = token;
            } catch {
              // best-effort
            }
          } else {
            const allowed = await canWriteToGroup(spicedb, subject, targetGroupId, state.lastWriteToken);
            if (!allowed) {
              api.logger.warn(`openclaw-memory-rebac: auto-capture denied for group ${targetGroupId}`);
              return;
            }
          }

          const result = await backend.store({
            content: episodeBody,
            groupId: targetGroupId,
            sourceDescription: "auto-captured conversation",
            customPrompt: (cfg.backendConfig["customInstructions"] as string) ?? "",
          });

          // Chain SpiceDB writes — discover per-fact UUIDs when possible
          result.fragmentId
            .then(async (episodeId) => {
              const factIds = backend.discoverFragmentIds
                ? await backend.discoverFragmentIds(episodeId)
                : [];

              if (factIds.length > 0) {
                for (const factId of factIds) {
                  const writeToken = await writeFragmentRelationships(spicedb, {
                    fragmentId: factId,
                    groupId: targetGroupId,
                    sharedBy: subject,
                  });
                  if (writeToken) state.lastWriteToken = writeToken;
                }
              } else {
                const writeToken = await writeFragmentRelationships(spicedb, {
                  fragmentId: episodeId,
                  groupId: targetGroupId,
                  sharedBy: subject,
                });
                if (writeToken) state.lastWriteToken = writeToken;
              }
            })
            .catch((err) => {
              api.logger.warn(
                `openclaw-memory-rebac: deferred SpiceDB write (auto-capture) failed: ${err}`,
              );
            });

          // Backend-specific session enrichment (optional backend feature)
          if (backend.enrichSession && state.sessionId) {
            const lastUserMsg = [...event.messages]
              .reverse()
              .find((m) => (m as Record<string, unknown>).role === "user");
            const lastAssistMsg = [...event.messages]
              .reverse()
              .find((m) => (m as Record<string, unknown>).role === "assistant");

            const extractText = (m: unknown): string => {
              if (!m || typeof m !== "object") return "";
              const obj = m as Record<string, unknown>;
              if (typeof obj.content === "string") return obj.content;
              if (Array.isArray(obj.content)) {
                return obj.content
                  .filter((b: unknown) =>
                    typeof b === "object" && b !== null &&
                    (b as Record<string, unknown>).type === "text",
                  )
                  .map((b: unknown) => (b as Record<string, unknown>).text as string)
                  .join("\n");
              }
              return "";
            };

            const userMsg = stripEnvelopeMetadata(extractText(lastUserMsg));
            const assistantMsg = extractText(lastAssistMsg);

            if (userMsg && assistantMsg) {
              backend.enrichSession({
                sessionId: state.sessionId,
                groupId: targetGroupId,
                userMsg,
                assistantMsg,
              }).catch(() => {});
            }
          }

          api.logger.info(
            `openclaw-memory-rebac: auto-captured ${conversationLines.length} messages to ${targetGroupId}`,
          );
        } catch (err) {
          api.logger.warn(`openclaw-memory-rebac: capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "openclaw-memory-rebac",
      async start() {
        const defaultState = getDefaultState();
        const backendStatus = await backend.getStatus();
        let spicedbOk = false;
        try {
          const existing = await spicedb.readSchema();
          spicedbOk = true;
          if (!existing || !existing.includes("memory_fragment")) {
            api.logger.info("openclaw-memory-rebac: writing SpiceDB schema (first run)");
            const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.zed");
            const schema = readFileSync(schemaPath, "utf-8");
            await spicedb.writeSchema(schema);
            api.logger.info("openclaw-memory-rebac: SpiceDB schema written successfully");
          }
        } catch {
          // Will be retried on first use
        }

        if (spicedbOk) {
          // Ensure the config-level subject is a member of the default group
          try {
            const token = await ensureGroupMembership(spicedb, backendDefaultGroupId, defaultSubject);
            if (token) defaultState.lastWriteToken = token;
          } catch {
            api.logger.warn("openclaw-memory-rebac: failed to ensure default group membership");
          }

          // Write agent → owner relationships from identities config
          for (const [agentId, personId] of Object.entries(cfg.identities)) {
            try {
              const token = await spicedb.writeRelationships([
                {
                  resourceType: "agent",
                  resourceId: agentId,
                  relation: "owner",
                  subjectType: "person",
                  subjectId: personId,
                },
                {
                  resourceType: "person",
                  resourceId: personId,
                  relation: "agent",
                  subjectType: "agent",
                  subjectId: agentId,
                },
              ]);
              if (token) defaultState.lastWriteToken = token;
              api.logger.info(`openclaw-memory-rebac: linked agent:${agentId} ↔ person:${personId}`);
            } catch (err) {
              api.logger.warn(`openclaw-memory-rebac: failed to write owner for agent:${agentId}: ${err}`);
            }
          }
        }

        api.logger.info(
          `openclaw-memory-rebac: initialized (backend: ${backend.name} ${backendStatus.healthy ? "OK" : "UNREACHABLE"}, spicedb: ${spicedbOk ? "OK" : "UNREACHABLE"})`,
        );
      },
      stop() {
        clearTimeout(grpcGuardTimer);
        process.removeListener("unhandledRejection", grpcRejectionHandler);
        api.logger.info("openclaw-memory-rebac: stopped");
      },
    });
  },
};

export default rebacMemoryPlugin;
