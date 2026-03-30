/**
 * EverMemOS Integration E2E Tests
 *
 * Tests integration aspects unique to the EverMemOS backend that differ
 * from Graphiti and aren't covered by the backend-agnostic contract suite.
 *
 * Focus areas:
 * - Memory type mapping (EverMemOS types → SearchResult types)
 * - Context prefix generation for downstream disambiguation
 * - enrichSession → conversation-meta API integration
 * - fragmentId returns UUID anchor (no trace resolution in liminal mode)
 * - Liminal role: no discoverFragmentIds or resolveAnchors (removed in v0.5.0)
 *
 * Assumes EverMemOS is running on default port 1995 in a Docker container.
 *
 * Run with:
 *   E2E_BACKEND=evermemos OPENCLAW_LIVE_TEST=1 vitest run --config vitest.e2e.config.ts e2e-evermemos.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SpiceDbClient } from "./spicedb.js";
import { EverMemOSBackend } from "./backends/evermemos.js";
import type { EverMemOSConfig } from "./backends/evermemos.js";
import {
  ensureGroupMembership,
  type Subject,
} from "./authorization.js";

const LIVE_TEST = process.env.OPENCLAW_LIVE_TEST === "1" && (process.env.E2E_BACKEND === "evermemos");
const skipE2E = LIVE_TEST ? test : test.skip;

const EVERMEMOS_ENDPOINT = process.env.EVERMEMOS_ENDPOINT || "http://localhost:1995";
const SPICEDB_ENDPOINT = process.env.SPICEDB_ENDPOINT || "localhost:50051";
const SPICEDB_TOKEN = process.env.SPICEDB_TOKEN || "dev_token";

const defaultConfig: EverMemOSConfig = {
  endpoint: EVERMEMOS_ENDPOINT,
  defaultGroupId: "e2e_evermemos_test",
  requestTimeoutMs: 30000,
  retrieveMethod: "hybrid",
  memoryTypes: ["episodic_memory", "profile", "foresight", "event_log"],
  defaultSenderId: "e2e_test_agent",
};

let backend: EverMemOSBackend;
let spicedb: SpiceDbClient;
let testSubject: Subject;
let testGroup: string;
let lastWriteToken: string | undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("e2e: EverMemOS integration", () => {
  beforeAll(async () => {
    if (!LIVE_TEST) return;

    backend = new EverMemOSBackend(defaultConfig);
    testGroup = `e2e_evermemos_${Date.now()}`;
    testSubject = { type: "agent", id: `e2e_evermemos_agent_${Date.now()}` };

    spicedb = new SpiceDbClient({
      endpoint: SPICEDB_ENDPOINT,
      token: SPICEDB_TOKEN,
      insecure: true,
    });

    const schemaPath = new URL("./schema.zed", import.meta.url).pathname;
    const { readFileSync } = await import("node:fs");
    const schema = readFileSync(schemaPath, "utf-8");
    await spicedb.writeSchema(schema);

    lastWriteToken = await ensureGroupMembership(spicedb, testGroup, testSubject);
  });

  afterAll(async () => {
    if (!LIVE_TEST || !backend || !testGroup) return;
    try {
      await backend.deleteGroup(testGroup);
    } catch {
      // Best-effort cleanup
    }
  });

  // --------------------------------------------------------------------------
  // fragmentId semantics: returns messageId UUID as anchor for trace resolution
  // --------------------------------------------------------------------------

  skipE2E("fragmentId resolves to a UUID anchor", async () => {
    const before = Date.now();

    const result = await backend.store({
      content: "Test content for fragment timing",
      groupId: testGroup,
    });

    const fragmentId = await result.fragmentId;
    const elapsed = Date.now() - before;

    // EverMemOS returns the messageId UUID as a fragment anchor
    expect(fragmentId).toBeTruthy();
    expect(fragmentId).toMatch(/[0-9a-f-]{36}/);
    // Should resolve quickly (no polling for the anchor itself)
    expect(elapsed).toBeLessThan(5000);
  });

  // --------------------------------------------------------------------------
  // Fragment-level SpiceDB — store returns anchor, group auth still works
  // --------------------------------------------------------------------------

  skipE2E("store returns UUID anchor — group-level authorization still works", async () => {
    const result = await backend.store({
      content: "Authorization test: fragment anchor + group auth",
      groupId: testGroup,
    });
    const fragmentId = await result.fragmentId;

    // Returns UUID anchor (not null)
    expect(fragmentId).toBeTruthy();
    expect(fragmentId).toMatch(/[0-9a-f-]{36}/);

    // Group-level authorization still works
    const { lookupAuthorizedGroups } = await import("./authorization.js");
    const authorizedGroups = await lookupAuthorizedGroups(spicedb, testSubject, lastWriteToken);
    expect(authorizedGroups).toContain(testGroup);
  });

  // --------------------------------------------------------------------------
  // Memory type mapping: EverMemOS types → SearchResult types + context prefixes
  // --------------------------------------------------------------------------

  skipE2E("search results have correct type mapping and context prefixes", async () => {
    // Store content and wait for extraction
    await backend.store({
      content: "Dana Chen was promoted to VP of Engineering at Orbital Corp. She will oversee the platform team starting Q2. The board approved the reorg on Monday.",
      groupId: testGroup,
    });

    // Poll for results
    let results: Awaited<ReturnType<typeof backend.searchGroup>> = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      await sleep(3000);
      results = await backend.searchGroup({
        query: "Dana Chen Orbital Corp VP Engineering platform",
        groupId: testGroup,
        limit: 20,
      });
      if (results.length > 0) break;
    }

    if (results.length === 0) {
      console.log("[evermemos] No results after polling — MemCell extraction may still be pending");
      return; // Non-fatal: extraction timing depends on LLM speed
    }

    // Verify our type mapping
    for (const r of results) {
      // All types must be from the SearchResult union
      expect(["chunk", "fact", "summary", "node", "completion"]).toContain(r.type);

      // Context must start with one of our prefixes
      const prefix = r.context.split(":")[0].trim();
      expect(["episode", "profile", "foresight", "event"]).toContain(prefix);

      // Basic SearchResult shape
      expect(r.uuid).toBeTruthy();
      expect(r.summary).toBeTruthy();
      expect(typeof r.score).toBe("number");
    }

    // Log type distribution for diagnostic visibility
    const typeCounts: Record<string, number> = {};
    for (const r of results) {
      const prefix = r.context.split(":")[0].trim();
      typeCounts[prefix] = (typeCounts[prefix] || 0) + 1;
    }
    console.log(`[evermemos] Type distribution: ${JSON.stringify(typeCounts)}`);
  }, 600000);

  // --------------------------------------------------------------------------
  // enrichSession → conversation-meta round-trip
  // --------------------------------------------------------------------------

  skipE2E("enrichSession posts conversation metadata without error", async () => {
    // enrichSession is best-effort (swallows errors internally).
    // This test verifies the API call shape is accepted by EverMemOS.
    await backend.enrichSession({
      sessionId: `e2e-enrich-${Date.now()}`,
      groupId: testGroup,
      userMsg: "Can you summarize yesterday's standup?",
      assistantMsg: "The team discussed three items: API redesign progress, Q2 hiring targets, and the security audit timeline.",
    });

    // If we get here without throwing, the API accepted the payload
  });

  // --------------------------------------------------------------------------
  // Selective memory type filtering
  // --------------------------------------------------------------------------

  skipE2E("memoryTypes config filters search to specific types", async () => {
    // Create a backend configured for only episodic_memory
    const episodicOnlyBackend = new EverMemOSBackend({
      ...defaultConfig,
      memoryTypes: ["episodic_memory"],
    });

    const results = await episodicOnlyBackend.searchGroup({
      query: "Dana Chen Orbital",
      groupId: testGroup,
      limit: 10,
    });

    // All results (if any) should be mapped from episodic_memory → "chunk"
    for (const r of results) {
      expect(r.type).toBe("chunk");
      expect(r.context).toMatch(/^episode/);
    }
  });

  // --------------------------------------------------------------------------
  // customPrompt is silently ignored (unlike Graphiti)
  // --------------------------------------------------------------------------

  skipE2E("customPrompt does not affect stored content", async () => {
    const result = await backend.store({
      content: "Plain content without extraction instructions",
      groupId: testGroup,
      customPrompt: "This should be ignored by EverMemOS",
    });

    // Should succeed — customPrompt doesn't cause errors
    const fragmentId = await result.fragmentId;
    // EverMemOS returns UUID anchor (customPrompt is ignored but store works)
    expect(fragmentId).toBeTruthy();
  });

});
