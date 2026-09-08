import { SetMetadata } from "@nestjs/common";

export const REQUIRED_SCOPES_METADATA = "auth.requiredScopes";

export const RequireScopes = (...scopes: string[]) => SetMetadata(REQUIRED_SCOPES_METADATA, scopes);
