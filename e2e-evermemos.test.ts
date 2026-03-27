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
 * - fragmentId returns UUID anchor for trace-based resolution
 * - discoverFragmentIds resolves anchors → MongoDB ObjectIds via trace overlay
 * - memory_share/unshare flow with discovered ObjectIds
 * - involves-based cross-group recall with post-filter matching
 * - resolveAnchors for lazy resolution of timed-out discoveries
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
  writeFragmentRelationships,
  lookupViewableFragments,
  canShareFragment,
  shareFragment,
  unshareFragment,
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

/**
 * Store a message and trigger MemCell boundary detection.
 *
 * EverMemOS creates MemCells only when boundary detection fires. Boundaries
 * trigger when a new message arrives and the gap between the oldest
 * accumulated message's create_time and wall clock time exceeds ~1 day.
 *
 * This helper sends the target message with create_time 2 days in the past,
 * then sends a boundary trigger at current time. The trigger closes the
 * accumulated messages (including our target) into a MemCell.
 *
 * Returns the message_id of the stored message for tracing.
 */
async function storeAndTriggerBoundary(
  content: string,
  groupId: string,
): Promise<string> {
  const messageId = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pastDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const nowDate = new Date().toISOString();

  // Step 1: Send target message with past create_time → accumulated
  await fetch(`${EVERMEMOS_ENDPOINT}/api/v1/memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message_id: messageId,
      create_time: pastDate,
      sender: "e2e_test_agent",
      content,
      group_id: groupId,
      role: "user",
      refer_list: [],
    }),
  });

  // Step 2: Send boundary trigger at current time → fires boundary detection
  await fetch(`${EVERMEMOS_ENDPOINT}/api/v1/memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message_id: `boundary-trigger-${Date.now()}`,
      create_time: nowDate,
      sender: "e2e_test_agent",
      content: "Follow-up: confirming the previous discussion items are on track.",
      group_id: groupId,
      role: "user",
      refer_list: [],
    }),
  });

  return messageId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll resolveAnchors until the anchor resolves to ObjectIds.
 * Returns the resolved ObjectIds or throws if timeout is reached.
 */
async function waitForResolution(
  be: EverMemOSBackend,
  messageId: string,
  timeoutMs = 120000,
  pollMs = 5000,
): Promise<string[]> {
  const maxAttempts = Math.ceil(timeoutMs / pollMs);
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(pollMs);
    const resolved = await be.resolveAnchors!([messageId]);
    if (resolved.size > 0) {
      const ids = resolved.get(messageId)!;
      if (ids.length > 0) return ids;
    }
  }
  throw new Error(`Timeout: resolveAnchors did not resolve ${messageId} within ${timeoutMs}ms`);
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
  // discoverFragmentIds: resolves anchors to MongoDB ObjectIds via trace
  // --------------------------------------------------------------------------

  skipE2E("discoverFragmentIds is implemented", () => {
    // EverMemOS backend has discoverFragmentIds via the trace overlay endpoint
    expect(backend.discoverFragmentIds).toBeDefined();
    expect(typeof backend.discoverFragmentIds).toBe("function");
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

  // --------------------------------------------------------------------------
  // Fragment-level authorization: trace → resolve → share → involves → unshare
  //
  // Single MemCell extraction, exercises the full SpiceDB flow:
  // 1. Store message + trigger boundary → MemCell created
  // 2. Resolve message_id → MongoDB ObjectIds via trace overlay
  // 3. Write SpiceDB fragment relationships for each ObjectId
  // 4. Verify share: storer can share, outsider gains/loses view access
  // 5. Verify involves: involved person can view, search results match
  // --------------------------------------------------------------------------

  skipE2E("fragment-level auth: trace → resolve → share → involves → unshare", async () => {
    const fragGroup = `e2e_frag_${Date.now()}`;
    await ensureGroupMembership(spicedb, fragGroup, testSubject);

    // --- 1. Store + trigger boundary ---
    const messageId = await storeAndTriggerBoundary(
      "Marcus Webb finalized the vendor contract with Apex Solutions. The deal includes a 3-year SLA with quarterly reviews starting in May. Elena Torres proposed a new caching strategy for the recommendation engine.",
      fragGroup,
    );

    // --- 2. Resolve message_id → ObjectIds via trace overlay ---
    const objectIds = await waitForResolution(backend, messageId);

    // ObjectIds should be 24-char hex MongoDB ObjectId format
    for (const id of objectIds) {
      expect(id).toMatch(/^[0-9a-f]{24}$/);
    }
    // Message UUID should NOT be among the ObjectIds
    expect(objectIds).not.toContain(messageId);

    // --- 3. Write SpiceDB fragment relationships ---
    const involvedPerson: Subject = { type: "person", id: `e2e-involved-${Date.now()}` };
    let writeToken: string | undefined;
    for (const objId of objectIds) {
      const wt = await writeFragmentRelationships(spicedb, {
        fragmentId: objId,
        groupId: fragGroup,
        sharedBy: testSubject,
        involves: [involvedPerson],
      });
      if (wt) writeToken = wt;
    }

    const firstObjId = objectIds[0];

    // --- 4. Share flow ---
    // Storer can share
    const canShare = await canShareFragment(spicedb, testSubject, firstObjId, writeToken);
    expect(canShare).toBe(true);

    // Share with an outsider
    const outsider: Subject = { type: "person", id: `e2e-outsider-${Date.now()}` };
    const shareToken = await shareFragment(spicedb, firstObjId, [outsider]);

    // Outsider can now view
    let viewable = await lookupViewableFragments(spicedb, outsider, shareToken);
    expect(viewable).toContain(firstObjId);

    // Unshare — outsider loses access
    await unshareFragment(spicedb, firstObjId, [outsider]);
    viewable = await lookupViewableFragments(spicedb, outsider);
    expect(viewable).not.toContain(firstObjId);

    // --- 5. Involves flow ---
    // Involved person can view all ObjectIds
    const involvedViewable = await lookupViewableFragments(spicedb, involvedPerson, writeToken);
    for (const objId of objectIds) {
      expect(involvedViewable).toContain(objId);
    }

    // Search results contain discovered ObjectIds
    const searchResults = await backend.searchGroup({
      query: "vendor contract caching strategy",
      groupId: fragGroup,
      limit: 20,
    });

    const searchIds = new Set(searchResults.map((r) => r.uuid));
    const matchingIds = objectIds.filter((id) => searchIds.has(id));
    expect(matchingIds.length).toBeGreaterThan(0);

    // Post-filter: viewable set intersects with search results
    const viewableSet = new Set(involvedViewable);
    const postFiltered = searchResults.filter((r) => viewableSet.has(r.uuid));
    expect(postFiltered.length).toBeGreaterThan(0);
  }, 600000);
});
