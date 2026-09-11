#!/usr/bin/env node

import "dotenv/config";
import { createHmac, randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../dist/generated/prisma/client.js";

const connectionString = process.env.DATABASE_URL?.trim();
const hashSecret = process.env.API_KEY_HASH_SECRET?.trim();
const recipient = (process.env.CAPACITY_TEST_RECIPIENT ?? "+96170876543").trim();
const credentialEnvName = (process.env.CAPACITY_META_TOKEN_ENV_NAME ?? "TEST_META_ACCESS_TOKEN").trim();

if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}
if (!hashSecret || hashSecret.length < 32) {
  throw new Error("API_KEY_HASH_SECRET must contain at least 32 characters");
}
if (!/^\+[1-9]\d{7,14}$/.test(recipient)) {
  throw new Error("CAPACITY_TEST_RECIPIENT must be an E.164 phone number");
}
if (!/^[A-Z_][A-Z0-9_]*$/.test(credentialEnvName)) {
  throw new Error("CAPACITY_META_TOKEN_ENV_NAME must be an environment variable name");
}
if (!process.env[credentialEnvName]?.trim()) {
  throw new Error(`${credentialEnvName} must contain the controlled Meta access token`);
}

const keyPrefix = randomBytes(6).toString("hex");
const rawKey = `wapi_${keyPrefix}_${randomBytes(32).toString("base64url")}`;
const keyHash = createHmac("sha256", hashSecret).update(rawKey).digest("hex");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const runSuffix = String(process.env.GITHUB_RUN_ID ?? Date.now()).replace(/[^0-9]/g, "") || String(Date.now());
const normalizedPhone = recipient.slice(1);

try {
  await prisma.$connect();
  const result = await prisma.$transaction(async (transaction) => {
    const tenant = await transaction.tenant.create({
      data: {
        name: `Hosted Capacity ${runSuffix}`,
        slug: `hosted-capacity-${runSuffix}`,
      },
    });

    await transaction.apiKey.create({
      data: {
        tenantId: tenant.id,
        name: "hosted-capacity",
        prefix: keyPrefix,
        keyHash,
        scopes: ["messages:write", "operations:read"],
      },
    });

    await transaction.contact.create({
      data: {
        tenantId: tenant.id,
        phone: normalizedPhone,
        name: "Hosted Capacity Contact",
        consentStatus: "OPTED_IN",
        consentSource: "hosted-capacity",
        consentAt: new Date(),
        lastInboundAt: new Date(),
        serviceWindowExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const providerPhoneNumberId = `${runSuffix}${String(Date.now()).slice(-6)}`;
    const sender = await transaction.whatsAppPhoneNumber.create({
      data: {
        tenantId: tenant.id,
        providerPhoneNumberId,
        displayPhoneNumber: normalizedPhone,
        verifiedName: "Hosted Capacity Sender",
        credentialRef: `env:${credentialEnvName}`,
        rateLimitPerSecond: 1000,
        active: true,
        isDefault: true,
      },
    });

    return { tenant, sender };
  });

  process.stdout.write(
    JSON.stringify({
      tenantId: result.tenant.id,
      apiKey: rawKey,
      recipient,
      senderId: result.sender.id,
    }),
  );
} finally {
  await prisma.$disconnect();
}
