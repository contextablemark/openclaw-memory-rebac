/**
 * Authorization Logic
 *
 * Bridges SpiceDB and the memory backend by managing:
 * - Looking up which group_ids a subject can access
 * - Writing fragment authorization relationships when memories are stored
 * - Checking delete permissions
 */

import type { SpiceDbClient, RelationshipTuple, ConsistencyMode } from "./spicedb.js";

// ============================================================================
// Types
// ============================================================================

export type Subject = {
  type: "agent" | "person";
  id: string;
};

export type FragmentRelationships = {
  fragmentId: string;
  groupId: string;
  sharedBy: Subject;
  involves?: Subject[];
};

// ============================================================================
// Helpers
// ============================================================================

function tokenConsistency(zedToken?: string): ConsistencyMode | undefined {
  return zedToken ? { mode: "at_least_as_fresh", token: zedToken } : undefined;
}

// ============================================================================
// Authorization Operations
// ============================================================================

/**
 * Look up all group IDs that a subject has access to.
 * Returns group resource IDs from SpiceDB where the subject has the "access" permission.
 */
export async function lookupAuthorizedGroups(
  spicedb: SpiceDbClient,
  subject: Subject,
  zedToken?: string,
): Promise<string[]> {
  return spicedb.lookupResources({
    resourceType: "group",
    permission: "access",
    subjectType: subject.type,
    subjectId: subject.id,
    consistency: tokenConsistency(zedToken),
  });
}

/**
 * Look up all memory fragment IDs that a subject can view.
 * Used for fine-grained post-filtering when needed.
 */
export async function lookupViewableFragments(
  spicedb: SpiceDbClient,
  subject: Subject,
  zedToken?: string,
): Promise<string[]> {
  return spicedb.lookupResources({
    resourceType: "memory_fragment",
    permission: "view",
    subjectType: subject.type,
    subjectId: subject.id,
    consistency: tokenConsistency(zedToken),
  });
}

/**
 * Write authorization relationships for a newly stored memory fragment.
 *
 * Creates:
 * - memory_fragment:<id> #source_group group:<groupId>
 * - memory_fragment:<id> #shared_by <sharedBy>
 * - memory_fragment:<id> #involves <person> (for each involved person)
 */
export async function writeFragmentRelationships(
  spicedb: SpiceDbClient,
  params: FragmentRelationships,
): Promise<string | undefined> {
  const tuples: RelationshipTuple[] = [
    {
      resourceType: "memory_fragment",
      resourceId: params.fragmentId,
      relation: "source_group",
      subjectType: "group",
      subjectId: params.groupId,
    },
    {
      resourceType: "memory_fragment",
      resourceId: params.fragmentId,
      relation: "shared_by",
      subjectType: params.sharedBy.type,
      subjectId: params.sharedBy.id,
    },
  ];

  if (params.involves) {
    for (const person of params.involves) {
      tuples.push({
        resourceType: "memory_fragment",
        resourceId: params.fragmentId,
        relation: "involves",
        subjectType: person.type,
        subjectId: person.id,
      });
    }
  }

  return spicedb.writeRelationships(tuples);
}

/**
 * Remove all authorization relationships for a memory fragment.
 * Uses filter-based deletion — no need to know the group, sharer, or involved parties.
 */
export async function deleteFragmentRelationships(
  spicedb: SpiceDbClient,
  fragmentId: string,
): Promise<string | undefined> {
  return spicedb.deleteRelationshipsByFilter({
    resourceType: "memory_fragment",
    resourceId: fragmentId,
  });
}

/**
 * Check if a subject has delete permission on a memory fragment.
 */
export async function canDeleteFragment(
  spicedb: SpiceDbClient,
  subject: Subject,
  fragmentId: string,
  zedToken?: string,
): Promise<boolean> {
  return spicedb.checkPermission({
    resourceType: "memory_fragment",
    resourceId: fragmentId,
    permission: "delete",
    subjectType: subject.type,
    subjectId: subject.id,
    consistency: tokenConsistency(zedToken),
  });
}

/**
 * Check if a subject has write (contribute) permission on a group.
 * Used to gate writes to non-session groups — prevents unauthorized memory injection.
 */
export async function canWriteToGroup(
  spicedb: SpiceDbClient,
  subject: Subject,
  groupId: string,
  zedToken?: string,
): Promise<boolean> {
  return spicedb.checkPermission({
    resourceType: "group",
    resourceId: groupId,
    permission: "contribute",
    subjectType: subject.type,
    subjectId: subject.id,
    consistency: tokenConsistency(zedToken),
  });
}

/**
 * Ensure a subject is registered as a member of a group.
 * Idempotent (uses TOUCH operation).
 */
export async function ensureGroupMembership(
  spicedb: SpiceDbClient,
  groupId: string,
  member: Subject,
): Promise<string | undefined> {
  return spicedb.writeRelationships([
    {
      resourceType: "group",
      resourceId: groupId,
      relation: "member",
      subjectType: member.type,
      subjectId: member.id,
    },
  ]);
}

// ============================================================================
// Sharing Operations
// ============================================================================

/**
 * Share a memory fragment with a target subject by writing an "involves" tuple.
 * The involves relation grants view permission on the fragment.
 * Idempotent (uses TOUCH operation).
 */
export async function shareFragmentWith(
  spicedb: SpiceDbClient,
  fragmentId: string,
  target: Subject,
): Promise<string | undefined> {
  return spicedb.writeRelationships([
    {
      resourceType: "memory_fragment",
      resourceId: fragmentId,
      relation: "involves",
      subjectType: target.type,
      subjectId: target.id,
    },
  ]);
}

/**
 * Revoke fragment-level sharing by deleting the "involves" tuple for a target.
 */
export async function unshareFragmentFrom(
  spicedb: SpiceDbClient,
  fragmentId: string,
  target: Subject,
): Promise<void> {
  await spicedb.deleteRelationships([
    {
      resourceType: "memory_fragment",
      resourceId: fragmentId,
      relation: "involves",
      subjectType: target.type,
      subjectId: target.id,
    },
  ]);
}

/**
 * Remove a subject from a group, revoking group-level access.
 */
export async function removeGroupMember(
  spicedb: SpiceDbClient,
  groupId: string,
  member: Subject,
): Promise<void> {
  await spicedb.deleteRelationships([
    {
      resourceType: "group",
      resourceId: groupId,
      relation: "member",
      subjectType: member.type,
      subjectId: member.id,
    },
  ]);
}

/**
 * Check if a subject has view permission on a memory fragment.
 * Used to gate sharing — you can only share what you can see.
 */
export async function canViewFragment(
  spicedb: SpiceDbClient,
  subject: Subject,
  fragmentId: string,
  zedToken?: string,
): Promise<boolean> {
  return spicedb.checkPermission({
    resourceType: "memory_fragment",
    resourceId: fragmentId,
    permission: "view",
    subjectType: subject.type,
    subjectId: subject.id,
    consistency: tokenConsistency(zedToken),
  });
}

/**
 * Find all memory fragments where the subject is directly involved
 * (has an "involves" relationship). Returns fragment IDs.
 *
 * Used by memory_inbox and the shared-memory notification mechanism.
 */
export async function lookupDirectlySharedFragments(
  spicedb: SpiceDbClient,
  subject: Subject,
): Promise<string[]> {
  const tuples = await spicedb.readRelationships({
    resourceType: "memory_fragment",
    relation: "involves",
    subjectType: subject.type,
    subjectId: subject.id,
  });
  return tuples.map((t) => t.resourceId);
}

/**
 * For a given fragment, look up who shared it (the shared_by subject).
 * Returns the first shared_by subject found, or undefined.
 */
export async function lookupFragmentSharer(
  spicedb: SpiceDbClient,
  fragmentId: string,
): Promise<Subject | undefined> {
  const tuples = await spicedb.readRelationships({
    resourceType: "memory_fragment",
    resourceId: fragmentId,
    relation: "shared_by",
  });
  if (tuples.length === 0) return undefined;
  return {
    type: tuples[0].subjectType as "agent" | "person",
    id: tuples[0].subjectId,
  };
}
