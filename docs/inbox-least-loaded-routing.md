# Inbox least-loaded routing

This slice adds the first automatic agent-selection operation to the inbox while keeping team selection explicit.

## Endpoint

`POST /api/v1/inbox/conversations/{conversationId}/route`

Required scope: `inbox:write`.

The conversation must already have an explicit inbox team assignment. The endpoint never chooses or changes the team.

## Selection algorithm

For an unassigned conversation, routing executes in one PostgreSQL transaction:

1. lock the tenant conversation row with the existing `FOR UPDATE` discipline;
2. if an agent is already assigned, return the conversation unchanged;
3. require an assigned team;
4. lock the active assigned team row with `FOR UPDATE`, which serializes automatic routing decisions for that team;
5. select current team memberships whose tenant agent is active, locking those membership and agent rows for the admission decision;
6. count each eligible agent's tenant conversations with status `OPEN` or `PENDING`;
7. choose the agent with the lowest count;
8. break ties by ascending `agentId`;
9. assign the agent and persist the routing audit entry in the same transaction.

A successful changed route emits the existing `conversation.updated` realtime event after the transaction commits.

## Workload definition

Workload is deliberately simple and observable in this slice:

- only conversations in the same tenant count;
- only `OPEN` and `PENDING` conversations count;
- all such conversations assigned to the candidate count, regardless of which team they belong to;
- `RESOLVED` conversations do not count.

Counting total unresolved workload across teams prevents an agent who belongs to several teams from appearing artificially idle in each team independently.

The existing `(tenantId, assignedAgentId, status, lastMessageAt)` conversation index supports this query; no schema migration is needed.

## Concurrency

Automatic routing calls for the same team serialize on the team row. Under PostgreSQL `READ COMMITTED`, a later routing transaction performs its workload query after the prior team lock holder commits, so it can observe the prior automatic assignment before selecting.

The selected membership and agent rows are held with shared locks through commit, preventing a concurrent membership deletion or agent deactivation from invalidating that admission decision before the assignment is written.

Manual assignment and cooperative claim continue to use their existing conversation lock and team-membership invariant. They are not converted into automatic routing operations by this slice.

## Idempotency and failures

If the conversation is already assigned to any agent, routing is an idempotent no-op: it does not re-route, write a routing audit event, or publish a new realtime mutation.

Routing rejects with `422 Unprocessable Entity` when:

- the conversation has no assigned team;
- the assigned team is inactive;
- the team has no active current members eligible for routing.

A missing tenant conversation remains `404 Not Found`. Audit persistence failure rolls back the assignment.

## Audit metadata

Changed routes use action `inbox.conversation.routed` with structural metadata:

- strategy: `least_open_pending`;
- eligible agent count;
- selected agent workload before assignment;
- assigned: `true`.

The selected agent identity remains available from the authoritative conversation state rather than being duplicated into audit metadata.

## Non-goals

This slice does not implement:

- automatic team selection;
- round-robin cursor state;
- presence or capacity limits;
- skill matching or required conversation skills;
- weighted priorities;
- SLA timers or escalation;
- automatic re-routing of already assigned conversations;
- human-agent session or SSO integration.
