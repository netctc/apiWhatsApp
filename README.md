# apiWhatsApp

Enterprise-grade WhatsApp Business Platform API for reliable, high-volume messaging through Meta Cloud API.

## Engineering language

English is the primary language for source code, technical documentation, API contracts, commit messages, logs, and operational tooling.

## Initial scope

The first release focuses on the Core Messaging foundation:

- NestJS + TypeScript application bootstrap
- PostgreSQL persistence with Prisma
- Redis for distributed state and caching
- RabbitMQ for durable message processing
- Meta WhatsApp Cloud API adapter
- Outbound message API with idempotency
- Webhook verification and ingestion
- Message delivery status tracking
- Health/readiness endpoints
- Docker-based local development
- OpenAPI documentation

## Architecture principle

API requests accept and persist work quickly. Actual WhatsApp delivery is asynchronous through a durable queue so high-volume campaigns cannot block transactional or API traffic.

## Status

Initial implementation in progress.
