import { SetMetadata } from "@nestjs/common";
import { ApiScope, REQUIRED_SCOPES_KEY } from "./auth.constants.js";

export const RequireScopes = (...scopes: ApiScope[]) => SetMetadata(REQUIRED_SCOPES_KEY, scopes);
