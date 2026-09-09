import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { createHmac, randomBytes } from "node:crypto";
import { PrismaClient } from "../src/generated/prisma/client.js";

function readArg(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value?.slice(prefix.length);
}

const name = readArg("name");
const slug = readArg("slug");
const keyName = readArg("key-name") ?? "bootstrap";
const connectionString = process.env.DATABASE_URL;
const hashSecret = process.env.API_KEY_HASH_SECRET;

if (!name || !slug) {
  throw new Error("Usage: npm run bootstrap:tenant -- --name=Acme --slug=acme [--key-name=production]");
}
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}
if (!hashSecret) {
  throw new Error("API_KEY_HASH_SECRET is required");
}

const keyPrefix = randomBytes(6).toString("hex");
const rawKey = `wapi_${keyPrefix}_${randomBytes(32).toString("base64url")}`;
const keyHash = createHmac("sha256", hashSecret).update(rawKey).digest("hex");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

try {
  await prisma.$connect();
  const result = await prisma.$transaction(async (transaction) => {
    const tenant = await transaction.tenant.upsert({
      where: { slug },
      update: { name },
      create: { name, slug },
    });

    const apiKey = await transaction.apiKey.create({
      data: {
        tenantId: tenant.id,
        name: keyName,
        prefix: keyPrefix,
        keyHash,
        scopes: [
          "messages:read",
          "messages:write",
          "contacts:read",
          "contacts:write",
          "phone_numbers:read",
          "phone_numbers:write",
          "templates:read",
          "templates:write",
          "api_keys:read",
          "api_keys:write",
          "audit:read",
        ],
      },
    });

    return { tenant, apiKey };
  });

  console.log(JSON.stringify({
    tenantId: result.tenant.id,
    tenantSlug: result.tenant.slug,
    apiKeyId: result.apiKey.id,
    apiKey: rawKey,
  }, null, 2));
  console.error("Store the API key securely now. It cannot be recovered from the database.");
} finally {
  await prisma.$disconnect();
}
