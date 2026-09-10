# Sender secret references

WhatsApp sender credentials are stored in PostgreSQL as references, never as raw Meta access tokens.

Supported reference schemes:

```text
env:VARIABLE_NAME
file:/absolute/path/to/mounted-secret
```

## Environment references

`env:` remains the default deployment model. The referenced name must match a strict uppercase environment-variable pattern and the value is resolved only when a sender is used.

Example:

```text
credentialRef=env:META_ACME_WHATSAPP_TOKEN
```

The raw token is not copied into PostgreSQL, audit metadata, API responses, logs, or queue payloads.

## Mounted file references

`file:` supports Docker/Kubernetes-style mounted secrets without adding a cloud-vendor SDK.

Example:

```text
credentialRef=file:/run/secrets/api-whatsapp/acme-meta-token
```

Allowed roots are configured globally:

```text
SECRET_FILE_ROOTS=/run/secrets/api-whatsapp
```

Multiple roots can be supplied as a comma-separated list. Every configured root must be absolute and the filesystem root `/` is rejected.

At runtime the resolver:

1. requires an absolute file path;
2. resolves the target with `realpath`;
3. requires the resolved target to remain inside one configured root;
4. opens the resolved file read-only with `O_NOFOLLOW`;
5. requires a regular file between 1 byte and 64 KiB;
6. reads UTF-8 content;
7. strips only trailing CR/LF terminators commonly added by secret mounts;
8. rejects empty, oversized, NUL-containing, or remaining multi-line values.

The path and secret content are not written to normal application logs.

## Rotation

Mounted secret values are deliberately not cached by `SecretReferenceService`. Every sender resolution reads the current file content, so a secret replaced by the deployment platform is observed on the next provider request without restarting the API or outbound worker.

This behavior is especially useful with projected/atomic secret mounts. Operators should still use deployment mechanisms that protect the parent directories from untrusted mutation. The application confines the resolved target to configured roots, but it does not replace host/container filesystem access controls.

## Administrative behavior

The sender API stores only `credentialRef`. Registration or update should validate the reference syntax/policy but should not require the referenced secret to be readable at administration time: the secret can be mounted independently on each runtime replica.

Runtime resolution remains fail-closed. A missing, invalid, outside-root, oversized, or otherwise unreadable file prevents provider access for that sender.

## Failure boundaries

Outbound worker sender-resolution failures retain the existing `SENDER_CONFIGURATION_ERROR` handling and are dead-lettered before a Meta request.

Interactive media upload also resolves the tenant sender before provider access. Secret resolution failures must not expose the file path or token to API callers.

## Security boundary

Mounted files are a provider-neutral secret source, not a full secret-management platform. This slice does not implement:

- AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, or HashiCorp Vault APIs;
- automatic secret creation/version management;
- provider-side IAM policy management;
- secret replication;
- secret-value caching.

Vendor-backed secret managers can later implement the same reference abstraction without changing persisted sender ownership or Meta client contracts.

## Verification

Unit coverage validates environment references, allowed-root file reads, trailing newline handling, rotation without caching, outside-root rejection, symlink escape rejection, relative/root-level configuration rejection, size limits, and single-line content.

The real integration test registers a sender using `file:` through the tenant administrative API, uploads media through that sender, rotates the mounted token without restarting the Nest application, uploads again, and requires the controlled Meta test double to observe the new bearer token on the second request.
