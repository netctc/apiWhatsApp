import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ApiKeyGuard } from "./api-key.guard.js";
import { ScopesGuard } from "./scopes.guard.js";

@Module({
  providers: [
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_GUARD, useClass: ScopesGuard },
  ],
})
export class AuthModule {}
