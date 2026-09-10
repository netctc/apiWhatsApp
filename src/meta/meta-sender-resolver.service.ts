import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PhoneNumbersService } from "../phone-numbers/phone-numbers.service.js";

export interface MetaSenderContext {
  internalSenderId?: string;
  phoneNumberId: string;
  accessToken: string;
  rateLimitPerSecond?: number;
}

export interface MetaWabaContext {
  internalSenderId: string;
  wabaId: string;
  accessToken: string;
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
    return this.toSenderContext(sender);
  }

  async resolveForTenant(tenantId: string, senderId?: string): Promise<MetaSenderContext> {
    const sender = await this.phoneNumbers.resolveForTenant(tenantId, senderId);
    return this.toSenderContext(sender);
  }

  async resolveWaba(tenantId: string, senderId?: string): Promise<MetaWabaContext> {
    const { sender, wabaId } = await this.phoneNumbers.resolveWabaForTenant(tenantId, senderId);
    return {
      internalSenderId: sender.id,
      wabaId,
      accessToken: this.resolveCredentialRef(sender.credentialRef),
    };
  }

  private toSenderContext(sender: {
    id: string;
    providerPhoneNumberId: string;
    credentialRef: string;
    rateLimitPerSecond: number | null;
  }): MetaSenderContext {
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
