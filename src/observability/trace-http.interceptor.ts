import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  Optional,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { performance } from "node:perf_hooks";
import { Observable, finalize, tap } from "rxjs";
import { OtlpTraceExporterService } from "./otlp-trace-exporter.service.js";
import { TraceContextService } from "./trace-context.service.js";

@Injectable()
export class TraceHttpInterceptor implements NestInterceptor {
  constructor(
    private readonly trace: TraceContextService,
    @Optional() private readonly otlp?: OtlpTraceExporterService,
  ) {}

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
    const startedAtUnixNano = BigInt(Date.now()) * 1_000_000n;
    const startedAt = performance.now();
    let errorStatus: number | undefined;

    response.setHeader("x-request-id", traceContext.requestId);
    response.setHeader("traceparent", this.trace.traceparent(traceContext) ?? "");

    return new Observable((subscriber) =>
      this.trace.run(traceContext, () =>
        next.handle().pipe(
          tap({
            error: (error: unknown) => {
              errorStatus = error instanceof HttpException ? error.getStatus() : 500;
            },
          }),
          finalize(() => {
            const statusCode = errorStatus ?? response.statusCode;
            const durationNano = BigInt(
              Math.max(0, Math.round((performance.now() - startedAt) * 1_000_000)),
            );
            const controller = context.getClass().name;
            const handler = context.getHandler().name;
            this.otlp?.recordSpan({
              context: traceContext,
              name: `HTTP ${request.method} ${controller}.${handler}`,
              kind: 2,
              startTimeUnixNano: startedAtUnixNano,
              endTimeUnixNano: startedAtUnixNano + durationNano,
              attributes: {
                "http.request.method": request.method,
                "http.response.status_code": statusCode,
                "code.namespace": controller,
                "code.function": handler,
              },
              statusCode: statusCode >= 500 ? 2 : 0,
            });
          }),
        ).subscribe(subscriber),
      ),
    );
  }

  private headerValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }
}
