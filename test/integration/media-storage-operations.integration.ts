import { randomUUID } from "node:crypto";
import { OperationsService } from "../../src/operations/operations.service.js";
import { PrismaService } from "../../src/prisma/prisma.service.js";

function requireDatabase(): void {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests");
  }
}

describe("media storage operations integration", () => {
  let prisma: PrismaService;
  let operations: OperationsService;
  let tenantId: string;
  let senderId: string;

  beforeAll(async () => {
    requireDatabase();
    prisma = new PrismaService();
    await prisma.$connect();
    operations = new OperationsService(prisma);

    const suffix = `${process.pid}-${Date.now()}`;
    const tenant = await prisma.tenant.create({
      data: {
        name: `Media Operations Tenant ${suffix}`,
        slug: `media-operations-${suffix}`,
      },
    });
    tenantId = tenant.id;

    const sender = await prisma.whatsAppPhoneNumber.create({
      data: {
        tenantId,
        providerPhoneNumberId: `media-ops-${Date.now()}`,
        credentialRef: "env:TEST_META_ACCESS_TOKEN",
        active: true,
        isDefault: true,
      },
    });
    senderId = sender.id;

    const now = Date.now();
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: randomUUID(),
          tenantId,
          senderId,
          providerMediaId: `media.ops.active.${now}`,
          category: "IMAGE",
          mimeType: "image/jpeg",
          size: 100,
          scanMode: "CLAMAV",
          scanStatus: "CLEAN",
          storageMode: "FILESYSTEM",
          storageKey: `${tenantId}/${randomUUID()}`,
          storedAt: new Date(now - 60_000),
          providerUploadedAt: new Date(now - 60_000),
          expiresAt: new Date(now + 12 * 60 * 60 * 1000),
        },
        {
          id: randomUUID(),
          tenantId,
          senderId,
          category: "DOCUMENT",
          mimeType: "application/pdf",
          size: 200,
          scanMode: "CLAMAV",
          scanStatus: "CLEAN",
          storageMode: "FILESYSTEM",
          storageKey: `${tenantId}/${randomUUID()}`,
          storedAt: new Date(now - 120_000),
          expiresAt: new Date(now + 48 * 60 * 60 * 1000),
          failedAt: new Date(now - 30_000),
          failureCode: "HTTP_503",
        },
        {
          id: randomUUID(),
          tenantId,
          senderId,
          providerMediaId: `media.ops.expired.${now}`,
          category: "IMAGE",
          mimeType: "image/png",
          size: 300,
          scanMode: "DISABLED",
          scanStatus: "NOT_SCANNED",
          storageMode: "DISABLED",
          providerUploadedAt: new Date(now - 3 * 24 * 60 * 60 * 1000),
          expiresAt: new Date(now - 24 * 60 * 60 * 1000),
        },
      ],
    });
  });

  afterAll(async () => {
    if (prisma && tenantId) {
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }
    await prisma?.$disconnect();
  });

  it("reports tenant media lifecycle and retained-byte diagnostics from PostgreSQL", async () => {
    const snapshot = await operations.snapshot(tenantId);

    expect(snapshot.mediaAssets).toEqual({
      total: 3,
      providerUploaded: 2,
      failed: 1,
      expired: 1,
      retainedBinaries: 2,
      retainedBytes: 300,
      expiringWithin24Hours: 1,
    });
  });
});
