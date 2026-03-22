# Teaching Agents to Take Notes for Each Other

## ReBAC Identity Chains and the Stenographer Pattern

**TL;DR:** A passive agent watches Slack conversations and silently logs decisions to the knowledge graph. Later, participants can recall those decisions through their own personal agents — even though they never stored anything themselves. This works because SpiceDB's authorization graph connects agents to their human owners, creating identity chains that bridge the gap between "who stored it" and "who was there."

---

We ended the last post with a teaser about inter-agent memory: multiple specialized agents sharing overlapping but distinct views of organizational knowledge under the same authorization graph. That future arrived faster than expected.

The scenario that forced the issue was straightforward. I wanted an agent that sits in Slack channels, watches conversations, and logs notable decisions — a stenographer. Not a chatbot. Not an assistant. Just a quiet observer that notices when a team reaches a conclusion and writes it down.

The problem is that writing it down is only half the job. The other half — the harder half — is making sure the right people can find it later, through their own agents, on their own channels.

## The Gap

Consider a concrete example. Cara and Bob are in `#engineering` on Slack. They discuss database options for a new service and decide on PostgreSQL. The stenographer agent observes this and stores a memory: "Decision: Use PostgreSQL for new service. Participants: Cara, Bob."

Two hours later, Cara opens WhatsApp and asks her personal OpenClaw agent: "What did we decide about the database?"

This should work. Cara was part of that decision. But her personal agent didn't store the memory — the stenographer did. Her agent runs as `agent:main`. The stenographer runs as `agent:stenographer`. They're different SpiceDB subjects with different group memberships. From an authorization perspective, they have nothing in common.

The existing architecture handled the "who can see what" question beautifully — for memories stored within your own groups. What it couldn't do was bridge the gap between an agent that stores a memory and a different agent whose human was actually there.

## Identity Chains

The SpiceDB schema already had the building blocks. Since v0.1.0, the authorization schema has included:

```
definition agent {
    relation owner: person
    permission act_as = owner
}
```

The `owner` relation and `act_as` permission were there from the start. But nothing ever wrote those relationships. They were aspirational — a door with no key.

The solution required three code changes to the plugin, plus a small but meaningful schema addition.

**First: per-agent identity.** Previously, every agent sharing a gateway used the same SpiceDB subject — whatever was configured at the plugin level. If three agents ran through one gateway, they all wrote memories as the same identity. Tools and lifecycle hooks now derive the SpiceDB subject from the runtime `agentId`, so the stenographer writes `shared_by: agent:stenographer` while Cara's agent writes `shared_by: agent:main`.

**Second: identity linking.** A new `identities` config field maps agent IDs to their owner's person ID — typically a Slack user ID. At plugin startup, the plugin writes bidirectional tuples to SpiceDB: `agent:main #owner person:U0123ABC` and `person:U0123ABC #agent agent:main`. The forward tuple says "this agent belongs to this person." The reverse tuple says "this person is represented by this agent." Both are needed for the schema traversal to work.

**Third: the schema change.** The `person` definition gained a `relation agent` and `permission represents = agent`, and `memory_fragment.view` gained `involves->represents`:

```
definition person {
    relation agent: agent
    permission represents = agent
}

definition memory_fragment {
    ...
    permission view = involves + shared_by + source_group->access + involves->represents
    ...
}
```

The `involves->represents` arrow is the key. It tells SpiceDB: "for each person in `involves`, check if the requesting subject has the `represents` permission on that person." In practice: `agent:main` can view `memory_fragment:X` because `person:U0123ABC` is in `involves`, and `person:U0123ABC#agent@agent:main` exists, which satisfies `represents`.

This means the owner-aware recall chain is now resolvable entirely within SpiceDB — no application-level owner lookup needed for permission checks.

**Fourth: owner-aware recall.** When an agent calls `memory_recall`, the plugin runs a second search path using a search-then-post-filter pattern. First, it resolves the agent's owner and asks SpiceDB which memory fragments that person can view via `involves` — this is the authorization allow-list. Then it discovers which groups those fragments belong to (via the `source_group` relation) and runs Graphiti's semantic search across those groups with the actual query. Finally, it post-filters the search results against the allow-list, keeping only fragments the person is genuinely authorized to view. SpiceDB provides the security boundary; Graphiti provides query relevance. The intersection gives you both.

## What the Stenographer Can't Do

There's an intentional asymmetry in the access control. The stenographer stores every decision with `shared_by: agent:stenographer`. In the SpiceDB schema, only the `shared_by` subject can delete a fragment. This means:

- The stenographer can delete its own memories.
- Cara and Bob can view the decisions they were involved in.
- Cara and Bob cannot delete the stenographer's records.

This isn't a bug. When you have an organizational agent logging decisions, you don't want individual participants unilaterally erasing the record. The stenographer is the source of truth. If a decision gets reversed, the stenographer logs the reversal — it doesn't delete history.

## The Dual Capture Model

The stenographer uses both of the plugin's capture mechanisms, and they serve different purposes.

**Auto-capture** feeds full conversation transcripts to Graphiti after every agent session. Graphiti's LLM extraction layer does its thing — building entity nodes, inferring relationships, tracking temporal validity. This is the raw knowledge graph: rich, interconnected, but ungoverned. Everything the stenographer sees goes into the graph.

**Explicit capture** is where the authorization layer comes in. The stenographer's SOUL.md instructs it to selectively call `memory_store` when it detects a decision, and to include the `involves` parameter with the Slack user IDs of participants. This writes the SpiceDB relationships that make cross-agent recall possible.

The combination matters. Graphiti builds a temporally-aware knowledge graph from all conversations. The stenographer's explicit stores add authorization-controlled decision records that specific people can discover through `involves`. When Cara asks about the database decision, SpiceDB identifies which fragments she's authorized to view and which groups they live in, Graphiti searches those groups with her query for semantic relevance, and the post-filter ensures only her authorized fragments make it through.

## Backward Compatibility

The schema change is additive — `person` gains a relation and permission, `memory_fragment.view` gains an extra union term. Existing tuples and permission checks continue to work identically. The new `involves->represents` path just adds another way to reach `view`.

Existing memories get the new traversal for free. Any fragment that already has `involves@person:U0123ABC` becomes viewable by `agent:main` the moment the bidirectional identity tuple exists — no re-writing of fragment relationships needed.

If you don't add `identities`, everything works exactly as before. The per-agent identity changes fall back to the config-level subject when `agentId` isn't present in the runtime context. The bidirectional tuples are only written for agents that appear in the `identities` config.

## Testing the Authorization Chain

The interesting testing challenge was separating SpiceDB authorization verification from Graphiti's LLM extraction. The authorization chain — agent → owner → involves → fragment — is deterministic and fast. You write relationships, you query permissions, you get answers. Graphiti's entity extraction, on the other hand, depends on whatever LLM you're running and can take minutes with local models.

The E2E tests verify the authorization chain first, then check Graphiti extraction as a non-blocking bonus. Seven tests exercise the full flow: decision storage with `involves`, permission enforcement (view vs. delete), per-agent group isolation, owner-aware fragment discovery, the complete identity chain, and unauthorized agent denial. The SpiceDB assertions are the hard requirements; the Graphiti assertions are "if the model finished processing, verify the results look right."

## Configuration, Not Code

The stenographer itself is pure configuration — no custom code. A SOUL.md file with instructions to detect decisions and call `memory_store` with the right parameters. A binding to the Slack channels it should monitor. A tool allowlist (`message` for Slack user resolution, memory tools, read — nothing else). Channel-level `requireMention: false` ensures the stenographer receives all messages, not just @mentions. The runbook in `docs/stenographer-runbook.md` walks through the full setup, including Slack OAuth scopes and event subscriptions.

The identity linking is similarly declarative:

```json
{
  "identities": {
    "main": "U0123ABC",
    "work": "U0456DEF"
  }
}
```

That's it. Agent IDs to Slack user IDs. The plugin handles the rest at startup.

## Try It in the Playground

The full schema works in the [Authzed Playground](https://play.authzed.com). Drop in the schema, add a few tuples (two agents, two people, a stenographer memory with `involves`), and watch the `involves->represents` traversal resolve in real time. The assertions tab lets you verify that agents can view memories their owners were involved in — and that they can't delete what the stenographer stored.

## What's Next

This release lays the groundwork for a broader pattern: service agents that observe, record, and govern organizational knowledge on behalf of teams. The stenographer is the first instance, but the same identity-chain mechanism enables other patterns:

- A **compliance agent** that monitors channels for regulatory commitments and ensures they're tracked
- A **handoff agent** that watches project channels and synthesizes context for new team members joining a project
- An **onboarding agent** that captures institutional knowledge from senior engineers' conversations and makes it discoverable by new hires

All of these share the same core requirement: one agent stores knowledge about interactions between people, and those people need to find it later through their own agents, governed by who was actually there.

On the horizon: **peer-aware recall** — enabling a single shared bot to serve multiple users with proper memory separation, by extracting the conversation peer from session keys and scoping recall accordingly. All read-side changes, fully backward-compatible with existing memories.

The code is at [github.com/Contextable/openclaw-memory-rebac](https://github.com/Contextable/openclaw-memory-rebac). MIT licensed. PRs welcome.
