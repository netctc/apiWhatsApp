import { tmpdir } from "node:os";
import { Module } from "@nestjs/common";
import { MulterModule } from "@nestjs/platform-express";
import { MetaModule } from "../meta/meta.module.js";
import { MediaController } from "./media.controller.js";
import { MAX_MEDIA_UPLOAD_BYTES } from "./media-upload.policy.js";
import { MediaService } from "./media.service.js";

@Module({
  imports: [
    MetaModule,
    MulterModule.register({
      dest: tmpdir(),
      limits: {
        fileSize: MAX_MEDIA_UPLOAD_BYTES,
        files: 1,
        fields: 1,
        fieldNameSize: 100,
      },
    }),
  ],
  controllers: [MediaController],
  providers: [MediaService],
})
export class MediaModule {}
