# Inbox response SLA and automatic escalation

The inbox response-SLA model persists a bounded response target for the current customer turn and automatically marks unresolved overdue cycles as escalated. It is provider-neutral and intentionally does not reassign conversations or emit external notifications.

## Team policy

`InboxTeam.responseSlaMinutes` is nullable:

- `null`: no SLA is created for future customer-turn cycles.
- `1..10080`: response target in minutes, up to one week.

The value is available through the existing team create/list/read/update APIs. PostgreSQL enforces the same bounds as the API. Changing or clearing the team policy does not rewrite an SLA cycle that is already active; the active cycle is a snapshot of the policy that admitted it.

## Conversation cycle

Every conversation exposes four nullable SLA fields:

- `responseSlaStartedAt`: when responsibility for the current SLA cycle began.
- `responseSlaDueAt`: persisted deadline for that cycle.
- `responseSlaRespondedAt`: timestamp of the first qualifying free-form outbound response.
- `responseSlaEscalatedAt`: timestamp when the automatic scanner first claimed the overdue unanswered cycle.

All four fields are null when the current turn has no configured SLA. PostgreSQL rejects partial/invalid cycles. An escalation timestamp must be at or after the persisted deadline.

Two indexes support the two primary access paths:

- `(tenantId, status, responseSlaDueAt)` for tenant-scoped backlog/reporting reads;
- `(status, responseSlaDueAt, responseSlaEscalatedAt)` for the global bounded escalation scanner.

## Lifecycle rules

An SLA cycle can start in two ways:

1. A team with a configured SLA is assigned to an OPEN/PENDING conversation that has an unanswered inbound message and no active SLA cycle. The cycle starts when the assignment commits.
2. A newer inbound message starts a fresh customer turn after the previous SLA cycle was answered, or reopens a RESOLVED conversation. The cycle uses the team's policy at that time and starts at the inbound provider timestamp.

A newly started cycle always has `responseSlaRespondedAt = null` and `responseSlaEscalatedAt = null`. Additional inbound messages while a cycle is waiting for a response do **not** extend the deadline. Out-of-order inbound activity cannot move monotonic activity timestamps or rewrite the active cycle.

The first qualifying non-template outbound message after `responseSlaStartedAt` sets `responseSlaRespondedAt`. Later outbound messages do not rewrite it. If the cycle was already escalated, a late response preserves `responseSlaEscalatedAt`; this keeps the breach visible instead of erasing it after recovery.

Template traffic remains outside inbox conversation creation/reopen behavior and therefore cannot satisfy an SLA cycle.

Resolving a conversation prevents new automatic escalation but does not destroy its current-cycle timestamps. A later inbound reopen replaces them with a fresh cycle when the assigned team currently has an SLA policy. An outbound-only reopen clears stale SLA timestamps because there is no new customer turn to satisfy.

## Automatic escalation scanner

`InboxResponseSlaEscalationService` performs one scan during application bootstrap and then repeats on `INBOX_SLA_ESCALATION_INTERVAL_MS`.

Configuration:

- default: `60000` ms;
- accepted range: `5000..3600000` ms;
- invalid values fail application bootstrap rather than silently changing escalation behavior.

Each pass claims at most 200 conversations. A cycle is eligible only when:

- status is `OPEN` or `PENDING`;
- `responseSlaStartedAt` and `responseSlaDueAt` are present;
- `responseSlaDueAt <= scan time`;
- `responseSlaRespondedAt` is null;
- `responseSlaEscalatedAt` is null.

The scanner uses one PostgreSQL statement with `FOR UPDATE SKIP LOCKED` and then updates the claimed rows. Multiple API replicas can therefore run the scanner concurrently without recording the same escalation twice. Re-running the scanner is idempotent for an already escalated cycle.

The scanner deliberately stops at state marking. It does not reassign a team/agent, change priority, send email/Slack/SMS/webhooks, or create an external incident.

## Operational visibility

`GET /api/v1/operations/snapshot` now includes `inboxResponseSla`:

- `waitingForResponse`: active OPEN/PENDING SLA cycles without a qualifying response;
- `overdueUnescalated`: overdue cycles still waiting to be claimed by the scanner;
- `escalatedUnresolved`: escalated cycles still waiting for a response;
- `oldestOverdueAgeSeconds`: age of the oldest unresolved overdue deadline, or null when none are overdue.

These counters remain tenant-scoped even though the scanner itself claims due work across tenants.

## Breach interpretation

A completed response met the target when `responseSlaRespondedAt <= responseSlaDueAt`; otherwise it missed the target. `responseSlaEscalatedAt` answers a different question: whether the automatic scanner observed and claimed the unresolved breach before the cycle recovered.

The current schema stores only the current-cycle snapshot. Historical SLA analytics beyond message/conversation history remain outside this slice.

## Concurrency and ownership

Conversation activity remains atomic inside the existing message/webhook transaction. The `Conversation` upsert serializes competing activity on the tenant/sender/contact uniqueness boundary. Team assignment starts SLA through a PostgreSQL trigger in the same assignment transaction, after the application has already locked the conversation under the existing inbox mutation rules.

The escalation scanner uses database row locking only for its bounded claim statement. It does not change team membership, skills, presence, capacity, least-loaded routing, conversation ownership, audit permissions, realtime authorization, or session/SSO behavior.
