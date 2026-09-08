import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PhoneNumbersService } from "../phone-numbers/phone-numbers.service.js";

export interface MetaSenderContext {
  internalSenderId?: string;
  phoneNumberId: string;
  accessToken: string;
  rateLimitPerSecond?: number;
}

@Injectable()
export class MetaSenderResolverService {
  constructor(
    private readonly config: ConfigService,
    private readonly phoneNumbers: PhoneNumbersService,
  ) {}

  async resolve(senderId: string | null): Promise<MetaSenderContext> {
    if (!senderId) {
      return {
        phoneNumberId: this.required("META_WHATSAPP_PHONE_NUMBER_ID"),
        accessToken: this.required("META_WHATSAPP_ACCESS_TOKEN"),
      };
    }

    const sender = await this.phoneNumbers.findActiveById(senderId);
    return {
      internalSenderId: sender.id,
      phoneNumberId: sender.providerPhoneNumberId,
      accessToken: this.resolveCredentialRef(sender.credentialRef),
      rateLimitPerSecond: sender.rateLimitPerSecond ?? undefined,
    };
  }

  private resolveCredentialRef(credentialRef: string): string {
    if (!credentialRef.startsWith("env:")) {
      throw new Error(`Unsupported Meta credential reference ${credentialRef}`);
    }

    const variableName = credentialRef.slice(4);
    const value = this.config.get<string>(variableName);
    if (!value) {
      throw new Error(`Meta credential ${credentialRef} is not available in the runtime environment`);
    }
    return value;
  }

  private required(name: string): string {
    const value = this.config.get<string>(name);
    if (!value) {
      throw new Error(`${name} is required`);
    }
    return value;
  }
}
