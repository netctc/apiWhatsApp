import {
  Controller,
  Get,
  Header,
  HttpException,
  HttpStatus,
  Req,
  Res,
} from "@nestjs/common";
import { ApiOperation, ApiProduces, ApiSecurity, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { ApiScope } from "../auth/auth.constants.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import type { InboxRealtimeEvent } from "./inbox-event.types.js";
import { InboxRealtimeService } from "./inbox-realtime.service.js";

@ApiTags("inbox")
@ApiSecurity("apiKey")
@Controller("v1/inbox")
export class InboxEventsController {
  constructor(private readonly realtime: InboxRealtimeService) {}

  @Get("events")
  @Header("Cache-Control", "private, no-store")
  @RequireScopes(ApiScope.INBOX_READ)
  @ApiProduces("text/event-stream")
  @ApiOperation({ summary: "Stream tenant-scoped inbox invalidation events" })
  async stream(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    if (!this.realtime.tryAcquireConnection()) {
      throw new HttpException("Realtime inbox connection limit reached", HttpStatus.SERVICE_UNAVAILABLE);
    }

    let unsubscribe: (() => void) | undefined;
    let unregisterCloser: (() => void) | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let closed = false;

    const close = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      unregisterCloser?.();
      this.realtime.releaseConnection();
      if (!response.writableEnded) response.end();
    };

    const write = (frame: string) => {
      if (closed || response.writableEnded || !response.write(frame)) {
        close();
        return false;
      }
      return true;
    };

    unregisterCloser = this.realtime.registerConnectionCloser(close);
    request.once("close", close);

    try {
      unsubscribe = await this.realtime.subscribe(principal.tenantId, (event) => {
        write(this.frame(event));
      });
      if (closed) {
        unsubscribe();
        return;
      }

      response.status(HttpStatus.OK);
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("Connection", "keep-alive");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders();
      write(": connected\n\n");
      heartbeat = setInterval(() => write(": heartbeat\n\n"), this.realtime.heartbeatMs());
      heartbeat.unref();
    } catch (error) {
      close();
      if (!response.headersSent) {
        throw new HttpException("Realtime inbox service unavailable", HttpStatus.SERVICE_UNAVAILABLE, {
          cause: error,
        });
      }
    }
  }

  private frame(event: InboxRealtimeEvent): string {
    return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({ occurredAt: event.occurredAt, ...event.data })}\n\n`;
  }
}
