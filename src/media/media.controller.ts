import {
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from "@nestjs/swagger";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiScope } from "../auth/auth.constants.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import { MediaService, type StoredMediaUploadFile } from "./media.service.js";

@ApiTags("media")
@ApiSecurity("apiKey")
@Controller("v1/media")
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post()
  @RequireScopes(ApiScope.MEDIA_WRITE)
  @UseInterceptors(FileInterceptor("file"))
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Upload one bounded media file to Meta for a tenant WhatsApp sender" })
  @ApiBody({
    schema: {
      type: "object",
      required: ["file"],
      properties: {
        senderId: {
          type: "string",
          format: "uuid",
          description: "Optional tenant-scoped sender. The active default sender is used when omitted.",
        },
        file: {
          type: "string",
          format: "binary",
        },
      },
    },
  })
  upload(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Body() fields: Record<string, unknown>,
    @UploadedFile() file: StoredMediaUploadFile | undefined,
  ) {
    return this.media.upload(principal.tenantId, fields, file);
  }
}
