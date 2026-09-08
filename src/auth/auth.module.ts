import { Module } from "@nestjs/common";
import { ApiKeyGuard } from "./api-key.guard.js";
import { ApiKeysService } from "./api-keys.service.js";
import { ScopesGuard } from "./scopes.guard.js";

@Module({
  providers: [ApiKeysService, ApiKeyGuard, ScopesGuard],
  exports: [ApiKeysService, ApiKeyGuard, ScopesGuard],
})
export class AuthModule {}
