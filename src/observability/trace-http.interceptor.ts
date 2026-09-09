import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { Observable } from "rxjs";
import { TraceContextService } from "./trace-context.service.js";

@Injectable()
export class TraceHttpInterceptor implements NestInterceptor {
  constructor(private readonly trace: TraceContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const traceContext = this.trace.createIncoming(
      this.headerValue(request.headers.traceparent),
      this.headerValue(request.headers["x-request-id"]),
    );

    response.setHeader("x-request-id", traceContext.requestId);
    response.setHeader("traceparent", this.trace.traceparent(traceContext) ?? "");

    return new Observable((subscriber) =>
      this.trace.run(traceContext, () => next.handle().subscribe(subscriber)),
    );
  }

  private headerValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }
}
