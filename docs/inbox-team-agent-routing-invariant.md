# Inbox team-agent routing invariant

This document defines the admission invariant between explicit inbox team assignment and human-agent assignment. It is a prerequisite for later automatic routing; it does not itself select an agent.

## Invariant

When a conversation has an assigned inbox team, any **new** agent assignment must use an active agent in the authenticated tenant who is currently a member of that team.

The invariant is checked inside the existing PostgreSQL conversation transaction after the conversation row is locked with `FOR UPDATE`.

For administrative `PATCH /api/v1/inbox/conversations/{conversationId}` mutations, the service computes the final `(assignedTeamId, assignedAgentId)` pair before writing either side:

- changing only the agent validates that agent against the existing team;
- changing only the team validates the existing agent against the target team;
- changing team and agent together validates the final pair, allowing an atomic move;
- clearing either side removes the membership requirement for that mutation.

A cooperative claim on a team-assigned, currently unassigned conversation requires the claimant to be an active member of the assigned team.

## Non-retroactive behavior

Team membership is an admission rule, not a permanent relational constraint on historical conversation state.

Removing an agent from a team does **not** automatically release or re-route conversations already held by that agent. This is deliberate:

- status/priority/read/note operations remain available;
- a repeat claim by the current holder remains an idempotent no-op;
- the current holder can still release the conversation;
- the team assignment can still be removed without clearing the agent;
- a future new claim/reassignment must satisfy the current membership rule again.

This avoids destructive hidden mutations when administrators change team membership.

## Tenant and activity rules

Existing fail-closed validation remains in force:

- newly assigned agents must be active in the authenticated tenant;
- newly assigned teams must be active in the authenticated tenant;
- cross-tenant agent/team identifiers are rejected before membership admission;
- membership itself is tenant-safe at the PostgreSQL boundary through composite foreign keys.

## Concurrency

Conversation assignment and claim operations continue to serialize on the same `Conversation` row lock used by administrative PATCH, claim/release, and mark-read.

Membership is checked transactionally at admission time. A later membership removal is allowed and is treated as a non-retroactive administrative change, as described above.

## Audit and realtime

No new audit payload identity fields are introduced. Assignment mutations continue to use the existing structural audit metadata and roll back when audit persistence fails.

Realtime behavior is unchanged: committed conversation mutations emit the existing `conversation.updated` event after the REST/database mutation succeeds.

## Non-goals

This slice does not implement:

- automatic team or agent selection;
- round-robin, least-loaded, weighted, or skills-based routing;
- agent presence/capacity;
- conversation skill requirements;
- SLA timers or escalation;
- human-agent session or SSO integration.

Those capabilities can build on this invariant without redefining explicit assignment safety.
