# Inbox least-loaded routing

The inbox automatic routing operation keeps team selection explicit while applying the current admission policy before selecting the least-loaded agent.

## Endpoint

`POST /api/v1/inbox/conversations/{conversationId}/route`

Required scope: `inbox:write`.

The conversation must already have an explicit inbox team assignment. The endpoint never chooses or changes the team.

## Selection algorithm

For an unassigned conversation, routing executes in one PostgreSQL transaction:

1. lock the tenant conversation row with `FOR UPDATE`;
2. if an agent is already assigned, return the conversation unchanged;
3. require an assigned team;
4. lock the active assigned team row with `FOR UPDATE`, serializing automatic routing decisions for that team;
5. select active team members in ascending `agentId` order and lock their membership and agent rows for the admission decision;
6. apply all current conversation skill requirements and minimum proficiency levels;
7. count each skill-eligible agent's tenant conversations with status `OPEN` or `PENDING`;
8. remove agents whose bounded capacity is already exhausted;
9. choose the remaining agent with the lowest count;
10. break equal-workload ties by ascending `agentId`;
11. assign the agent and persist the routing audit entry in the same transaction.

A successful changed route emits the existing `conversation.updated` realtime event after the transaction commits.

## Workload definition

Workload is deliberately simple and observable:

- only conversations in the same tenant count;
- only `OPEN` and `PENDING` conversations count;
- all such conversations assigned to the candidate count, regardless of which team they belong to;
- `RESOLVED` conversations do not count.

Counting unresolved workload across teams prevents an agent who belongs to several teams from appearing artificially idle in each team independently. The `(tenantId, assignedAgentId, status, lastMessageAt)` conversation index supports this query.

## Agent capacity

`InboxAgent.maxConcurrentConversations` is nullable:

- `null` means unlimited capacity and preserves the behavior of existing agents;
- `0` keeps the agent active but makes it ineligible for all new assignments;
- values `1..10000` bound the number of assigned `OPEN`/`PENDING` conversations accepted by that agent;
- PostgreSQL and the HTTP DTO boundary both enforce the `0..10000` range.

Capacity is an admission rule for new work. Lowering a limit below the current workload does not release, re-route, or otherwise mutate existing holders. Release and non-assignment conversation mutations remain available while an agent is at or above capacity.

The same capacity rule also applies to new administrative assignment and cooperative claim. A repeat claim by the current holder remains an idempotent no-op even when the holder is currently over capacity.

## Concurrency

Automatic routing calls for the same team serialize on the team row. Candidate agent rows are then locked in stable `agentId` order before workload is counted, so concurrent routes from different teams that share agents cannot independently consume the same final capacity slot.

Administrative assignment and cooperative claim lock the target agent row before counting workload and keep that lock until the assignment transaction commits. Two concurrent admissions to a capacity-one agent therefore cannot both observe the slot as free.

Team memberships, required skills, proficiency rows, workload counts, assignment writes, and audit writes remain inside the surrounding transaction. Audit persistence failure rolls back the assignment.

## Idempotency and failures

If the conversation is already assigned to any agent, automatic routing is an idempotent no-op: it does not re-route, write a routing audit event, or publish a new realtime mutation.

Routing rejects with `422 Unprocessable Entity` when:

- the conversation has no assigned team;
- the assigned team is inactive;
- the team has no active current members;
- no active member satisfies all required conversation skills;
- every otherwise eligible member has exhausted conversation capacity.

A missing tenant conversation remains `404 Not Found`.

## Audit metadata

Changed routes use action `inbox.conversation.routed` with structural metadata:

- strategy: `least_open_pending`;
- final eligible agent count after capacity filtering;
- number of skill-qualified agents excluded by capacity;
- required skill count;
- selected agent workload before assignment;
- assigned: `true`.

The selected agent identity remains available from authoritative conversation state rather than being duplicated into audit metadata.

## Non-goals

This slice does not implement:

- automatic team selection;
- round-robin cursor state;
- presence or shift schedules;
- per-team or weighted capacity;
- OR/optional skill groups or weighted skill scoring;
- SLA timers or escalation;
- automatic re-routing of already assigned conversations;
- human-agent session or SSO integration.
