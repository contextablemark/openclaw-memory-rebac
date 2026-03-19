# Stenographer Agent Runbook

A passive Slack-monitoring agent that observes channel conversations, identifies notable decisions and action items, and logs them to the memory-rebac knowledge graph with fine-grained access control.

## How It Works

The stenographer uses a **two-tier capture** model:

1. **Auto-capture** (`autoCapture: true`) — Every agent session feeds its full conversation to Graphiti. Graphiti's LLM extraction automatically builds entities, relationships, and temporal facts. This provides the raw knowledge graph material.

2. **Explicit capture** (SOUL.md-driven `memory_store`) — The stenographer selectively stores decisions with `involves` relationships, adding the SpiceDB authorization layer. This enables cross-agent recall: when a user asks their personal agent "What did Cara and I decide?", SpiceDB's `involves` permission lets them see the stenographer's records.

### Access Control Model

| Who | Can view? | Can delete? |
|-----|-----------|-------------|
| Stenographer agent | Yes (via `shared_by`) | Yes (via `shared_by`) |
| Involved people | Yes (via `involves`) | No |
| Group members | Yes (via `source_group→access`) | No |
| Unrelated agents/people | No | No |

### Identity Chain for Cross-Agent Recall

```
Config: identities: { "main": "U0123ABC" }
  ↓
Startup: SpiceDB writes agent:main #owner person:U0123ABC
  ↓
Recall: agent:main calls memory_recall
  → lookupAuthorizedGroups(agent:main)          // group-based search
  → lookupAgentOwner(agent:main) → U0123ABC    // identity link
  → lookupViewableFragments(person:U0123ABC)    // finds fragments via involves
  → merge results
```

## Prerequisites

- OpenClaw gateway running with `openclaw-memory-rebac` plugin
- Infrastructure stack running (SpiceDB, Graphiti, Neo4j, PostgreSQL) — see [configuration-guide.md](configuration-guide.md)
- Slack integration configured in OpenClaw (the `slack_actions` tool available)
- SpiceDB schema written (`npm run cli -- schema-write`)

## Step 1: Create the Stenographer Workspace

```bash
openclaw setup --workspace ~/.openclaw/workspace-stenographer
```

> **Note:** `openclaw setup` may change the default agent in your `openclaw.json`. After running it, check `~/.openclaw/openclaw.json` and restore your default agent configuration if needed before proceeding to Step 2.

Then edit `~/.openclaw/workspace-stenographer/SOUL.md`:

```markdown
# Stenographer

You are a silent observer agent. Your job is to monitor Slack conversations,
detect notable decisions and action items, and log them to memory.

## Core Behavior

- **Be silent.** Never send unsolicited messages. Only respond when @mentioned.
- **Quality over quantity.** Wait for decisions to solidify. Don't log tentative ideas
  or brainstorming — log conclusions.

## What to Capture

Detect and store:
- **Explicit decisions**: "We decided to...", "Let's go with...", "Approved."
- **Action items with owners**: "I'll do X by Friday", "Alice will handle..."
- **Agreements between people**: "We agreed that...", consensus moments
- **Reversals**: "Actually, we're not doing X anymore" (supersedes prior decisions)
- **Key conclusions**: End-of-discussion summaries, final answers

Ignore:
- Small talk and greetings
- Unanswered questions or open-ended brainstorming
- Pure status updates with no decision component
- Messages that are just reactions or acknowledgements

## How to Store

When you detect a decision or action item, call `memory_store` with:

- **content**: Format as: "Decision: [what]. Context: [why]. Participants: [who]."
  or "Action item: [who] will [what] by [when]. Context: [why]."
- **involves**: Array of Slack user IDs for all participants in the decision.
  Use `slack_actions` `memberInfo` to resolve display names to user IDs if needed.
- **source_description**: Include channel name and date, e.g.,
  "#engineering — 2026-03-18"

## When @mentioned

When someone @mentions you:
1. Use `memory_recall` to search for relevant decisions
2. Respond with a concise summary of what you found
3. Include source context (channel, approximate date) for each item
4. If nothing relevant is found, say so honestly

## Examples

### Good capture
> **Alice**: I talked to the security team — we're switching to OAuth2 for the new API.
> **Bob**: Makes sense. I'll update the auth middleware by end of week.

Store:
- Decision: Switch to OAuth2 for new API authentication. Security team approved.
  Participants: Alice, Bob. (#engineering — 2026-03-18)
- Action item: Bob will update auth middleware by 2026-03-21.
  Context: OAuth2 migration decision. (#engineering — 2026-03-18)

### Skip (not a decision)
> **Alice**: Has anyone looked at the new React 20 release?
> **Bob**: Not yet, looks interesting though
```

## Step 2: Configure `openclaw.json`

Add to `~/.openclaw/openclaw.json`:

### Agent Definition

```json5
{
  "agents": {
    "list": [
      // ... your existing agents ...
      {
        "id": "stenographer",
        "name": "Stenographer",
        "workspace": "~/.openclaw/workspace-stenographer",
        "identity": { "name": "Stenographer" },
        "groupChat": {
          "mentionPatterns": ["@stenographer", "@Stenographer", "@steno"]
        },
        "tools": {
          "allow": [
            "slack_actions",
            "memory_store",
            "memory_recall",
            "memory_status",
            "memory_forget",
            "read"
          ],
          "deny": [
            "write", "edit", "apply_patch", "exec",
            "browser", "canvas", "cron"
          ]
        }
      }
    ]
  }
}
```

### Channel Bindings

One binding per monitored channel:

```json5
{
  "bindings": [
    // ... your existing bindings ...
    {
      "agentId": "stenographer",
      "match": {
        "channel": "slack",
        "peer": { "kind": "channel", "id": "C01ENGINEERING" }
      }
    },
    {
      "agentId": "stenographer",
      "match": {
        "channel": "slack",
        "peer": { "kind": "channel", "id": "C02PRODUCT" }
      }
    }
  ]
}
```

Replace `C01ENGINEERING` etc. with your actual Slack channel IDs.

### Memory Plugin Config

```json5
{
  "plugins": {
    "slots": { "memory": "openclaw-memory-rebac" },
    "entries": {
      "openclaw-memory-rebac": {
        "enabled": true,
        "config": {
          "backend": "graphiti",
          "subjectType": "agent",
          "subjectId": "main",              // fallback for agents without runtime context
          "autoCapture": true,
          "autoRecall": true,
          "identities": {
            "main": "U0123ABC",             // Cara's personal agent → her Slack user ID
            "work": "U0456DEF"              // Bob's personal agent → his Slack user ID
            // "stenographer" intentionally omitted — it's a service agent, not a person
          },
          "spicedb": {
            "endpoint": "localhost:50051",
            "token": "${SPICEDB_TOKEN}",
            "insecure": true
          },
          "graphiti": {
            "endpoint": "http://localhost:8000",
            "defaultGroupId": "main",
            "customInstructions": "Extract decisions, action items, commitments, and conclusions. For each, identify WHO decided, WHAT was decided, and any deadlines. Focus on: explicit decisions, action items with owners, agreements between people, key conclusions. Ignore small talk and pure status updates."
          }
        }
      }
    }
  }
}
```

### Key Config Decisions

| Field | Value | Why |
|-------|-------|-----|
| `subjectId` | `"main"` | Fallback identity when `agentId` isn't in runtime context |
| `identities` | agent→person map | Links personal agents to their human Slack IDs for cross-agent recall |
| No stenographer identity | intentional | Stenographer is a service agent — it doesn't represent a person |
| `autoCapture` | `true` | Feeds full conversations to Graphiti for entity extraction |
| `customInstructions` | decision-focused | Tunes Graphiti's LLM extraction toward decisions and action items |

## Step 3: Find Your Slack User/Channel IDs

### Channel IDs

In Slack: right-click a channel → "View channel details" → scroll to bottom → copy the Channel ID (starts with `C`).

Or via the OpenClaw Slack integration:

```
@your-agent Use slack_actions to list channels and find the ID for #engineering
```

### User IDs

In Slack: click a user's profile → "..." menu → "Copy member ID" (starts with `U`).

These user IDs go in:
- `identities` config (mapping agents to their owners)
- `involves` arrays (set by the stenographer when storing decisions)

## Step 4: Verify the Setup

### 1. Restart the gateway

```bash
openclaw restart
```

### 2. Check plugin status

```bash
openclaw rebac-mem status
```

Should show SpiceDB and Graphiti connectivity, plus the configured identities.

### 3. Verify identity links in SpiceDB

```bash
# Check that agent→owner relationships were written at startup
npm run cli -- schema-read  # should show the schema
```

Or query SpiceDB directly:

```bash
zed relationship read agent:main#owner --insecure --endpoint localhost:50051 --token dev_token
# Expected: agent:main #owner person:U0123ABC
```

### 4. Test in a channel

Post a clear decision in a monitored channel:

> "We've decided to use PostgreSQL for the new service. @bob will set up the schema by Friday."

Wait 30-60 seconds for the stenographer to process and store.

### 5. Verify the memory was stored

```bash
npm run cli -- search "PostgreSQL" --limit 5
```

### 6. Test cross-agent recall

From a different channel (e.g., WhatsApp or Telegram), ask your personal agent:

> "What did we decide about the database for the new service?"

Your agent should find the stenographer's decision via the identity chain:
`agent:main` → `person:U0123ABC` → `involves` → `memory_fragment`.

### 7. Verify deletion permissions

Try to delete the stenographer's memory from your personal agent:

> "Forget that decision about PostgreSQL"

This should fail with a permission error — only the stenographer (as `shared_by`) can delete its own memories.

## Troubleshooting

### Stenographer isn't storing anything

1. **Check bindings**: Verify the channel ID in your binding matches the actual Slack channel ID
2. **Check SOUL.md**: Make sure the workspace path is correct and the file exists
3. **Check tools**: The stenographer needs `memory_store` and `slack_actions` in its allow list
4. **Check logs**: Look for errors in the OpenClaw gateway logs related to the stenographer agent

### Cross-agent recall returns nothing

1. **Check identities config**: Your personal agent's ID must be mapped to your Slack user ID
2. **Verify SpiceDB links**: `zed relationship read agent:<your-agent>#owner` should return your person ID
3. **Check involves**: The stenographer must include your Slack user ID in the `involves` array when storing
4. **Consistency**: SpiceDB queries use `at_least_as_fresh` consistency — if you query immediately after a write, pass the write token

### Stenographer responds when it shouldn't

Check the `mentionPatterns` in the agent config. The stenographer should only respond to @mentions matching those patterns. If it's responding to all messages, the binding may be configured as a direct agent (not group chat).

### Memories are created but have no `involves`

The SOUL.md instructions tell the stenographer to include `involves`. If it's not doing so:
1. Check that `slack_actions` `memberInfo` is working (the stenographer needs it to resolve display names to user IDs)
2. Add more explicit examples to the SOUL.md
3. Check that the `memory_store` tool's `involves` parameter is being passed through correctly

## Architecture Reference

```
┌─────────────────────────────────────────────────────┐
│                   Slack Channel                      │
│  Alice: "Let's use Postgres"                        │
│  Bob: "I'll set up the schema by Friday"            │
└──────────────────────┬──────────────────────────────┘
                       │ (channel binding)
                       ▼
┌─────────────────────────────────────────────────────┐
│              Stenographer Agent                       │
│  SOUL.md: detect decisions, call memory_store        │
│  Tools: slack_actions, memory_store, memory_recall   │
└──────────────────────┬──────────────────────────────┘
                       │ memory_store(involves: [U_ALICE, U_BOB])
                       ▼
┌─────────────────────────────────────────────────────┐
│           openclaw-memory-rebac Plugin               │
│                                                      │
│  resolveSubject(ctx.agentId)                        │
│    → subject = agent:stenographer                    │
│                                                      │
│  Graphiti: store episode + extract entities           │
│  SpiceDB:  memory_fragment:X #shared_by              │
│              agent:stenographer                       │
│            memory_fragment:X #involves                │
│              person:U_ALICE                           │
│            memory_fragment:X #involves                │
│              person:U_BOB                            │
│            memory_fragment:X #source_group            │
│              group:stenographer                       │
└─────────────────────────────────────────────────────┘

          ─ ─ ─  Later, Alice asks her agent  ─ ─ ─

┌─────────────────────────────────────────────────────┐
│            Alice's Personal Agent (main)              │
│  "What did we decide about the database?"            │
└──────────────────────┬──────────────────────────────┘
                       │ memory_recall("database decision")
                       ▼
┌─────────────────────────────────────────────────────┐
│           openclaw-memory-rebac Plugin               │
│                                                      │
│  resolveSubject(ctx.agentId)                        │
│    → subject = agent:main                            │
│                                                      │
│  1. Group search: groups where agent:main is member  │
│  2. Owner lookup: agent:main → person:U_ALICE        │
│     (from identities config, written at startup)     │
│  3. Fragment search: fragments where U_ALICE is in   │
│     involves → finds memory_fragment:X               │
│  4. Merge + return results                           │
└─────────────────────────────────────────────────────┘
```
