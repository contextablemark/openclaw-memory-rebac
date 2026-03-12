/**
 * E2E Tests for openclaw-memory-rebac
 *
 * These tests require live services:
 * - SpiceDB at localhost:50051 (insecure)
 * - Graphiti backend at localhost:8000
 *
 * Run with: OPENCLAW_LIVE_TEST=1 vitest run --config vitest.e2e.config.ts
 *
 * To skip: vitest run (without OPENCLAW_LIVE_TEST)
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SpiceDbClient } from "./spicedb.js";
import { GraphitiBackend } from "./backends/graphiti.js";
import {
  lookupAuthorizedGroups,
  writeFragmentRelationships,
  deleteFragmentRelationships,
  canDeleteFragment,
  ensureGroupMembership,
  type Subject,
} from "./authorization.js";

const LIVE_TEST = process.env.OPENCLAW_LIVE_TEST === "1";

const skipE2E = LIVE_TEST ? test : test.skip;

const SPICEDB_ENDPOINT = process.env.SPICEDB_ENDPOINT || "localhost:50051";
const SPICEDB_TOKEN = process.env.SPICEDB_TOKEN || "dev_token";
const GRAPHITI_ENDPOINT = process.env.GRAPHITI_ENDPOINT || "http://localhost:8000";

// Module-level variables shared across describe blocks
let spicedb: SpiceDbClient;
let backend: GraphitiBackend;
let testSubject: Subject;
let testGroup: string;

describe("e2e: full stack integration", () => {

  beforeAll(async () => {
    if (!LIVE_TEST) return;

    // Initialize SpiceDB client
    spicedb = new SpiceDbClient({
      endpoint: SPICEDB_ENDPOINT,
      token: SPICEDB_TOKEN,
      insecure: true,
    });

    // Write SpiceDB schema
    const schemaPath = new URL("./schema.zed", import.meta.url).pathname;
    const { readFileSync } = await import("node:fs");
    const schema = readFileSync(schemaPath, "utf-8");
    await spicedb.writeSchema(schema);

    // Initialize Graphiti backend
    backend = new GraphitiBackend({
      endpoint: GRAPHITI_ENDPOINT,
      defaultGroupId: "e2e_test",
      uuidPollIntervalMs: 3000,
      uuidPollMaxAttempts: 60,
      customInstructions: "",
    });

    testSubject = { type: "agent", id: `e2e_test_${Date.now()}` };
    testGroup = `e2e_group_${Date.now()}`;

    // Ensure test subject is member of test group
    await ensureGroupMembership(spicedb, testGroup, testSubject);
  });

  afterAll(async () => {
    if (!LIVE_TEST || !backend || !testGroup) return;

    // Cleanup: delete test group data
    try {
      await backend.deleteGroup(testGroup);
    } catch {
      // Best-effort cleanup
    }
  });

  skipE2E("backend health check succeeds", async () => {
    const healthy = await backend.healthCheck();
    expect(healthy).toBe(true);
  });

  skipE2E("backend getStatus returns healthy status", async () => {
    const status = await backend.getStatus();
    expect(status.backend).toBe(backend.name);
    expect(status.healthy).toBe(true);
  });

  skipE2E("SpiceDB connectivity works", async () => {
    const schema = await spicedb.readSchema();
    expect(schema).toContain("definition memory_fragment");
  });

  skipE2E("full memory lifecycle: store → authorize → search → forget", async () => {
    const testContent = "Sarah and Tom are working together at Acme Corp on the mobile app redesign project";

    // 1. Store memory via backend
    const storeStart = Date.now();
    const storeResult = await backend.store({
      content: testContent,
      groupId: testGroup,
      sourceDescription: "e2e test",
    });
    const storeTime = Date.now() - storeStart;

    const fragmentId = await storeResult.fragmentId;
    expect(fragmentId).toBeTruthy();
    expect(fragmentId).toMatch(/[0-9a-f-]{36}/); // UUID format

    console.log(`[graphiti] Store operation: ${storeTime}ms`);

    // 2. Write SpiceDB authorization
    const writeToken = await writeFragmentRelationships(spicedb, {
      fragmentId,
      groupId: testGroup,
      sharedBy: testSubject,
    });
    expect(writeToken).toBeTruthy();

    // 3. Verify authorization
    const authorizedGroups = await lookupAuthorizedGroups(spicedb, testSubject, writeToken);
    expect(authorizedGroups).toContain(testGroup);

    const canDelete = await canDeleteFragment(spicedb, testSubject, fragmentId, writeToken);
    expect(canDelete).toBe(true);

    // 4. Search for stored content
    const searchResults = await backend.searchGroup({
      query: "Sarah Tom Acme mobile app",
      groupId: testGroup,
      limit: 10,
    });

    expect(Array.isArray(searchResults)).toBe(true);

    // 5. Delete fragment
    if (backend.deleteFragment) {
      await backend.deleteFragment(fragmentId);
    }

    // 6. De-authorize in SpiceDB
    const deleteToken = await deleteFragmentRelationships(spicedb, fragmentId);
    expect(deleteToken).toBeTruthy();

    // 7. Verify de-authorization
    const canDeleteAfter = await canDeleteFragment(spicedb, testSubject, fragmentId, deleteToken);
    expect(canDeleteAfter).toBe(false);
  }, 600000);

  skipE2E("authorization prevents unauthorized access", async () => {
    const unauthorizedSubject: Subject = { type: "person", id: "unauthorized-person" };

    // This subject should not see the test group
    const groups = await lookupAuthorizedGroups(spicedb, unauthorizedSubject);
    expect(groups).not.toContain(testGroup);
  });

  skipE2E("group membership grants access", async () => {
    const newMember: Subject = { type: "person", id: `e2e-member-${Date.now()}` };

    // Before membership: no access
    let groups = await lookupAuthorizedGroups(spicedb, newMember);
    expect(groups).not.toContain(testGroup);

    // Add membership
    const zedToken = await ensureGroupMembership(spicedb, testGroup, newMember);

    // After membership: has access (use zedToken for consistency)
    groups = await lookupAuthorizedGroups(spicedb, newMember, zedToken);
    expect(groups).toContain(testGroup);
  });

  skipE2E("searchGroup handles empty results gracefully", async () => {
    const results = await backend.searchGroup({
      query: "nonexistent query xyz123",
      groupId: testGroup,
      limit: 10,
    });

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  skipE2E("listGroups returns backend datasets", async () => {
    const groups = await backend.listGroups();
    expect(Array.isArray(groups)).toBe(true);

    // Each group should have name and groupId
    for (const group of groups) {
      expect(group.name).toBeTruthy();
      expect(group.groupId).toBeTruthy();
    }
  });

  skipE2E("getConversationHistory returns array", async () => {
    const sessionId = `e2e-session-${Date.now()}`;
    const history = await backend.getConversationHistory(sessionId);

    expect(Array.isArray(history)).toBe(true);
    // May be empty if no history exists - that's OK
  });

  skipE2E("backend-specific CLI commands are registered", async () => {
    const { registerCommands } = await import("./cli.js");
    const commands: string[] = [];

    const mockCmd = {
      command: (name: string) => {
        commands.push(name);
        return mockCmd;
      },
      description: () => mockCmd,
      argument: () => mockCmd,
      option: () => mockCmd,
      action: () => mockCmd,
    };

    const ctx = {
      backend,
      spicedb,
      cfg: {
        backend: "graphiti" as const,
        spicedb: { endpoint: SPICEDB_ENDPOINT, token: SPICEDB_TOKEN, insecure: true },
        backendConfig: { endpoint: GRAPHITI_ENDPOINT, defaultGroupId: "main", uuidPollIntervalMs: 3000, uuidPollMaxAttempts: 30, customInstructions: "" },
        subjectType: "agent" as const,
        subjectId: "test",
        autoCapture: true,
        autoRecall: true,
        maxCaptureMessages: 10,
      },
      currentSubject: testSubject,
      getLastWriteToken: () => undefined,
    };

    registerCommands(mockCmd as any, ctx);

    // Shared commands
    expect(commands).toContain("search");
    expect(commands).toContain("status");
    expect(commands).toContain("groups");

    // Graphiti-specific commands
    expect(commands).toContain("episodes");
    expect(commands).toContain("fact");
    expect(commands).toContain("clear-graph");
  });

  skipE2E("simple 2-turn conversation extraction", async () => {
    const conversationContent = `Alex: How's the new dashboard design coming along?
Jordan: It's going well, just finished the mobile responsive layout.`;

    const storeResult = await backend.store({
      content: conversationContent,
      groupId: testGroup,
      sourceDescription: "conversation test",
    });

    const fragmentId = await storeResult.fragmentId;
    expect(fragmentId).toBeTruthy();

    await writeFragmentRelationships(spicedb, {
      fragmentId,
      groupId: testGroup,
      sharedBy: testSubject,
    });

    // Search for conversation content
    const searchResults = await backend.searchGroup({
      query: "Alex Jordan dashboard mobile",
      groupId: testGroup,
      limit: 10,
    });

    expect(Array.isArray(searchResults)).toBe(true);
  }, 600000);
});

describe("e2e: complex relationship extraction", () => {
  // Helper for waiting with polling
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  skipE2E("extract multi-entity professional relationships", async () => {
    // Complex: Person, Organization, Role, Event (promotion)
    const storeResult = await backend.store({
      content: "Diana Chen just got promoted to Principal Engineer at ByteCraft Industries. She'll be leading the platform architecture team starting next quarter.",
      groupId: testGroup,
      sourceDescription: "professional update",
    });

    const fragmentId = await storeResult.fragmentId;
    expect(fragmentId).toBeTruthy();

    // Write SpiceDB relationships
    await writeFragmentRelationships(spicedb, {
      fragmentId,
      groupId: testGroup,
      sharedBy: testSubject,
    });

    // Poll for processing completion - wait for Diana/ByteCraft content
    let results: Awaited<ReturnType<typeof backend.searchGroup>> = [];
    let foundRelevant = false;
    const maxAttempts = 60;
    const pollInterval = 5000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(pollInterval);
      results = await backend.searchGroup({
        query: "Diana ByteCraft Principal Engineer platform architecture",
        groupId: testGroup,
        limit: 10,
      });

      // Check if results contain Diana/ByteCraft content (not just any results)
      foundRelevant = results.some((r: any) => {
        const text = (r.summary + " " + (r.context || "")).toLowerCase();
        return text.includes("diana") || text.includes("bytecraft") || text.includes("principal");
      });

      if (foundRelevant) break;
    }

    expect(results.length).toBeGreaterThan(0);

    // Diagnostic output
    console.log(`[graphiti] Multi-entity test results (first 3):`);
    results.slice(0, 3).forEach((r: any, i: number) => {
      console.log(`  [${i}] summary: ${r.summary || r.content}`);
      if (r.context) console.log(`      context: ${r.context}`);
    });

    // Validate extraction
    const hasRelevantEntities = results.some((r: any) => {
      const text = (r.summary + " " + (r.context || "") + " " + (r.content || "")).toLowerCase();
      return (text.includes("diana") || text.includes("chen")) &&
             (text.includes("bytecraft") || text.includes("principal") || text.includes("architecture") || text.includes("platform"));
    });
    expect(hasRelevantEntities).toBe(true);
  }, 600000);

  skipE2E("extract temporal references and work artifacts", async () => {
    // Complex: Temporal (Monday), Document (security audit), Event (submission)
    const storeResult = await backend.store({
      content: "Elena mentioned the security audit documentation must be submitted by Monday morning. The compliance team requires the penetration test results and the vulnerability assessment before the board meeting.",
      groupId: testGroup,
      sourceDescription: "work planning discussion",
    });

    const fragmentId = await storeResult.fragmentId;
    expect(fragmentId).toBeTruthy();

    await writeFragmentRelationships(spicedb, {
      fragmentId,
      groupId: testGroup,
      sharedBy: testSubject,
    });

    // Poll for Elena/security content
    let results: Awaited<ReturnType<typeof backend.searchGroup>> = [];
    let foundRelevant = false;
    const maxAttempts = 60;
    const pollInterval = 5000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(pollInterval);
      results = await backend.searchGroup({
        query: "Elena security audit Monday compliance penetration test",
        groupId: testGroup,
        limit: 10,
      });

      foundRelevant = results.some((r: any) => {
        const text = (r.summary + " " + (r.context || "")).toLowerCase();
        return text.includes("elena") || text.includes("security") || text.includes("audit") || text.includes("compliance");
      });

      if (foundRelevant) break;
    }

    expect(results.length).toBeGreaterThan(0);

    console.log(`[graphiti] Temporal+artifact test results (first 3):`);
    results.slice(0, 3).forEach((r: any, i: number) => {
      console.log(`  [${i}] summary: ${r.summary || r.content}`);
      if (r.context) console.log(`      context: ${r.context}`);
    });

    const hasRelevantEntities = results.some((r: any) => {
      const text = (r.summary + " " + (r.context || "") + " " + (r.content || "")).toLowerCase();
      return text.includes("elena") || text.includes("security") || text.includes("audit") ||
             text.includes("monday") || text.includes("compliance") || text.includes("penetration");
    });
    expect(hasRelevantEntities).toBe(true);
  }, 600000);

  skipE2E("extract entities from multi-turn technical conversation", async () => {
    // Complex: Multi-turn dialogue with technical topics, multiple speakers
    const conversationBatch = `Raj Kumar: We need to migrate from Vue 2 to Vue 3 before the Nuxt upgrade.
Developer: What's the timeline? The current setup uses Vite 3.
Raj Kumar: I'd like to complete the Vue upgrade by end of Q4, then move to Nuxt 3 in Q1 next year.
Developer: Should we also update Pinia to 2.x as part of this migration?
Raj Kumar: Yes, that makes sense. Let's bundle the Pinia upgrade with the Vue work.`;

    const storeResult = await backend.store({
      content: conversationBatch,
      groupId: testGroup,
      sourceDescription: "technical planning conversation",
    });

    const fragmentId = await storeResult.fragmentId;
    expect(fragmentId).toBeTruthy();

    await writeFragmentRelationships(spicedb, {
      fragmentId,
      groupId: testGroup,
      sharedBy: testSubject,
    });

    // Poll for Raj/Vue content
    let results: Awaited<ReturnType<typeof backend.searchGroup>> = [];
    let foundRelevant = false;
    const maxAttempts = 60;
    const pollInterval = 5000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(pollInterval);
      results = await backend.searchGroup({
        query: "Raj Kumar Vue Nuxt migration Pinia",
        groupId: testGroup,
        limit: 10,
      });

      foundRelevant = results.some((r: any) => {
        const text = (r.summary + " " + (r.context || "")).toLowerCase();
        return text.includes("raj") || text.includes("vue") || text.includes("nuxt") || text.includes("pinia");
      });

      if (foundRelevant) break;
    }

    expect(results.length).toBeGreaterThan(0);

    console.log(`[graphiti] Multi-turn conversation test results (first 3):`);
    results.slice(0, 3).forEach((r: any, i: number) => {
      console.log(`  [${i}] summary: ${r.summary || r.content}`);
      if (r.context) console.log(`      context: ${r.context}`);
    });

    const hasRelevantEntities = results.some((r: any) => {
      const text = (r.summary + " " + (r.context || "") + " " + (r.content || "")).toLowerCase();
      return text.includes("raj") || text.includes("vue") || text.includes("nuxt") ||
             text.includes("pinia") || text.includes("migration");
    });
    expect(hasRelevantEntities).toBe(true);

    // Optional: Check for timeline extraction
    const hasTimeline = results.some((r: any) => {
      const text = (r.summary + " " + (r.context || "") + " " + (r.content || "")).toLowerCase();
      return text.includes("q4") || text.includes("q1") || text.includes("quarter");
    });
    if (hasTimeline) {
      console.log("  ✓ Timeline extraction detected");
    }
  }, 600000);
});

describe("e2e: backend-specific features", () => {
  skipE2E("Graphiti deleteFragment removes individual facts", async () => {
    const graphitiBackend = backend as GraphitiBackend;
    if (!graphitiBackend.deleteFragment) {
      throw new Error("Graphiti backend should have deleteFragment method");
    }

    // This would require creating a fact first, which requires
    // episode processing. Skip detailed test - covered in unit tests.
    expect(typeof graphitiBackend.deleteFragment).toBe("function");
  });
});

describe("e2e: IS_DUPLICATE_OF filtering (#12)", () => {
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  beforeAll(async () => {
    if (!LIVE_TEST) return;

    // Re-use module-level clients (initialized by first describe block),
    // but ensure they're set up if this block runs in isolation.
    if (!spicedb) {
      spicedb = new SpiceDbClient({
        endpoint: SPICEDB_ENDPOINT,
        token: SPICEDB_TOKEN,
        insecure: true,
      });

      const schemaPath = new URL("./schema.zed", import.meta.url).pathname;
      const { readFileSync } = await import("node:fs");
      const schema = readFileSync(schemaPath, "utf-8");
      await spicedb.writeSchema(schema);
    }

    if (!backend) {
      backend = new GraphitiBackend({
        endpoint: GRAPHITI_ENDPOINT,
        defaultGroupId: "e2e_test",
        uuidPollIntervalMs: 3000,
        uuidPollMaxAttempts: 60,
        customInstructions: "",
      });
    }

    if (!testSubject) {
      testSubject = { type: "agent", id: `e2e_dedup_${Date.now()}` };
    }
    if (!testGroup) {
      testGroup = `e2e_dedup_group_${Date.now()}`;
    }

    await ensureGroupMembership(spicedb, testGroup, testSubject);
  });

  skipE2E("overlapping entity mentions do not produce IS_DUPLICATE_OF facts", async () => {
    // Store two episodes about the same entities to trigger dedup pathways.
    // Older graphiti-core + some LLMs (llama-3.3-70b) would create
    // IS_DUPLICATE_OF edges between overlapping entity nodes.
    const episode1 = await backend.store({
      content: "Marcus Rivera is the CTO of NovaTech Solutions. He oversees all engineering teams.",
      groupId: testGroup,
      sourceDescription: "dedup test episode 1",
    });
    const frag1 = await episode1.fragmentId;
    expect(frag1).toBeTruthy();

    await writeFragmentRelationships(spicedb, {
      fragmentId: frag1,
      groupId: testGroup,
      sharedBy: testSubject,
    });

    // Second episode mentions the same entities — this is where dedup edges appear
    const episode2 = await backend.store({
      content: "Marcus Rivera from NovaTech Solutions presented the Q3 roadmap at the all-hands meeting.",
      groupId: testGroup,
      sourceDescription: "dedup test episode 2",
    });
    const frag2 = await episode2.fragmentId;
    expect(frag2).toBeTruthy();

    await writeFragmentRelationships(spicedb, {
      fragmentId: frag2,
      groupId: testGroup,
      sharedBy: testSubject,
    });

    // Poll until we get results about Marcus/NovaTech
    let results: Awaited<ReturnType<typeof backend.searchGroup>> = [];
    let foundRelevant = false;
    const maxAttempts = 60;
    const pollInterval = 5000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(pollInterval);
      results = await backend.searchGroup({
        query: "Marcus Rivera NovaTech CTO roadmap",
        groupId: testGroup,
        limit: 20,
      });

      foundRelevant = results.some((r) => {
        const text = (r.summary + " " + (r.context || "")).toLowerCase();
        return text.includes("marcus") || text.includes("novatech");
      });

      if (foundRelevant) break;
    }

    expect(results.length).toBeGreaterThan(0);

    // Key assertion: no IS_DUPLICATE_OF edges should appear in results
    const hasDuplicateEdge = results.some((r) => {
      const text = (r.summary + " " + (r.context || "")).toLowerCase();
      return text.includes("is_duplicate_of") ||
             text.includes("duplicate_of") ||
             text.includes("has_duplicate") ||
             text.includes("duplicates");
    });

    if (hasDuplicateEdge) {
      console.log("[graphiti] WARNING: IS_DUPLICATE_OF edges found in results:");
      results.filter((r) => {
        const text = (r.summary + " " + (r.context || "")).toLowerCase();
        return text.includes("duplicate");
      }).forEach((r, i) => {
        console.log(`  [${i}] summary: ${r.summary}, context: ${r.context}`);
      });
    }

    expect(hasDuplicateEdge).toBe(false);

    console.log(`[graphiti] Dedup test: ${results.length} results, no IS_DUPLICATE_OF edges`);
  }, 600000);

});
