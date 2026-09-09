import { MessageTrafficClass, MessageType } from "../generated/prisma/client.js";

export function deriveTrafficClass(messageType: MessageType, templateCategory?: string | null): MessageTrafficClass {
  if (messageType !== MessageType.TEMPLATE) {
    return MessageTrafficClass.TRANSACTIONAL;
  }

  switch (templateCategory?.trim().toUpperCase()) {
    case "AUTHENTICATION":
      return MessageTrafficClass.OTP;
    case "MARKETING":
      return MessageTrafficClass.MARKETING;
    default:
      return MessageTrafficClass.TRANSACTIONAL;
  }
}
