import { Module } from "@nestjs/common";
import { CannedResponsesController } from "./canned-responses.controller.js";
import { CannedResponsesService } from "./canned-responses.service.js";

@Module({ controllers: [CannedResponsesController], providers: [CannedResponsesService] })
export class CannedResponsesModule {}
