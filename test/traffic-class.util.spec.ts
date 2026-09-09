import { MessageTrafficClass, MessageType } from "../src/generated/prisma/client.js";
import { deriveTrafficClass } from "../src/messages/traffic-class.util.js";

describe("deriveTrafficClass", () => {
  it("maps authentication templates to OTP", () => {
    expect(deriveTrafficClass(MessageType.TEMPLATE, "AUTHENTICATION")).toBe(MessageTrafficClass.OTP);
  });

  it("maps marketing templates to MARKETING", () => {
    expect(deriveTrafficClass(MessageType.TEMPLATE, "marketing")).toBe(MessageTrafficClass.MARKETING);
  });

  it("maps utility and unknown template categories to TRANSACTIONAL", () => {
    expect(deriveTrafficClass(MessageType.TEMPLATE, "UTILITY")).toBe(MessageTrafficClass.TRANSACTIONAL);
    expect(deriveTrafficClass(MessageType.TEMPLATE, undefined)).toBe(MessageTrafficClass.TRANSACTIONAL);
  });

  it("never promotes free-form text to OTP or marketing", () => {
    expect(deriveTrafficClass(MessageType.TEXT, "AUTHENTICATION")).toBe(MessageTrafficClass.TRANSACTIONAL);
    expect(deriveTrafficClass(MessageType.TEXT, "MARKETING")).toBe(MessageTrafficClass.TRANSACTIONAL);
  });
});
