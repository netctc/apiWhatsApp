import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, WhatsAppChannelStatus } from "../generated/prisma/client.js";
import { formatE164PhoneNumber } from "../common/phone-number.util.js";

interface ChannelOptions {
  tenantSlug: string;
  name: string;
  providerPhoneNumberId: string;
  wabaId: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  makeDefault: boolean;
}

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
    const channel = await prisma.$transaction(async (transaction) => {
      const tenant = await transaction.tenant.findUnique({
        where: { slug: options.tenantSlug },
      });
      if (!tenant) {
        throw new Error(`Tenant '${options.tenantSlug}' does not exist`);
      }

      const existingProviderId = await transaction.whatsAppChannel.findUnique({
        where: { providerPhoneNumberId: options.providerPhoneNumberId },
        select: { id: true, tenantId: true },
      });
      if (existingProviderId) {
        throw new Error("The Meta phone number ID is already registered");
      }

      const existingChannelCount = await transaction.whatsAppChannel.count({
        where: { tenantId: tenant.id },
      });
      const isDefault = options.makeDefault || existingChannelCount === 0;

      if (isDefault) {
        await transaction.whatsAppChannel.updateMany({
          where: { tenantId: tenant.id, isDefault: true },
          data: { isDefault: false },
        });
      }

      return transaction.whatsAppChannel.create({
        data: {
          tenantId: tenant.id,
          name: options.name,
          providerPhoneNumberId: options.providerPhoneNumberId,
          wabaId: options.wabaId,
          displayPhoneNumber: options.displayPhoneNumber,
          verifiedName: options.verifiedName,
          status: WhatsAppChannelStatus.ACTIVE,
          isDefault,
        },
      });
    });

    process.stdout.write(
      [
        "WhatsApp channel registered.",
        `Channel ID: ${channel.id}`,
        `Tenant ID: ${channel.tenantId}`,
        `Meta phone number ID: ${channel.providerPhoneNumberId}`,
        `WABA ID: ${channel.wabaId}`,
        `Default: ${channel.isDefault ? "yes" : "no"}`,
        "",
      ].join("\n"),
    );
  } finally {
    await prisma.$disconnect();
  }
}

function parseArguments(args: string[]): ChannelOptions {
  const values = new Map<string, string>();
  let makeDefault = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--default") {
      makeDefault = true;
      continue;
    }

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

  const tenantSlug = required(values, "tenant-slug").trim().toLowerCase();
  const name = required(values, "name").trim();
  const providerPhoneNumberId = required(values, "phone-number-id").trim();
  const wabaId = required(values, "waba-id").trim();
  const verifiedName = values.get("verified-name")?.trim() || undefined;
  const displayPhoneValue = values.get("display-phone-number")?.trim();

  if (!/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(tenantSlug)) {
    throw usageError("--tenant-slug is invalid");
  }
  if (name.length < 2 || name.length > 120) {
    throw usageError("--name must contain between 2 and 120 characters");
  }
  if (!/^\d{5,64}$/.test(providerPhoneNumberId)) {
    throw usageError("--phone-number-id must contain 5-64 digits");
  }
  if (!/^\d{5,64}$/.test(wabaId)) {
    throw usageError("--waba-id must contain 5-64 digits");
  }
  if (verifiedName && verifiedName.length > 160) {
    throw usageError("--verified-name must not exceed 160 characters");
  }

  let displayPhoneNumber: string | undefined;
  if (displayPhoneValue) {
    try {
      displayPhoneNumber = formatE164PhoneNumber(displayPhoneValue);
    } catch {
      throw usageError("--display-phone-number must be a valid international phone number");
    }
  }

  return {
    tenantSlug,
    name,
    providerPhoneNumberId,
    wabaId,
    displayPhoneNumber,
    verifiedName,
    makeDefault,
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
    `${message}\n\nUsage: npm run channel:register -- --tenant-slug acme --name "Primary WhatsApp" --phone-number-id 123456789 --waba-id 987654321 [--display-phone-number +96170123456] [--verified-name "Acme"] [--default]`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Channel registration failed: ${message}\n`);
  process.exitCode = 1;
});
