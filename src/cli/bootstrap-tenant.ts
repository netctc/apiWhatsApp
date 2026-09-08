import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "../generated/prisma/client.js";
import { generateApiKey } from "../auth/api-key.util.js";

interface BootstrapOptions {
  name: string;
  slug: string;
  keyName: string;
  scopes: string[];
  expiresAt?: Date;
}

const DEFAULT_SCOPES = ["messages:read", "messages:write"];

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });

  try {
    const generated = generateApiKey();

    const result = await prisma.$transaction(async (transaction) => {
      const existingTenant = await transaction.tenant.findUnique({
        where: { slug: options.slug },
        select: { id: true },
      });

      if (existingTenant) {
        throw new Error(`Tenant slug '${options.slug}' already exists`);
      }

      const tenant = await transaction.tenant.create({
        data: {
          name: options.name,
          slug: options.slug,
        },
      });

      const apiKey = await transaction.apiKey.create({
        data: {
          tenantId: tenant.id,
          name: options.keyName,
          keyPrefix: generated.keyPrefix,
          keyHash: generated.keyHash,
          scopes: options.scopes,
          expiresAt: options.expiresAt,
        },
      });

      return { tenant, apiKey };
    });

    process.stdout.write(
      [
        "Tenant bootstrap completed.",
        `Tenant ID: ${result.tenant.id}`,
        `Tenant slug: ${result.tenant.slug}`,
        `API key ID: ${result.apiKey.id}`,
        `API key scopes: ${result.apiKey.scopes.join(", ")}`,
        ...(result.apiKey.expiresAt ? [`API key expires at: ${result.apiKey.expiresAt.toISOString()}`] : []),
        "",
        "Store this API key securely. It will not be shown again:",
        generated.rawKey,
        "",
      ].join("\n"),
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new Error("Unable to bootstrap tenant because a unique value already exists", { cause: error });
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

function parseArguments(args: string[]): BootstrapOptions {
  const values = new Map<string, string>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      throw usageError(`Unexpected argument: ${argument}`);
    }

    const key = argument.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw usageError(`Missing value for --${key}`);
    }

    values.set(key, value);
    index += 1;
  }

  const name = required(values, "name").trim();
  const slug = required(values, "slug").trim().toLowerCase();
  const keyName = (values.get("key-name") ?? "Initial API key").trim();
  const scopes = (values.get("scopes") ?? DEFAULT_SCOPES.join(","))
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  const expiresAtValue = values.get("expires-at");

  if (name.length < 2 || name.length > 160) {
    throw usageError("--name must contain between 2 and 160 characters");
  }

  if (!/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(slug)) {
    throw usageError("--slug must be 1-80 lowercase letters, numbers, or hyphens and cannot start/end with a hyphen");
  }

  if (keyName.length < 2 || keyName.length > 120) {
    throw usageError("--key-name must contain between 2 and 120 characters");
  }

  if (scopes.length === 0 || scopes.some((scope) => scope.length > 100)) {
    throw usageError("--scopes must contain one or more comma-separated scope names");
  }

  let expiresAt: Date | undefined;
  if (expiresAtValue) {
    expiresAt = new Date(expiresAtValue);
    if (Number.isNaN(expiresAt.getTime())) {
      throw usageError("--expires-at must be a valid ISO-8601 timestamp");
    }
    if (expiresAt.getTime() <= Date.now()) {
      throw usageError("--expires-at must be in the future");
    }
  }

  return {
    name,
    slug,
    keyName,
    scopes: [...new Set(scopes)],
    expiresAt,
  };
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) {
    throw usageError(`--${key} is required`);
  }
  return value;
}

function usageError(message: string): Error {
  return new Error(
    `${message}\n\nUsage: npm run tenant:bootstrap -- --name "Acme Ltd" --slug acme [--key-name "Production API"] [--scopes messages:read,messages:write] [--expires-at 2027-09-08T00:00:00Z]`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Tenant bootstrap failed: ${message}\n`);
  process.exitCode = 1;
});
