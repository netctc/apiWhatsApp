import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";

@Injectable()
export class ChannelsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(tenantId: string) {
    return this.prisma.whatsAppChannel.findMany({
      where: { tenantId },
      select: {
        id: true,
        name: true,
        providerPhoneNumberId: true,
        wabaId: true,
        displayPhoneNumber: true,
        verifiedName: true,
        status: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [
        { isDefault: "desc" },
        { createdAt: "asc" },
      ],
    });
  }
}
