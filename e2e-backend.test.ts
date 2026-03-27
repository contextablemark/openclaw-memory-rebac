/**
 * Backend-Agnostic E2E Contract Tests
 *
 * These tests validate that any MemoryBackend implementation satisfies
 * the contract defined by the MemoryBackend interface. They run against
 * whichever backend is configured via E2E_BACKEND env var.
 *
 * Run with:
 *   E2E_BACKEND=graphiti OPENCLAW_LIVE_TEST=1 vitest run --config vitest.e2e.config.ts e2e-backend.test.ts
 *   E2E_BACKEND=evermemos OPENCLAW_LIVE_TEST=1 vitest run --config vitest.e2e.config.ts e2e-backend.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SpiceDbClient } from "./spicedb.js";
import { backendRegistry } from "./backends/registry.js";
import type { MemoryBackend } from "./backend.js";
import {
  lookupAuthorizedGroups,
  writeFragmentRelationships,
  deleteFragmentRelationships,
  canDeleteFragment,
  canWriteToGroup,
  ensureGroupMembership,
  ensureGroupOwnership,
  canShareFragment,
  shareFragment,
  unshareFragment,
  lookupViewableFragments,
  type Subject,
} from "./authorization.js";

const LIVE_TEST = process.env.OPENCLAW_LIVE_TEST === "1";
const skipE2E = LIVE_TEST ? test : test.skip;

const BACKEND_NAME = process.env.E2E_BACKEND || "graphiti";

const SPICEDB_ENDPOINT = process.env.SPICEDB_ENDPOINT || "localhost:50051";
const SPICEDB_TOKEN = process.env.SPICEDB_TOKEN || "dev_token";

// Backend-specific endpoint defaults
const BACKEND_ENDPOINTS: Record<string, string> = {
  graphiti: process.env.GRAPHITI_ENDPOINT || "http://localhost:8000",
  evermemos: process.env.EVERMEMOS_ENDPOINT || "http://localhost:1995",
};

let spicedb: SpiceDbClient;
let backend: MemoryBackend;
let testSubject: Subject;
let testGroup: string;

describe(`e2e: backend-agnostic contract (${BACKEND_NAME})`, () => {
  beforeAll(async () => {
    if (!LIVE_TEST) return;

    const backendModule = backendRegistry[BACKEND_NAME];
    if (!backendModule) throw new Error(`Unknown backend: ${BACKEND_NAME}`);

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

    // Initialize backend with defaults + endpoint override
    const config = {
      ...backendModule.defaults,
      endpoint: BACKEND_ENDPOINTS[BACKEND_NAME] ?? backendModule.defaults.endpoint,
    };
    backend = backendModule.create(config as Record<string, unknown>);

    testSubject = { type: "agent", id: `e2e_${BACKEND_NAME}_${Date.now()}` };
    testGroup = `e2e_${BACKEND_NAME}_group_${Date.now()}`;

    await ensureGroupMembership(spicedb, testGroup, testSubject);
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
  // Lifecycle
  // --------------------------------------------------------------------------

  skipE2E("backend has a non-empty name", () => {
    expect(backend.name).toBeTruthy();
    expect(typeof backend.name).toBe("string");
  });

  skipE2E("health check succeeds", async () => {
    const healthy = await backend.healthCheck();
    expect(healthy).toBe(true);
  });

  skipE2E("getStatus returns healthy status", async () => {
    const status = await backend.getStatus();
    expect(status.backend).toBe(BACKEND_NAME);
    expect(status.healthy).toBe(true);
  });

  // --------------------------------------------------------------------------
  // SpiceDB
  // --------------------------------------------------------------------------

  skipE2E("SpiceDB schema contains required definitions", async () => {
    const schema = await spicedb.readSchema();
    expect(schema).toContain("definition memory_fragment");
    expect(schema).toContain("definition group");
    expect(schema).toContain("definition person");
    expect(schema).toContain("definition agent");
    // New schema features
    expect(schema).toContain("permission share");
    expect(schema).toContain("permission admin");
  });

  // --------------------------------------------------------------------------
  // Store → Search lifecycle
  // --------------------------------------------------------------------------

  skipE2E("store returns valid fragmentId", async () => {
    const result = await backend.store({
      content: "Alice is working on the quarterly report for the marketing team",
      groupId: testGroup,
      sourceDescription: "backend-agnostic e2e test",
    });

    expect(result.fragmentId).toBeInstanceOf(Promise);
    const fragmentId = await result.fragmentId;

    expect(fragmentId).toBeTruthy();
    expect(fragmentId).toMatch(/[0-9a-f-]{36}/); // UUID format
  }, 600000);

  skipE2E("full memory lifecycle: store → authorize → search → forget", async () => {
    const testContent = "Bob manages the infrastructure team at CloudScale Corp";

    // 1. Store
    const storeResult = await backend.store({
      content: testContent,
      groupId: testGroup,
      sourceDescription: "lifecycle test",
    });

    const fragmentId = await storeResult.fragmentId;

    if (fragmentId !== null) {
      // Fragment-level SpiceDB tracking (e.g. Graphiti)
      // 2. Authorize in SpiceDB
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

      // 4. Search (may or may not find results depending on backend processing time)
      const searchResults = await backend.searchGroup({
        query: "Bob infrastructure CloudScale",
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
    } else {
      // No fragment-level SpiceDB tracking (e.g. EverMemOS) — group-level
      // authorization handles access control. Verify group membership still works.
      const authorizedGroups = await lookupAuthorizedGroups(spicedb, testSubject);
      expect(authorizedGroups).toContain(testGroup);

      // Search still works via group authorization
      const searchResults = await backend.searchGroup({
        query: "Bob infrastructure CloudScale",
        groupId: testGroup,
        limit: 10,
      });
      expect(Array.isArray(searchResults)).toBe(true);
    }
  }, 600000);

  // --------------------------------------------------------------------------
  // Authorization
  // --------------------------------------------------------------------------

  skipE2E("authorization prevents unauthorized access", async () => {
    const unauthorizedSubject: Subject = { type: "person", id: "unauthorized-person" };
    const groups = await lookupAuthorizedGroups(spicedb, unauthorizedSubject);
    expect(groups).not.toContain(testGroup);
  });

  skipE2E("group membership grants access", async () => {
    const newMember: Subject = { type: "person", id: `e2e-member-${Date.now()}` };

    let groups = await lookupAuthorizedGroups(spicedb, newMember);
    expect(groups).not.toContain(testGroup);

    const zedToken = await ensureGroupMembership(spicedb, testGroup, newMember);

    groups = await lookupAuthorizedGroups(spicedb, newMember, zedToken);
    expect(groups).toContain(testGroup);
  });

  // --------------------------------------------------------------------------
  // Share / Unshare
  // --------------------------------------------------------------------------

  skipE2E("share → view → unshare → no view chain", async () => {
    // Store a memory
    const storeResult = await backend.store({
      content: "Confidential: Project Falcon launch date is April 15th",
      groupId: testGroup,
      sourceDescription: "share test",
    });
    const fragmentId = await storeResult.fragmentId;

    if (fragmentId === null) {
      // No fragment-level SpiceDB tracking (e.g. EverMemOS).
      // Fragment share/unshare is not applicable — group-level auth handles access.
      return;
    }

    const outsider: Subject = { type: "person", id: `e2e-outsider-${Date.now()}` };

    // Authorize the fragment (storer = testSubject)
    const writeToken = await writeFragmentRelationships(spicedb, {
      fragmentId,
      groupId: testGroup,
      sharedBy: testSubject,
    });

    // Outsider cannot view
    let viewable = await lookupViewableFragments(spicedb, outsider, writeToken);
    expect(viewable).not.toContain(fragmentId);

    // testSubject (storer) can share
    const canShare = await canShareFragment(spicedb, testSubject, fragmentId, writeToken);
    expect(canShare).toBe(true);

    // Share with outsider
    const shareToken = await shareFragment(spicedb, fragmentId, [outsider]);

    // Outsider can now view
    viewable = await lookupViewableFragments(spicedb, outsider, shareToken);
    expect(viewable).toContain(fragmentId);

    // Unshare
    await unshareFragment(spicedb, fragmentId, [outsider]);

    // Outsider can no longer view (need fresh lookup, no token)
    viewable = await lookupViewableFragments(spicedb, outsider);
    expect(viewable).not.toContain(fragmentId);
  }, 600000);

  skipE2E("group owner can share memories from their group", async () => {
    const groupOwner: Subject = { type: "person", id: `e2e-owner-${Date.now()}` };
    const ownerGroup = `e2e_owned_group_${Date.now()}`;

    // Set up group with owner
    await ensureGroupMembership(spicedb, ownerGroup, testSubject);
    const ownerToken = await ensureGroupOwnership(spicedb, ownerGroup, groupOwner);

    // Store a memory (as testSubject, NOT groupOwner)
    const storeResult = await backend.store({
      content: "Engineering standup notes: discussed API redesign",
      groupId: ownerGroup,
      sourceDescription: "owner share test",
    });
    const fragmentId = await storeResult.fragmentId;

    if (fragmentId === null) {
      // No fragment-level SpiceDB tracking (e.g. EverMemOS).
      // Group owner still has admin on the group — verify that.
      const canWrite = await canWriteToGroup(spicedb, groupOwner, ownerGroup, ownerToken);
      expect(canWrite).toBe(true);

      // Cleanup
      try { await backend.deleteGroup(ownerGroup); } catch { /* best-effort */ }
      return;
    }

    const recipient: Subject = { type: "person", id: `e2e-recipient-${Date.now()}` };

    const writeToken = await writeFragmentRelationships(spicedb, {
      fragmentId,
      groupId: ownerGroup,
      sharedBy: testSubject,
    });

    // Group owner (not the storer) can share
    const canShare = await canShareFragment(spicedb, groupOwner, fragmentId, writeToken);
    expect(canShare).toBe(true);

    // Share with recipient
    const shareToken = await shareFragment(spicedb, fragmentId, [recipient]);

    // Recipient can now view
    const viewable = await lookupViewableFragments(spicedb, recipient, shareToken);
    expect(viewable).toContain(fragmentId);

    // Cleanup
    try { await backend.deleteGroup(ownerGroup); } catch { /* best-effort */ }
  }, 600000);

  // --------------------------------------------------------------------------
  // Graceful handling
  // --------------------------------------------------------------------------

  skipE2E("searchGroup handles empty results gracefully", async () => {
    const results = await backend.searchGroup({
      query: "nonexistent query xyz123 zzzz",
      groupId: testGroup,
      limit: 10,
    });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  skipE2E("getConversationHistory returns array", async () => {
    const sessionId = `e2e-session-${Date.now()}`;
    const history = await backend.getConversationHistory(sessionId);
    expect(Array.isArray(history)).toBe(true);
  });

  skipE2E("listGroups returns array", async () => {
    const groups = await backend.listGroups();
    expect(Array.isArray(groups)).toBe(true);
    for (const group of groups) {
      expect(group.name).toBeTruthy();
      expect(group.groupId).toBeTruthy();
    }
  });
});
