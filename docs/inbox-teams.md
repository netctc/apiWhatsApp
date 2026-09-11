# Inbox teams foundation

This slice adds tenant-scoped inbox teams and explicit agent membership as a routing foundation. It does not assign conversations to teams or make routing decisions.

## API

Reads require `inbox:read`:

```text
GET /api/v1/inbox/teams
GET /api/v1/inbox/teams/{teamId}
```

Writes require `inbox:write`:

```text
POST   /api/v1/inbox/teams
PATCH  /api/v1/inbox/teams/{teamId}
PUT    /api/v1/inbox/teams/{teamId}/members/{agentId}
DELETE /api/v1/inbox/teams/{teamId}/members/{agentId}
```

Team creation accepts a required `name` and an optional `description`. `PATCH` can change `name`, `description`, or `active`; an empty description clears it. Teams are deactivated rather than deleted by this API so memberships can remain available for operational history and later routing-policy evolution.

`PUT .../members/{agentId}` is idempotent. A new membership requires an active inbox agent owned by the authenticated tenant. Repeating an existing membership does not create a duplicate row or duplicate audit record.

`DELETE .../members/{agentId}` is also idempotent after the team has been resolved inside the authenticated tenant. Removing an already missing membership returns the current team detail without another audit record.

Existing memberships are deliberately retained when a team or agent is later deactivated. This avoids silently rewriting team history and lets a later routing layer decide how inactive members affect eligibility.

## Tenant integrity

Application queries always include the authenticated tenant ID. Cross-tenant team IDs therefore return the same `404` shape as missing team IDs.

The database adds a second boundary. `InboxTeamMember` stores `tenantId`, `teamId`, and `agentId`; composite foreign keys reference `(tenantId, id)` on both `InboxTeam` and `InboxAgent`. PostgreSQL therefore rejects a membership if either referenced record belongs to another tenant, even if an application-layer ownership check regresses.

Team names are unique per tenant. Membership identity is unique by `teamId + agentId`.

## Audit semantics

Committed changes emit these audit actions:

```text
inbox.team.created
inbox.team.updated
inbox.team.member.added
inbox.team.member.removed
```

Team and audit writes are in one PostgreSQL transaction. Membership and audit writes are also in one transaction. If an audit insert fails, the business mutation rolls back.

Idempotent membership no-ops do not emit duplicate audit records.

## Deliberate non-goals

This foundation does not yet implement:

- conversation-to-team assignment;
- automatic or round-robin routing;
- skill definitions or skill matching;
- agent capacity or presence;
- SLA timers or escalation;
- supervisor queues;
- human-agent login sessions or SSO;
- realtime events for team administration.

Those can build on the tenant-safe team and membership records introduced here without changing current conversation assignment behavior.
