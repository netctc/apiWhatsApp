# Administrative audit log

apiWhatsApp stores tenant administrative audit events in the append-only `AuditLog` table. Release 0.15.0 extends the existing API-key audit coverage to WhatsApp sender configuration, template catalog synchronization, and saved contact segments.

## Design guarantees

- Audit events are tenant-scoped.
- API-triggered configuration mutations record the authenticated API key as the actor.
- Source IP and user agent are recorded when available from the HTTP request.
- For database-only mutations, the configuration change and its audit event are committed in the same PostgreSQL transaction.
- Template synchronization performs the remote Meta read first; after the complete catalog has been received, local catalog changes and the audit event are committed in one PostgreSQL transaction.
- Internal service calls that provide only a tenant ID do not fabricate a human/API actor.
- Raw API keys, API-key hashes, Meta access tokens, sender credential references, phone-number values, customer segment tag values, template bodies, template names, provider payloads, and template rejection text are not copied into administrative audit metadata.

## Reading audit events

```text
GET /api/v1/audit-logs
```

The endpoint requires:

```text
audit:read
```

Audit results are tenant-scoped and cursor paginated. Existing query filters can be used to locate action/entity families.

## Action catalog

### API keys

Existing lifecycle actions:

```text
api_key.created
api_key.revoked
```

API-key creation/revocation and the corresponding audit event are committed atomically. Raw API-key material and the stored HMAC digest are never included in audit metadata.

### WhatsApp senders

```text
whatsapp_phone_number.created
whatsapp_phone_number.updated
```

Entity type:

```text
WhatsAppPhoneNumber
```

Safe metadata may include:

```text
changedFields
credentialConfigured / credentialChanged
wabaConfigured
rateLimitPerSecond
active
isDefault
```

When `credentialRef` changes, the audit field list records the logical field name `credential`; the reference/value itself is not recorded.

The audit event does not contain:

```text
credentialRef
Meta access token
displayPhoneNumber
provider phone-number value
```

### Saved contact segments

```text
contact_segment.created
contact_segment.updated
```

Entity type:

```text
ContactSegment
```

Safe metadata may include:

```text
name
changedFields
active
definitionChanged
criteria.languageConfigured
criteria.tagsAnyCount
criteria.tagsAllCount
```

The values of `tagsAny` and `tagsAll` are intentionally not copied into the audit log. This prevents the audit ledger from becoming a secondary store of audience/customer classification data.

### WhatsApp template catalog synchronization

```text
template_catalog.synced
```

Entity type:

```text
WhatsAppBusinessAccount
```

The entity ID is the WABA identifier. Safe metadata includes aggregate results only:

```text
synced
markedDeleted
statusCounts
categoryCounts
```

Example shape:

```json
{
  "synced": 24,
  "markedDeleted": 1,
  "statusCounts": {
    "APPROVED": 20,
    "PAUSED": 3,
    "REJECTED": 1
  },
  "categoryCounts": {
    "MARKETING": 10,
    "UTILITY": 8,
    "AUTHENTICATION": 6
  }
}
```

The audit event deliberately excludes individual template names, languages, components/body text, provider payloads, quality details, and rejection reasons.

## Atomicity model

For sender and segment mutations:

```text
BEGIN
  configuration mutation
  audit-log insert
COMMIT
```

If the audit insert fails, the configuration mutation is rolled back.

For template synchronization:

```text
complete remote Meta catalog read
        |
        v
BEGIN
  local template upserts
  local deletion markers
  aggregate audit-log insert
COMMIT
```

A failed/incomplete remote read does not create a successful sync audit event and does not partially apply the remote catalog.

## Metadata policy

Audit metadata should answer:

- what kind of configuration changed;
- which tenant-scoped entity changed;
- which authenticated key performed the action;
- when/from where the action occurred;
- which bounded administrative fields changed;
- what aggregate outcome occurred.

Audit metadata should **not** duplicate secrets, message/customer content, provider response bodies, or high-volume domain records.

Before adding a new audit field, ask:

1. Is this value necessary to prove/understand the administrative change?
2. Could this value be a secret or customer/business-sensitive value?
3. Can a boolean, count, enum, or field-name list provide the same audit value?
4. Is its size and cardinality bounded?

Prefer bounded summaries over copied configuration values.

## Retention and access

The application currently provides append-only creation and tenant-scoped read access; it does not expose an API endpoint for editing or deleting audit events.

Production retention duration, archival, legal-hold policy, and export to a SIEM should be configured according to the deployment's regulatory and organizational requirements.
