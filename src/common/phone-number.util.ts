export function normalizeWhatsAppPhoneNumber(value: string): string {
  const normalized = value.replace(/\D/g, "");

  if (normalized.length < 8 || normalized.length > 15) {
    throw new Error("Phone number must be a valid international number containing 8 to 15 digits");
  }

  return normalized;
}

export function formatE164PhoneNumber(value: string): string {
  return `+${normalizeWhatsAppPhoneNumber(value)}`;
}
