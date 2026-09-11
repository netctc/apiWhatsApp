# Inbox, media and security integration candidate

This branch assembles previously separate changes into one reviewable candidate
against `main`. It is not a release tag, a deployment, or authorization to send
WhatsApp messages. Source code, tests and operational documentation remain in
English. The application version remains `0.18.0` until a release is approved.

## Pinned inputs

| Input | Commit | Purpose |
| --- | --- | --- |
| main baseline | `1903fe9a261d56fecf703f4816915fc17b3ee5f9` | Existing application and media reconciliation |
| PR #57 | `1a7ce1837dd52e5efb100572085f6f4fe03f2dc2` | Dependency remediation and fail-closed full/runtime audits |
| PR #55 | `423373f65eb6b5b84bb38bf084755d5bae3ce3f1` | Bounded mono Opus admission and multipart regressions |
| PR #58 | `40f698e42304b35193261e1d66a14416d0392c5b` | Tenant-scoped paginated internal note history |
| PR #59 | `ff4edae868a4d17bd4e694f3b7cfb8b146934f7d` | Revision-safe canned responses, including the mutable-filter pagination fix |

The tree starts from the pinned #59 head, which already contains #57 and the
main baseline. Only the eight #55 paths and nine #58 paths are imported from
their pinned source blobs. Their changed path sets are disjoint from each other
and from changes on the #59 side of their merge bases. The #55 branch predates
main's media-reconciliation change; importing an entire older branch tree would
incorrectly lose that work. This candidate instead retains #59's existing tree
and applies only the reviewed, nonoverlapping paths.

The integration commit preserves #59 as its first parent and #55/#58 as
additional parents. #57 is already an ancestor through #59. Source branch refs
and `main` are not advanced. No source PR is closed or marked merged merely by
creating this candidate.

## Combined behavior

The candidate includes all source regression suites unchanged, plus nine new
HTTP/PostgreSQL integration cases in
`test/integration/inbox-media-candidate.integration.ts`:

- Explicitly copy reusable text into an internal note, edit/deactivate the
  reusable response, and verify the saved note and conversation state remain
  unchanged. This is test-client composition, not a new automatic-copy endpoint.
- Append two notes while two same-revision snippet edits compete; verify both
  notes persist and only one edit succeeds.
- Traverse both histories with tied timestamps while a snippet cursor is
  deactivated and a newer note is appended, retaining each collection's order.
- Reject cross-resource cursors and cross-tenant reads without revealing content.
- Preserve independent inbox-read, inbox-write and media scopes and API-key
  requirements in the combined application.
- Reject three structurally misleading Ogg fixtures before scanning or sender
  resolution, remove multipart temporary files, and leave both inbox modules
  usable. These tests install fail-closed spies at external-service seams; they
  do not exercise a live scanner or Meta. The imported #55 suite separately
  covers accepted uploads with controlled local scanner/provider servers.
- Retain GET and POST on the same note-history OpenAPI path, all canned-response
  operations, and the protected media upload operation.

Tests additionally check that the composed operations create no messages or
media registry entries and no outbox entries for note/snippet/conversation IDs.
Raw API keys and note/snippet text are not added to audit metadata by this work.

## Validation and merge procedure

Do not add the source PRs' test totals to report candidate success: the combined
commit must pass its own CI. Required jobs remain `build`,
`dependency-security`, `runtime-security`, `integration` and `docker-build`.
The actual run/commit and verified results are recorded in the candidate PR.
No old green run is treated as proof for this new tree.

Reproduce against an isolated test database and controlled test services:

```bash
npm ci
npm run prisma:generate
npm run lint
npm run build
npm test
npm run prisma:deploy
npm run test:integration
```

The deployment command above must target the isolated test database when
reproducing integration tests. The CI security jobs also test the audit policy
and Prisma compatibility, audit the complete locked tree and audit a separately
installed production tree. Do not force dependency upgrades or suppress audits
to obtain a green run.

Review may proceed through either the original source PRs or this aggregate PR,
not blindly through both. If the original PRs are merged first, refresh this
candidate against the resulting main and rerun CI. If the aggregate is selected,
review all included changes and the resulting merge against the actual main
before merging. This document does not close, retarget or approve any PR.

## Migration and rollback

There are thirteen migrations in this candidate. The only addition relative to
main is `20260911143000_inbox_canned_responses`, already supplied by #59. Apply
it with `npm run prisma:deploy` before starting the candidate application after
review and environment approval. No integration-only migration or environment
variable is introduced. The combined tree retains the reviewed #57 lockfile and
security workflow rather than adding dependency updates of its own.

The new table does not rewrite existing messages, conversations or templates.
An application rollback can retain `InboxCannedResponse` to preserve saved
responses. Do not automatically drop populated tables. Rolling back to a build
before #57 would reintroduce the older dependency tree; select a rollback build
that retains the security remediation.

## Limits

Canned responses are not Meta-approved message templates and library operations
do not send WhatsApp messages. Note and snippet reads are not cross-request
snapshots. No frontend, human-agent login, realtime delivery, production capacity
certification or live Meta validation is added here. A successful Docker build
is not a deployment; clean known-advisory audits do not prove absence of all
vulnerabilities. Review, environment provisioning, live-provider validation and
production acceptance remain separate gates.
