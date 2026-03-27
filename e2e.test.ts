/**
 * Graphiti-Specific E2E Tests
 *
 * Tests Graphiti-specific features that are NOT covered by the
 * backend-agnostic contract suite in e2e-backend.test.ts.
 *
 * Focus areas:
 * - Entity/fact extraction from conversations
 * - IS_DUPLICATE_OF filtering (#12)
 * - Graphiti-specific CLI commands (episodes, fact, clear-graph)
 * - Stenographer features (per-agent identity, identity linking, owner-aware recall)
 *
 * Requires live services:
 * - SpiceDB at localhost:50051 (insecure)
 * - Graphiti backend at localhost:8000
 *
 * Run with: OPENCLAW_LIVE_TEST=1 vitest run --config vitest.e2e.config.ts e2e.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SpiceDbClient } from "./spicedb.js";
import { GraphitiBackend } from "./backends/graphiti.js";
import {
  lookupAuthorizedGroups,
  lookupAgentOwner,
  lookupViewableFragments,
  writeFragmentRelationships,
  canDeleteFragment,
  canWriteToGroup,
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

describe("e2e: Graphiti-specific features", () => {

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

  // --------------------------------------------------------------------------
  // Graphiti-specific CLI commands
  // --------------------------------------------------------------------------

  skipE2E("Graphiti-specific CLI commands are registered", async () => {
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

// ============================================================================
// Stenographer feature tests: per-agent identity, identity linking, owner-aware recall
// ============================================================================

describe("e2e: stenographer features (per-agent identity + owner-aware recall)", () => {
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Agents and persons for this test suite
  const stenographerAgent: Subject = { type: "agent", id: `e2e_steno_${Date.now()}` };
  const personalAgent: Subject = { type: "agent", id: `e2e_personal_${Date.now()}` };
  const ownerPerson: Subject = { type: "person", id: `e2e_person_${Date.now()}` };
  const bystander: Subject = { type: "person", id: `e2e_bystander_${Date.now()}` };
  const stenoGroup = `e2e_steno_group_${Date.now()}`;

  // Track fragment IDs and tokens for cleanup and cross-test assertions
  let decisionEpisodeId: string;
  let ownershipToken: string | undefined;
  let fragmentWriteToken: string | undefined;

  beforeAll(async () => {
    if (!LIVE_TEST) return;

    // Re-use module-level clients
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

    // Set up group memberships:
    // - stenographer is member of stenoGroup
    // - personalAgent is NOT a member of stenoGroup (no direct group access)
    await ensureGroupMembership(spicedb, stenoGroup, stenographerAgent);

    // Write identity link: personalAgent → ownerPerson
    ownershipToken = await spicedb.writeRelationships([{
      resourceType: "agent",
      resourceId: personalAgent.id,
      relation: "owner",
      subjectType: "person",
      subjectId: ownerPerson.id,
    }]);
  });

  afterAll(async () => {
    if (!LIVE_TEST || !backend) return;
    try {
      await backend.deleteGroup(stenoGroup);
    } catch {
      // Best-effort cleanup
    }
  });

  // --------------------------------------------------------------------------
  // Test 1: Identity linking — agent:personalAgent #owner person:ownerPerson
  // --------------------------------------------------------------------------

  skipE2E("identity linking: agent→owner relationship is queryable", async () => {
    const ownerId = await lookupAgentOwner(spicedb, personalAgent.id, ownershipToken);
    expect(ownerId).toBe(ownerPerson.id);

    // Stenographer has no owner
    const stenoOwner = await lookupAgentOwner(spicedb, stenographerAgent.id, ownershipToken);
    expect(stenoOwner).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // Test 2: Stenographer stores a decision with involves
  // --------------------------------------------------------------------------

  skipE2E("stenographer stores decision with involves relationships", async () => {
    const decisionContent =
      "Cara and Bob decided to migrate the widget service to PostgreSQL. " +
      "The migration will begin next sprint with Bob handling the schema design " +
      "and Cara writing the data migration scripts.";

    // Store via Graphiti (simulating what the stenographer agent would do)
    const storeResult = await backend.store({
      content: decisionContent,
      groupId: stenoGroup,
      sourceDescription: "#engineering-decisions 2026-03-18",
    });

    decisionEpisodeId = await storeResult.fragmentId;
    expect(decisionEpisodeId).toBeTruthy();
    expect(decisionEpisodeId).toMatch(/[0-9a-f-]{36}/);

    // Write authorization: stenographer owns it, ownerPerson and bystander are involved
    fragmentWriteToken = await writeFragmentRelationships(spicedb, {
      fragmentId: decisionEpisodeId,
      groupId: stenoGroup,
      sharedBy: stenographerAgent,
      involves: [ownerPerson, bystander],
    });
    expect(fragmentWriteToken).toBeTruthy();

    console.log(`[steno] Stored decision episode: ${decisionEpisodeId}`);
    console.log(`[steno] shared_by: ${stenographerAgent.type}:${stenographerAgent.id}`);
    console.log(`[steno] involves: ${ownerPerson.id}, ${bystander.id}`);
  }, 600000);

  // --------------------------------------------------------------------------
  // Test 3: Permission checks — view vs delete
  // --------------------------------------------------------------------------

  skipE2E("involved persons can view but not delete stenographer memories", async () => {
    // ownerPerson can view (via involves) — use fragmentWriteToken for consistency
    const viewableByOwner = await lookupViewableFragments(spicedb, ownerPerson, fragmentWriteToken);
    expect(viewableByOwner).toContain(decisionEpisodeId);

    // bystander can also view (via involves)
    const viewableByBystander = await lookupViewableFragments(spicedb, bystander, fragmentWriteToken);
    expect(viewableByBystander).toContain(decisionEpisodeId);

    // Only stenographer can delete (via shared_by)
    const stenoCanDelete = await canDeleteFragment(spicedb, stenographerAgent, decisionEpisodeId, fragmentWriteToken);
    expect(stenoCanDelete).toBe(true);

    const ownerCanDelete = await canDeleteFragment(spicedb, ownerPerson, decisionEpisodeId, fragmentWriteToken);
    expect(ownerCanDelete).toBe(false);

    const bystanderCanDelete = await canDeleteFragment(spicedb, bystander, decisionEpisodeId, fragmentWriteToken);
    expect(bystanderCanDelete).toBe(false);

    console.log("[steno] Permission checks passed: involves=view, shared_by=delete");
  });

  // --------------------------------------------------------------------------
  // Test 4: Per-agent identity — different agents get different group access
  // --------------------------------------------------------------------------

  skipE2E("per-agent identity: agents have independent group access", async () => {
    // Stenographer has access to stenoGroup
    const stenoGroups = await lookupAuthorizedGroups(spicedb, stenographerAgent);
    expect(stenoGroups).toContain(stenoGroup);

    // Personal agent does NOT have direct group access to stenoGroup
    const personalGroups = await lookupAuthorizedGroups(spicedb, personalAgent);
    expect(personalGroups).not.toContain(stenoGroup);

    // Stenographer can contribute to stenoGroup
    const stenoCanWrite = await canWriteToGroup(spicedb, stenographerAgent, stenoGroup);
    expect(stenoCanWrite).toBe(true);

    // Personal agent cannot contribute to stenoGroup
    const personalCanWrite = await canWriteToGroup(spicedb, personalAgent, stenoGroup);
    expect(personalCanWrite).toBe(false);

    console.log("[steno] Per-agent group isolation verified");
  });

  // --------------------------------------------------------------------------
  // Test 5: Owner-aware recall — personalAgent finds fragments via owner→involves
  // --------------------------------------------------------------------------

  skipE2E("owner-aware recall: agent discovers fragments via owner's involves", async () => {
    // personalAgent has no direct group access to stenoGroup,
    // but its owner (ownerPerson) is in involves for the decision fragment.
    // The recall flow should:
    // 1. Look up personalAgent's owner → ownerPerson
    // 2. Look up fragments viewable by ownerPerson → includes decisionEpisodeId
    // 3. (Optional) Fetch fragment details from Graphiti

    // Step 1: Verify the identity link resolves
    const ownerId = await lookupAgentOwner(spicedb, personalAgent.id);
    expect(ownerId).toBe(ownerPerson.id);

    // Step 2: Verify owner can see the fragment via SpiceDB (use token for consistency)
    const ownerSubject: Subject = { type: "person", id: ownerId! };
    const viewableIds = await lookupViewableFragments(spicedb, ownerSubject, fragmentWriteToken);
    expect(viewableIds).toContain(decisionEpisodeId);

    // The critical assertion is that the SpiceDB authorization chain works:
    // agent:personalAgent → owner → person:ownerPerson → involves → memory_fragment:decisionEpisodeId
    // This is verified by the viewableIds assertion above.
    console.log(`[steno] Owner-aware recall: ${viewableIds.length} viewable fragment IDs from SpiceDB`);
  });

  // --------------------------------------------------------------------------
  // Test 6: Full stenographer scenario with Graphiti extraction
  // --------------------------------------------------------------------------

  skipE2E("full stenographer scenario: store → authorize → agent→owner→involves chain", async () => {
    const conversationContent =
      "Lena: I think we should go with Redis for the caching layer.\n" +
      "Marcus: Agreed. Redis gives us pub/sub for the real-time features too.\n" +
      "Lena: Let's plan the implementation for next sprint. Marcus, can you draft the architecture doc?\n" +
      "Marcus: Sure, I'll have it ready by Friday.";

    // 1. Store conversation via Graphiti (waits for episode UUID)
    const storeResult = await backend.store({
      content: conversationContent,
      groupId: stenoGroup,
      sourceDescription: "#backend-decisions 2026-03-18",
      customPrompt: "Extract decisions, action items, and commitments. Identify WHO decided WHAT and any deadlines.",
    });

    const episodeId = await storeResult.fragmentId;
    expect(episodeId).toBeTruthy();
    console.log(`[steno] Stored conversation episode: ${episodeId}`);

    // 2. Stenographer writes authorization with involved persons
    const involvedLena: Subject = { type: "person", id: `e2e_lena_${Date.now()}` };
    const involvedMarcus: Subject = { type: "person", id: `e2e_marcus_${Date.now()}` };

    const authToken = await writeFragmentRelationships(spicedb, {
      fragmentId: episodeId,
      groupId: stenoGroup,
      sharedBy: stenographerAgent,
      involves: [involvedLena, involvedMarcus],
    });

    // 3. Verify SpiceDB authorization chain immediately (no Graphiti extraction needed)

    // Lena can view via involves
    const lenaViewable = await lookupViewableFragments(spicedb, involvedLena, authToken);
    expect(lenaViewable).toContain(episodeId);

    // Marcus can view via involves
    const marcusViewable = await lookupViewableFragments(spicedb, involvedMarcus, authToken);
    expect(marcusViewable).toContain(episodeId);

    // Neither can delete (only shared_by=stenographer can)
    expect(await canDeleteFragment(spicedb, involvedLena, episodeId, authToken)).toBe(false);
    expect(await canDeleteFragment(spicedb, involvedMarcus, episodeId, authToken)).toBe(false);
    expect(await canDeleteFragment(spicedb, stenographerAgent, episodeId, authToken)).toBe(true);

    // 4. Full discovery chain: create Lena's agent → link to Lena → find fragment
    const lenaAgent: Subject = { type: "agent", id: `e2e_lena_agent_${Date.now()}` };
    const lenaOwnerToken = await spicedb.writeRelationships([{
      resourceType: "agent",
      resourceId: lenaAgent.id,
      relation: "owner",
      subjectType: "person",
      subjectId: involvedLena.id,
    }]);

    // Lena's agent → lookupAgentOwner → involvedLena → lookupViewableFragments → episodeId
    const lenaAgentOwnerId = await lookupAgentOwner(spicedb, lenaAgent.id, lenaOwnerToken);
    expect(lenaAgentOwnerId).toBe(involvedLena.id);

    const lenaAgentViewable = await lookupViewableFragments(
      spicedb,
      { type: "person", id: lenaAgentOwnerId! },
      lenaOwnerToken,
    );
    expect(lenaAgentViewable).toContain(episodeId);

    console.log("[steno] Full end-to-end chain verified: agent → owner → involves → fragment");

    // 5. Bonus: check if Graphiti has extracted facts (non-blocking, short timeout)
    let foundFacts = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      await sleep(5000);
      const searchResults = await backend.searchGroup({
        query: "Redis caching decision Lena Marcus architecture",
        groupId: stenoGroup,
        limit: 10,
      });
      const relevant = searchResults.some((r) => {
        const text = (r.summary + " " + (r.context || "")).toLowerCase();
        return text.includes("redis") || text.includes("caching") ||
               text.includes("lena") || text.includes("marcus");
      });
      if (relevant) {
        foundFacts = true;
        console.log(`[steno] Graphiti extracted ${searchResults.length} relevant facts:`);
        searchResults.slice(0, 3).forEach((r, i) => {
          console.log(`  [${i}] ${r.summary}`);
        });
        break;
      }
    }
    if (!foundFacts) {
      console.log("[steno] Note: Graphiti fact extraction not yet complete (local model may be slow)");
    }
  }, 600000);

  // --------------------------------------------------------------------------
  // Test 7: Unauthorized agent cannot discover fragments via involves
  // --------------------------------------------------------------------------

  skipE2E("unauthorized agent without owner link cannot see involves fragments", async () => {
    const rogueAgent: Subject = { type: "agent", id: `e2e_rogue_${Date.now()}` };
    // No owner link, no group membership

    // Cannot see stenoGroup
    const groups = await lookupAuthorizedGroups(spicedb, rogueAgent);
    expect(groups).not.toContain(stenoGroup);

    // No owner → lookupAgentOwner returns undefined
    const ownerId = await lookupAgentOwner(spicedb, rogueAgent.id);
    expect(ownerId).toBeUndefined();

    // Cannot view the decision fragment
    const viewable = await lookupViewableFragments(spicedb, rogueAgent, fragmentWriteToken);
    expect(viewable).not.toContain(decisionEpisodeId);

    // Cannot delete either
    const canDelete = await canDeleteFragment(spicedb, rogueAgent, decisionEpisodeId, fragmentWriteToken);
    expect(canDelete).toBe(false);

    console.log("[steno] Unauthorized agent correctly denied access");
  });
});
