import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { timingSafeEqual } from "node:crypto";

@Injectable()
export class MetricsTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.METRICS_BEARER_TOKEN;
    if (!expected || expected.length < 32) {
      throw new ServiceUnavailableException("Metrics endpoint is not configured");
    }

    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.headers.authorization;
    const actual = this.bearerToken(authorization);
    if (!actual || !this.equal(actual, expected)) {
      throw new UnauthorizedException("Invalid metrics credentials");
    }
    return true;
  }

  private bearerToken(value?: string): string | undefined {
    if (!value) {
      return undefined;
    }
    const match = /^Bearer\s+(.+)$/i.exec(value.trim());
    return match?.[1];
  }

  private equal(actual: string, expected: string): boolean {
    const actualBuffer = Buffer.from(actual, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  }
}
