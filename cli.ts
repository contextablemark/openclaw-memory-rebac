/**
 * Shared CLI command registration for rebac-mem.
 *
 * Registers backend-agnostic commands (search, status, schema-write, groups,
 * add-member, import) then calls backend.registerCliCommands() for
 * backend-specific extensions (e.g., graphiti: episodes, fact, clear-graph).
 *
 * Used by both the OpenClaw plugin (index.ts) and the standalone CLI
 * (bin/rebac-mem.ts).
 */

import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, dirname, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import type { MemoryBackend } from "./backend.js";
import type { SpiceDbClient, RelationshipTuple } from "./spicedb.js";
import type { RebacMemoryConfig } from "./config.js";
import { defaultGroupId } from "./config.js";
import {
  lookupAuthorizedGroups,
  writeFragmentRelationships,
  ensureGroupMembership,
  type Subject,
} from "./authorization.js";
import { searchAuthorizedMemories } from "./search.js";

// ============================================================================
// Session helper (mirrors index.ts — no shared module to avoid circular import)
// ============================================================================

function sessionGroupId(sessionId: string): string {
  const sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `session-${sanitized}`;
}

// ============================================================================
// CLI Context
// ============================================================================

export type CliContext = {
  backend: MemoryBackend;
  spicedb: SpiceDbClient;
  cfg: RebacMemoryConfig;
  currentSubject: Subject;
  getLastWriteToken: () => string | undefined;
};

// ============================================================================
// Command Registration
// ============================================================================

export function registerCommands(cmd: Command, ctx: CliContext): void {
  const { backend, spicedb, cfg, currentSubject, getLastWriteToken } = ctx;
  const defGroupId = defaultGroupId(cfg);

  // --------------------------------------------------------------------------
  // search
  // --------------------------------------------------------------------------

  cmd
    .command("search")
    .description("Search memories with authorization")
    .argument("<query>", "Search query")
    .option("--limit <n>", "Max results", "10")
    .action(async (query: string, opts: { limit: string }) => {
      const authorizedGroups = await lookupAuthorizedGroups(spicedb, currentSubject, getLastWriteToken());
      if (authorizedGroups.length === 0) {
        console.log("No accessible memory groups.");
        return;
      }
      console.log(`Searching ${authorizedGroups.length} authorized groups...`);
      const results = await searchAuthorizedMemories(backend, {
        query,
        groupIds: authorizedGroups,
        limit: parseInt(opts.limit),
      });
      if (results.length === 0) {
        console.log("No results found.");
        return;
      }
      console.log(JSON.stringify(results, null, 2));
    });

  // --------------------------------------------------------------------------
  // status
  // --------------------------------------------------------------------------

  cmd
    .command("status")
    .description("Check backend + SpiceDB health")
    .action(async () => {
      const backendStatus = await backend.getStatus();
      let spicedbOk = false;
      try {
        await spicedb.readSchema();
        spicedbOk = true;
      } catch {
        // unreachable
      }
      console.log(`Backend (${backend.name}): ${backendStatus.healthy ? "OK" : "UNREACHABLE"}`);
      for (const [k, v] of Object.entries(backendStatus)) {
        if (k !== "backend" && k !== "healthy") console.log(`  ${k}: ${v}`);
      }
      console.log(`SpiceDB: ${spicedbOk ? "OK" : "UNREACHABLE"} (${cfg.spicedb.endpoint})`);
    });

  // --------------------------------------------------------------------------
  // schema-write
  // --------------------------------------------------------------------------

  cmd
    .command("schema-write")
    .description("Write/update SpiceDB authorization schema")
    .action(async () => {
      const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.zed");
      const schema = readFileSync(schemaPath, "utf-8");
      await spicedb.writeSchema(schema);
      console.log("SpiceDB schema written successfully.");
    });

  // --------------------------------------------------------------------------
  // groups
  // --------------------------------------------------------------------------

  cmd
    .command("groups")
    .description("List authorized groups for current subject")
    .action(async () => {
      const groups = await lookupAuthorizedGroups(spicedb, currentSubject, getLastWriteToken());
      if (groups.length === 0) {
        console.log("No authorized groups.");
        return;
      }
      console.log(`Authorized groups for ${currentSubject.type}:${currentSubject.id}:`);
      for (const g of groups) console.log(`  - ${g}`);
    });

  // --------------------------------------------------------------------------
  // add-member
  // --------------------------------------------------------------------------

  cmd
    .command("add-member")
    .description("Add a subject to a group")
    .argument("<group-id>", "Group ID")
    .argument("<subject-id>", "Subject ID")
    .option("--type <type>", "Subject type (agent|person)", "person")
    .action(async (groupId: string, subjectId: string, opts: { type: string }) => {
      const subjectType = opts.type === "agent" ? "agent" : "person";
      await ensureGroupMembership(spicedb, groupId, {
        type: subjectType as "agent" | "person",
        id: subjectId,
      });
      console.log(`Added ${subjectType}:${subjectId} to group:${groupId}`);
    });

  // --------------------------------------------------------------------------
  // import — ingest workspace files + session transcripts into the backend
  // --------------------------------------------------------------------------

  cmd
    .command("import")
    .description("Import workspace markdown files (and optionally session transcripts) into the backend")
    .option("--workspace <path>", "Workspace directory", join(homedir(), ".openclaw", "workspace"))
    .option("--include-sessions", "Also import session JSONL transcripts", false)
    .option("--sessions-only", "Only import session transcripts (skip workspace files)", false)
    .option("--session-dir <path>", "Session transcripts directory", join(homedir(), ".openclaw", "agents", "main", "sessions"))
    .option("--group <id>", "Target group for workspace files", defGroupId)
    .option("--dry-run", "List files without importing", false)
    .action(async (opts: {
      workspace: string;
      includeSessions: boolean;
      sessionsOnly: boolean;
      sessionDir: string;
      group: string;
      dryRun: boolean;
    }) => {
      const workspacePath = resolve(opts.workspace);
      const targetGroup = opts.group;
      const importSessions = opts.includeSessions || opts.sessionsOnly;
      const importWorkspace = !opts.sessionsOnly;

      let mdFiles: string[] = [];
      try {
        const entries = await readdir(workspacePath);
        mdFiles = entries.filter((f) => f.endsWith(".md")).sort();
      } catch {
        console.error(`Cannot read workspace directory: ${workspacePath}`);
        return;
      }

      // Also check memory/ subdirectory
      try {
        const memDir = join(workspacePath, "memory");
        const memEntries = await readdir(memDir);
        for (const f of memEntries) {
          if (f.endsWith(".md")) mdFiles.push(join("memory", f));
        }
      } catch {
        // No memory/ subdirectory — fine
      }

      if (importWorkspace) {
        if (mdFiles.length === 0) {
          console.log("No markdown files found in workspace.");
        } else {
          console.log(`Found ${mdFiles.length} workspace file(s) in ${workspacePath}:`);
          for (const f of mdFiles) {
            const filePath = join(workspacePath, f);
            const info = await stat(filePath);
            console.log(`  ${f} (${info.size} bytes)`);
          }
        }
      }

      if (opts.dryRun) {
        console.log("\n[dry-run] No files imported.");
        if (importSessions) {
          const sessionPath = resolve(opts.sessionDir);
          try {
            const sessions = (await readdir(sessionPath)).filter((f) => f.endsWith(".jsonl"));
            console.log(`\nFound ${sessions.length} session transcript(s) in ${sessionPath}:`);
            for (const f of sessions) {
              const info = await stat(join(sessionPath, f));
              console.log(`  ${f} (${info.size} bytes)`);
            }
          } catch {
            console.log(`\nCannot read session directory: ${sessionPath}`);
          }
        }
        return;
      }

      // Phase 1: Store all content via backend.store(), collect fragmentId promises
      type PendingResolution = {
        fragmentId: Promise<string>;
        groupId: string;
        name: string;
      };
      const pending: PendingResolution[] = [];
      const membershipGroups = new Set<string>();

      // Phase 1a: Workspace files
      if (importWorkspace && mdFiles.length > 0) {
        if (importWorkspace) membershipGroups.add(targetGroup);
        console.log(`\nPhase 1: Importing workspace files to ${backend.name} (group: ${targetGroup})...`);
        let imported = 0;
        for (const f of mdFiles) {
          const filePath = join(workspacePath, f);
          const content = await readFile(filePath, "utf-8");
          if (!content.trim()) {
            console.log(`  Skipping ${f} (empty)`);
            continue;
          }
          try {
            const result = await backend.store({
              content,
              groupId: targetGroup,
              sourceDescription: `Imported from workspace: ${f}`,
            });
            pending.push({ fragmentId: result.fragmentId, groupId: targetGroup, name: f });
            console.log(`  Queued ${f} (${content.length} bytes)`);
            imported++;
          } catch (err) {
            console.error(`  Failed to import ${f}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        console.log(`Workspace: ${imported}/${mdFiles.length} files ingested.`);
      }

      // Phase 1b: Session transcripts
      if (importSessions) {
        const sessionPath = resolve(opts.sessionDir);
        let jsonlFiles: string[] = [];
        try {
          jsonlFiles = (await readdir(sessionPath)).filter((f) => f.endsWith(".jsonl")).sort();
        } catch {
          console.error(`\nCannot read session directory: ${sessionPath}`);
        }

        if (jsonlFiles.length === 0) {
          console.log("\nNo session transcripts found.");
        } else {
          console.log(`\nPhase 1: Importing ${jsonlFiles.length} session transcript(s) to ${backend.name}...`);
          let sessionsImported = 0;
          for (const f of jsonlFiles) {
            const sessionId = basename(f, ".jsonl");
            const sessionGroup = sessionGroupId(sessionId);
            const filePath = join(sessionPath, f);
            const raw = await readFile(filePath, "utf-8");
            const lines = raw.split("\n").filter(Boolean);

            const conversationLines: string[] = [];
            for (const line of lines) {
              try {
                const entry = JSON.parse(line) as Record<string, unknown>;
                const msg = (entry.type === "message" && entry.message && typeof entry.message === "object")
                  ? entry.message as Record<string, unknown>
                  : entry;
                const role = msg.role as string | undefined;
                if (role !== "user" && role !== "assistant") continue;
                const content = msg.content;
                let text = "";
                if (typeof content === "string") {
                  text = content;
                } else if (Array.isArray(content)) {
                  text = content
                    .filter((b: unknown) =>
                      typeof b === "object" && b !== null &&
                      (b as Record<string, unknown>).type === "text" &&
                      typeof (b as Record<string, unknown>).text === "string",
                    )
                    .map((b: unknown) => (b as Record<string, unknown>).text as string)
                    .join("\n");
                }
                if (
                  text && text.length >= 5 &&
                  !text.includes("<relevant-memories>") &&
                  !text.includes("<memory-tools>")
                ) {
                  const roleLabel = role === "user" ? "User" : "Assistant";
                  conversationLines.push(`${roleLabel}: ${text}`);
                }
              } catch {
                // Skip malformed JSONL lines
              }
            }

            if (conversationLines.length === 0) {
              console.log(`  Skipping ${f} (no user/assistant messages)`);
              continue;
            }

            try {
              const result = await backend.store({
                content: conversationLines.join("\n"),
                groupId: sessionGroup,
                sourceDescription: `Imported session transcript: ${sessionId}`,
              });
              membershipGroups.add(sessionGroup);
              pending.push({ fragmentId: result.fragmentId, groupId: sessionGroup, name: f });
              console.log(`  Queued ${f} (${conversationLines.length} messages) [group: ${sessionGroup}]`);
              sessionsImported++;
            } catch (err) {
              console.error(`  Failed to import ${f}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          console.log(`Sessions: ${sessionsImported}/${jsonlFiles.length} transcripts ingested.`);
        }
      }

      // Phase 1.5: Await all fragmentIds concurrently
      const pendingTuples: RelationshipTuple[] = [];
      if (pending.length > 0) {
        console.log(`\nResolving ${pending.length} fragment UUIDs...`);
        const resolutions = await Promise.allSettled(pending.map((p) => p.fragmentId));
        for (let i = 0; i < resolutions.length; i++) {
          const r = resolutions[i];
          if (r.status === "fulfilled") {
            const fragmentId = r.value;
            pendingTuples.push(
              {
                resourceType: "memory_fragment",
                resourceId: fragmentId,
                relation: "source_group",
                subjectType: "group",
                subjectId: pending[i].groupId,
              },
              {
                resourceType: "memory_fragment",
                resourceId: fragmentId,
                relation: "shared_by",
                subjectType: currentSubject.type,
                subjectId: currentSubject.id,
              },
            );
            console.log(`  ${pending[i].name} → ${fragmentId}`);
          } else {
            console.warn(`  Warning: could not resolve UUID for ${pending[i].name} — SpiceDB linkage skipped`);
          }
        }
      }

      // Phase 2: Bulk write SpiceDB relationships + memberships
      if (pendingTuples.length > 0 || membershipGroups.size > 0) {
        for (const groupId of membershipGroups) {
          pendingTuples.push({
            resourceType: "group",
            resourceId: groupId,
            relation: "member",
            subjectType: currentSubject.type,
            subjectId: currentSubject.id,
          });
        }

        console.log(`\nPhase 2: Writing ${pendingTuples.length} SpiceDB relationships...`);
        try {
          const count = await spicedb.bulkImportRelationships(pendingTuples);
          console.log(`SpiceDB: ${count} relationships written.`);
        } catch (err) {
          console.error(`SpiceDB bulk import failed: ${err instanceof Error ? err.message : String(err)}`);
          console.error("Backend episodes were ingested but lack authorization. Re-run import or add relationships manually.");
        }
      }

      console.log("\nImport complete.");
    });

  // --------------------------------------------------------------------------
  // Backend-specific extension point
  // --------------------------------------------------------------------------

  backend.registerCliCommands?.(cmd);
}
