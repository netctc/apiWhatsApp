# Inbox conversation claim and release

This document defines the cooperative assignment contract for human-agent inbox consumers.

## Endpoints

```text
POST /api/v1/inbox/conversations/{conversationId}/claim
POST /api/v1/inbox/conversations/{conversationId}/release
Required scope: inbox:write
```

Both endpoints accept:

```json
{
  "agentId": "<tenant-inbox-agent-uuid>"
}
```

The authenticated API key is the only tenant identity source. `agentId` never selects a tenant.

## Claim contract

A claim is intended for an agent client that wants to take currently unassigned work without stealing work from another agent.

The service locks the tenant conversation row with PostgreSQL `FOR UPDATE`, then validates the requested agent in the same transaction.

- The conversation must belong to the authenticated tenant or the API returns `404`.
- The requested inbox agent must belong to the authenticated tenant and be active or the API returns `422`.
- If the conversation is unassigned, it is assigned to the requested agent and the API returns `200`.
- If the same active agent already holds it, the request is an idempotent `200` no-op.
- If another agent holds it, the API returns `409` and does not change assignment.

Because claim, release, mark-read and administrative conversation updates use the same row lock, concurrent assignment decisions are serialized by PostgreSQL. Two different agents cannot both successfully claim the same unassigned conversation.

## Release contract

Release is cooperative: the caller supplies the agent that is expected to hold the conversation.

- The conversation must belong to the authenticated tenant or the API returns `404`.
- The requested agent must belong to the tenant. The agent does not need to remain active, so work held by a subsequently deactivated agent can still be released.
- If that agent currently holds the conversation, assignment is cleared and the API returns `200`.
- If the conversation is already unassigned, release is an idempotent `200` no-op.
- If another agent holds it, the API returns `409` and does not change assignment.

## Administrative reassignment remains separate

```text
PATCH /api/v1/inbox/conversations/{conversationId}
```

The existing update endpoint remains the explicit administrative surface for reassignment and unassignment. It intentionally can move a conversation from one active agent to another. Claim/release do not remove or weaken that behavior.

This distinction keeps normal agent workflows conflict-safe while preserving supervisor/operator control.

## Audit behavior

Only committed assignment changes create new audit records:

```text
inbox.conversation.claimed
inbox.conversation.released
```

Idempotent no-ops and conflicts do not create claim/release audit rows. Audit metadata records structural assignment state only and does not copy agent names, emails, external IDs or the requested agent UUID.

If the audit write fails, the enclosing database transaction fails so the assignment mutation is rolled back with it.

## Realtime behavior

An actual committed claim or release publishes the existing tenant-scoped SSE event:

```text
conversation.updated
```

The event is sent only after the database transaction returns successfully. Repeated same-agent claim, repeated release of an already unassigned conversation, validation failures and conflicts do not publish an assignment event.

The SSE channel remains an invalidation hint. REST/PostgreSQL state is authoritative.

## Concurrency examples

Two agents claim an unassigned conversation concurrently:

```text
Agent A claim ----\
                  -> PostgreSQL row lock -> one HTTP 200 winner
Agent B claim ----/                       -> one HTTP 409 loser
```

A cooperative claim races an administrative reassignment:

```text
claim(agent A) ----\
                    -> same PostgreSQL row lock -> serialized decisions
PATCH(agent B) ----/
```

The administrative update remains authoritative when it executes after a successful claim; when it executes first, a later claim observes the assignment and conflicts rather than stealing it.

## Deliberate boundaries

This slice does not introduce agent sessions, user-to-agent authentication, teams/skills, automatic routing, presence, SLA timers or ownership leases. API-key authorization remains the current caller security model. Those capabilities can build on this conflict-safe assignment primitive later.
