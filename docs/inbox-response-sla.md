# Inbox response SLA foundation

The inbox response-SLA foundation persists a bounded response target for the current customer turn. It is provider-neutral and intentionally stops before automatic escalation, reassignment, notifications, business calendars, or session/SSO concerns.

## Team policy

`InboxTeam.responseSlaMinutes` is nullable:

- `null`: no SLA is created for future customer-turn cycles.
- `1..10080`: response target in minutes, up to one week.

The value is available through the existing team create/list/read/update APIs. PostgreSQL enforces the same bounds as the API. Changing or clearing the team policy does not rewrite an SLA cycle that is already active; the active cycle is a snapshot of the policy that admitted it.

## Conversation cycle

Every conversation exposes three nullable fields:

- `responseSlaStartedAt`: when responsibility for the current SLA cycle began.
- `responseSlaDueAt`: persisted deadline for that cycle.
- `responseSlaRespondedAt`: timestamp of the first qualifying free-form outbound response.

All three fields are null when the current turn has no configured SLA. A database constraint prevents partial/invalid cycles, and `(tenantId, status, responseSlaDueAt)` is indexed so a later escalation worker can efficiently scan unresolved overdue conversations.

## Lifecycle rules

An SLA cycle can start in two ways:

1. An active team with a configured SLA is assigned to an OPEN/PENDING conversation that has an unanswered inbound message and no active SLA cycle. The cycle starts when the assignment commits.
2. A newer inbound message starts a fresh customer turn after the previous SLA cycle was answered, or reopens a RESOLVED conversation. The cycle uses the team's policy at that time and starts at the inbound provider timestamp.

Additional inbound messages while a cycle is waiting for a response do **not** extend the deadline. Out-of-order inbound activity cannot move monotonic activity timestamps or rewrite the active cycle.

The first qualifying non-template outbound message after `responseSlaStartedAt` sets `responseSlaRespondedAt`. Later outbound messages do not rewrite it. Template traffic remains outside inbox conversation creation/reopen behavior and therefore cannot satisfy an SLA cycle.

Resolving a conversation does not destroy its current-cycle timestamps. A later inbound reopen replaces them with a fresh cycle when the assigned team currently has an SLA policy. An outbound-only reopen clears stale SLA timestamps because there is no new customer turn to satisfy.

## Breach evaluation

No scheduler is required for this foundation. A conversation is currently overdue when all of the following are true:

- status is `OPEN` or `PENDING`;
- `responseSlaDueAt` is earlier than the evaluation time;
- `responseSlaRespondedAt` is null.

A completed response met the target when `responseSlaRespondedAt <= responseSlaDueAt`; otherwise it missed the target. These timestamps are deliberately persisted so later escalation and reporting features do not need to reconstruct policy history.

## Concurrency and ownership

Conversation activity remains atomic inside the existing message/webhook transaction. The `Conversation` upsert serializes competing activity on the tenant/sender/contact uniqueness boundary. Team assignment starts SLA through a PostgreSQL trigger in the same assignment transaction, after the application has already locked the conversation under the existing inbox mutation rules.

This slice does not alter team membership, skills, presence, capacity, least-loaded routing, conversation ownership, audit permissions, or realtime authorization.
