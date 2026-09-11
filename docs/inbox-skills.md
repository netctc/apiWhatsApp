# Inbox skills foundation

This slice adds tenant-scoped inbox skills and explicit agent proficiency levels as routing metadata. It does not yet make routing decisions or attach skill requirements to conversations or teams.

## API

Reads require `inbox:read`:

```text
GET /api/v1/inbox/skills
GET /api/v1/inbox/skills/{skillId}
```

Writes require `inbox:write`:

```text
POST   /api/v1/inbox/skills
PATCH  /api/v1/inbox/skills/{skillId}
PUT    /api/v1/inbox/skills/{skillId}/agents/{agentId}
DELETE /api/v1/inbox/skills/{skillId}/agents/{agentId}
```

Skill creation accepts a required `name` and optional `description`. `PATCH` can change `name`, `description`, or `active`; an empty description clears it. Skills are deactivated rather than deleted by this API so historical proficiency assignments remain available for later routing-policy evolution.

## Proficiency levels

`PUT .../agents/{agentId}` accepts:

```json
{ "level": 3 }
```

The level is an integer from 1 through 5. Both HTTP validation and PostgreSQL enforce the range.

The level is currently ordinal routing metadata only. This slice does not interpret it as a workload percentage, routing weight, certification, authorization boundary, or service-level guarantee.

A new proficiency assignment requires an active skill and an active inbox agent owned by the authenticated tenant. Existing assignments remain present if the skill or agent is later deactivated; their level may still be maintained explicitly.

Repeating the same skill/agent/level is idempotent and creates neither a duplicate row nor a duplicate audit entry. Sending a different level updates the existing assignment and records the level change.

`DELETE .../agents/{agentId}` is idempotent after the skill has been resolved inside the authenticated tenant.

## Tenant integrity

Application queries always include the authenticated tenant ID. Cross-tenant skill IDs therefore return the same `404` shape as missing skill IDs.

The database adds a second boundary. `InboxAgentSkill` stores `tenantId`, `skillId`, and `agentId`; composite foreign keys reference `(tenantId, id)` on both `InboxSkill` and `InboxAgent`. PostgreSQL therefore rejects a proficiency assignment if either referenced record belongs to another tenant.

Skill names are unique per tenant. Proficiency identity is unique by `skillId + agentId`.

## Audit semantics

Committed changes emit these audit actions:

```text
inbox.skill.created
inbox.skill.updated
inbox.skill.agent.assigned
inbox.skill.agent.level.updated
inbox.skill.agent.removed
```

Skill and audit writes are transactional. Proficiency and audit writes are also transactional. If an audit insert fails, the business mutation rolls back.

Idempotent proficiency no-ops do not emit duplicate audit records.

## Deliberate non-goals

This foundation does not yet implement:

- conversation skill requirements;
- team skill requirements;
- automatic or weighted routing;
- round-robin routing;
- agent capacity or presence;
- SLA timers or escalation;
- supervisor queues;
- human-agent login sessions or SSO;
- realtime events for skill administration.

Those capabilities can build on the tenant-safe skill catalog and proficiency records introduced here without changing current conversation assignment behavior.
