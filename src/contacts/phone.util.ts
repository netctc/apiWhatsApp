import { BadRequestException } from "@nestjs/common";

const E164_DIGITS = /^[1-9]\d{7,14}$/;

export function normalizePhoneNumber(value: string): string {
  const normalized = value.trim().replace(/^\+/, "");
  if (!E164_DIGITS.test(normalized)) {
    throw new BadRequestException("Phone number must be in E.164 format");
  }
  return normalized;
}
