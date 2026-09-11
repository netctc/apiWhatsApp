# Inbox conversation team assignment

This slice adds explicit tenant-team metadata to inbox conversations. It does not select teams automatically and does not change cooperative agent claim/release behavior.

## API

The existing administrative mutation endpoint accepts an additional nullable field:

```text
PATCH /api/v1/inbox/conversations/{conversationId}
Required scope: inbox:write
```

```json
{ "assignedTeamId": "tenant-team-uuid" }
```

Assigns or reassigns the conversation to an active team owned by the authenticated tenant.

```json
{ "assignedTeamId": null }
```

Removes the explicit team assignment. Omitting `assignedTeamId` leaves the team assignment unchanged.

Conversation list/detail/update responses expose `teamAssignment`, including the assigned team summary. Realtime `conversation.updated` events include `assignedTeamId` as the team UUID or `null`.

## Query filters

`GET /api/v1/inbox/conversations` accepts:

```text
assignedTeamId=<uuid>
unassignedTeam=true
```

The two filters cannot be combined. They remain tenant-scoped through the authenticated conversation query and the tenant-safe assignment relation.

## Data model and deletion safety

Current assignment is represented by a one-to-one `ConversationTeamAssignment` record rather than by a destructive foreign key directly on `Conversation`.

```text
Conversation 1 --- 0..1 ConversationTeamAssignment --- 1 InboxTeam
```

The assignment stores `tenantId`, `conversationId`, and `teamId`. Composite foreign keys reference `(tenantId, conversationId)` and `(tenantId, teamId)`, so PostgreSQL rejects cross-tenant assignments even if an application ownership check regresses.

Deleting an assignment never deletes its conversation. If a team is physically deleted outside this API, `ON DELETE CASCADE` removes the assignment row only; the conversation remains intact. The public team API itself deactivates teams rather than deleting them.

## Mutation semantics

All administrative conversation updates acquire the existing PostgreSQL conversation row lock before checking or changing team assignment:

```sql
SELECT "id"
FROM "Conversation"
WHERE "id" = ... AND "tenantId" = ...
FOR UPDATE
```

The same lock is already used by agent claim/release and mark-read. This serializes competing mutations on a conversation.

A new assignment or reassignment requires the target team to be active in the authenticated tenant. A current team may later be deactivated; explicit unassignment remains allowed because removing stale work metadata must not require reactivating the team first.

Team assignment and agent assignment are intentionally independent. This slice does not require an assigned agent to be a member of the assigned team.

The assignment mutation, conversation field updates, and `inbox.conversation.updated` audit record share one PostgreSQL transaction. Audit failure rolls the business mutation back. Realtime publication occurs in the controller only after that transaction has committed successfully.

## Realtime payload

`conversation.updated` includes:

```json
{
  "conversationId": "...",
  "status": "OPEN",
  "priority": "NORMAL",
  "assignedAgentId": null,
  "assignedTeamId": "...",
  "unreadCount": 0
}
```

Claim/release and mark-read events also carry the current `assignedTeamId` because they use the same conversation summary projection.

## Deliberate non-goals

This slice does not implement:

- automatic team selection;
- round-robin, weighted, or skills-based routing;
- enforcing that an assigned agent belongs to the assigned team;
- team skill requirements;
- agent capacity or presence;
- SLA timers or escalation;
- supervisor queues;
- human-agent sessions or SSO.

Those policies can build on explicit team assignment, tenant-safe team membership, and agent proficiency records in later slices.
