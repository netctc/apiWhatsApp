import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface EncryptedClientWebhookSecret {
  secretCiphertext: string;
  secretIv: string;
  secretTag: string;
}

@Injectable()
export class ClientWebhookSecretService {
  constructor(private readonly config: ConfigService) {}

  generateSigningSecret(): string {
    return randomBytes(32).toString("base64url");
  }

  encrypt(secret: string): EncryptedClientWebhookSecret {
    const key = this.encryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      secretCiphertext: ciphertext.toString("base64"),
      secretIv: iv.toString("base64"),
      secretTag: tag.toString("base64"),
    };
  }

  decrypt(value: EncryptedClientWebhookSecret): string {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.encryptionKey(),
      Buffer.from(value.secretIv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(value.secretTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(value.secretCiphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  private encryptionKey(): Buffer {
    const raw = this.config.get<string>("CLIENT_WEBHOOK_SECRET_ENCRYPTION_KEY");
    if (!raw) {
      throw new Error("CLIENT_WEBHOOK_SECRET_ENCRYPTION_KEY is required");
    }

    const key = Buffer.from(raw, "base64");
    if (key.length !== 32 || key.toString("base64").replace(/=+$/u, "") !== raw.trim().replace(/=+$/u, "")) {
      throw new Error("CLIENT_WEBHOOK_SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
    }
    return key;
  }
}
