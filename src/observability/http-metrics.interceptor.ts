import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { performance } from "node:perf_hooks";
import { Observable, finalize, tap } from "rxjs";
import { MetricsService } from "./metrics.service.js";

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const startedAt = performance.now();
    let errorStatus: number | undefined;

    return next.handle().pipe(
      tap({
        error: (error: unknown) => {
          errorStatus = error instanceof HttpException ? error.getStatus() : 500;
        },
      }),
      finalize(() => {
        this.metrics.recordHttp(
          request.method,
          context.getClass().name,
          context.getHandler().name,
          errorStatus ?? response.statusCode,
          (performance.now() - startedAt) / 1000,
        );
      }),
    );
  }
}
