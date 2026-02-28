/**
 * Authorization tests
 *
 * These tests are identical to openclaw-memory-graphiti/authorization.test.ts
 * because authorization.ts was copied verbatim (backend-agnostic implementation).
 *
 * No changes needed from the original test suite.
 */

import { describe, test, expect } from "vitest";
import {
  lookupAuthorizedGroups,
  writeFragmentRelationships,
  deleteFragmentRelationships,
  canDeleteFragment,
  canWriteToGroup,
  ensureGroupMembership,
  type Subject,
} from "./authorization.js";

describe("authorization", () => {
  test("Subject type can be agent or person", () => {
    const agent: Subject = { type: "agent", id: "agent-1" };
    const person: Subject = { type: "person", id: "person-1" };

    expect(agent.type).toBe("agent");
    expect(person.type).toBe("person");
  });

  test("FragmentRelationships includes optional involves array", () => {
    const params = {
      fragmentId: "frag-1",
      groupId: "group-main",
      sharedBy: { type: "agent" as const, id: "agent-1" },
      involves: [
        { type: "person" as const, id: "person-a" },
        { type: "person" as const, id: "person-b" },
      ],
    };

    expect(params.involves).toHaveLength(2);
    expect(params.involves?.[0].id).toBe("person-a");
  });

  test("authorization functions exist and have correct signatures", () => {
    // Type-level checks — these functions should be callable with the expected params
    expect(typeof lookupAuthorizedGroups).toBe("function");
    expect(typeof writeFragmentRelationships).toBe("function");
    expect(typeof deleteFragmentRelationships).toBe("function");
    expect(typeof canDeleteFragment).toBe("function");
    expect(typeof canWriteToGroup).toBe("function");
    expect(typeof ensureGroupMembership).toBe("function");
  });
});
