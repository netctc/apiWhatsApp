import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";

@Controller("v1/webhooks/meta/whatsapp")
export class WebhooksController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  verify(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") verifyToken: string,
    @Query("hub.challenge") challenge: string,
  ): string {
    const expectedToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
    if (mode !== "subscribe" || !expectedToken || verifyToken !== expectedToken) {
      throw new UnauthorizedException("Webhook verification failed");
    }
    return challenge;
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers("x-hub-signature-256") signature: string | undefined,
    @Body() payload: Record<string, unknown>,
  ): Promise<{ received: true }> {
    this.verifySignature(request.rawBody, signature);

    await this.prisma.webhookEvent.create({
      data: { payload: this.toJson(payload) },
    });

    return { received: true };
  }

  private verifySignature(rawBody: Buffer | undefined, signature: string | undefined): void {
    const appSecret = process.env.META_APP_SECRET;
    if (!appSecret || !rawBody || !signature?.startsWith("sha256=")) {
      throw new UnauthorizedException("Missing webhook signature configuration");
    }

    const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(signature);

    if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
      throw new UnauthorizedException("Invalid webhook signature");
    }
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
