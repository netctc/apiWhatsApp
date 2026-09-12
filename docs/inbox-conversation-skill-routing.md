# Inbox conversation skill routing

Conversation skill requirements make the existing inbox skill catalogue part of agent admission and automatic routing.

## Requirement API

Requirements are managed per conversation:

- `PUT /api/v1/inbox/conversations/{conversationId}/skills/{skillId}` with `{ "minLevel": 1..5 }`
- `DELETE /api/v1/inbox/conversations/{conversationId}/skills/{skillId}`

Both operations require `inbox:write`.

Conversation detail includes `skillRequirements`, ordered by skill name, with the required minimum level and current skill metadata.

## Data integrity

`ConversationSkillRequirement` stores one row per conversation and required skill. PostgreSQL enforces:

- minimum level in the inclusive range 1 through 5;
- composite tenant ownership for the conversation;
- composite tenant ownership for the skill;
- uniqueness of the `(conversationId, skillId)` requirement.

Cross-tenant requirements are therefore rejected even if an application-layer tenant check regresses.

## Mutation semantics

Requirement writes use the existing conversation `FOR UPDATE` lock.

- creating a requirement requires the tenant skill to be active;
- setting the same minimum level is an idempotent no-op;
- an existing minimum can be changed even after the skill is deactivated;
- removing a missing requirement is an idempotent no-op;
- audit persistence is part of the same transaction.

Requirements are intentionally non-retroactive. Changing or removing a requirement never releases or re-routes the current holder.

## New agent admission

A new explicit administrative agent assignment and a changed cooperative claim must satisfy **every** current requirement.

For each requirement:

- the required skill must still be active;
- the agent must have a tenant-safe proficiency row for that skill;
- the proficiency level must be greater than or equal to `minLevel`.

If any required skill is inactive, new admission fails closed. A repeat claim by the current holder remains an idempotent no-op, and release/status/priority operations remain available for historical assignments.

The admission query holds shared locks on required skill and proficiency rows until the surrounding conversation transaction commits. This prevents a passing skill snapshot from being destructively changed before the new assignment is persisted.

## Automatic routing

Least-loaded routing keeps its existing team and workload behavior, then adds an all-of skill filter before calculating load:

1. lock the conversation;
2. require and lock the active assigned team;
3. collect active current team members;
4. lock and validate all required skills;
5. lock matching proficiency rows and retain only agents satisfying every minimum;
6. count each eligible agent's tenant `OPEN` and `PENDING` conversations;
7. choose the lowest workload, breaking ties by ascending `agentId`.

If no active team member satisfies all requirements, routing returns `422 Unprocessable Entity` without assigning an agent.

The existing per-team routing mutex remains in place, so two automatic routes for the same team still serialize before workload selection.

## Audit behavior

Requirement changes use these actions:

- `inbox.conversation.skill.required`
- `inbox.conversation.skill.level.updated`
- `inbox.conversation.skill.removed`

Automatic route audit metadata now also records the number of required skills used for candidate filtering. It does not duplicate skill or selected-agent identities into audit metadata; authoritative state remains in the relational models.

## Non-goals

This slice does not implement:

- OR or optional skill groups;
- weighted skill scoring;
- automatic team selection;
- presence or capacity limits;
- SLA timers or escalation;
- automatic re-routing of existing holders;
- human-agent session or SSO integration.
