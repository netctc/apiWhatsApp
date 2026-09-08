import { jest } from "@jest/globals";
import { ConsentStatus } from "../src/generated/prisma/client.js";
import { ContactsService } from "../src/contacts/contacts.service.js";
import { ConsentDecision } from "../src/contacts/dto/record-consent.dto.js";

describe("ContactsService consent ordering", () => {
  const queryRaw = jest.fn();
  const findUniqueOrThrow = jest.fn();
  const findLatestEvent = jest.fn();
  const createEvent = jest.fn();
  const updateContact = jest.fn();

  const transaction = {
    $queryRaw: queryRaw,
    contact: {
      findUniqueOrThrow,
      update: updateContact,
    },
    contactConsentEvent: {
      findFirst: findLatestEvent,
      create: createEvent,
    },
  };

  const runTransaction = jest.fn(
    async (callback: (value: typeof transaction) => Promise<unknown>) => callback(transaction),
  );
  const service = new ContactsService({ $transaction: runTransaction } as never);

  beforeEach(() => {
    queryRaw.mockReset();
    findUniqueOrThrow.mockReset();
    findLatestEvent.mockReset();
    createEvent.mockReset();
    updateContact.mockReset();
    runTransaction.mockClear();

    queryRaw.mockResolvedValue([{ id: "contact-1" }]);
    findUniqueOrThrow.mockResolvedValue({
      id: "contact-1",
      tenantId: "tenant-1",
      consentStatus: ConsentStatus.OPTED_OUT,
      consentAt: new Date("2026-09-08T09:00:00.000Z"),
      optedOutAt: new Date("2026-09-08T12:00:00.000Z"),
    });
    createEvent.mockImplementation(async (args: { data: { status: ConsentStatus; occurredAt: Date } }) => ({
      id: "event-new",
      ...args.data,
    }));
  });

  it("records an older audit event without replacing the current consent state", async () => {
    findLatestEvent.mockResolvedValue({ occurredAt: new Date("2026-09-08T12:00:00.000Z") });

    const result = await service.recordConsent("tenant-1", "contact-1", {
      status: ConsentDecision.OPTED_IN,
      source: "historical_import",
      occurredAt: "2026-09-08T10:00:00.000Z",
    });

    expect(createEvent).toHaveBeenCalled();
    expect(updateContact).not.toHaveBeenCalled();
    expect(result.contact.consentStatus).toBe(ConsentStatus.OPTED_OUT);
  });

  it("updates the current consent snapshot when the event is newest", async () => {
    findLatestEvent.mockResolvedValue({ occurredAt: new Date("2026-09-08T12:00:00.000Z") });
    updateContact.mockResolvedValue({
      id: "contact-1",
      tenantId: "tenant-1",
      consentStatus: ConsentStatus.OPTED_IN,
      consentSource: "customer_portal",
      consentAt: new Date("2026-09-08T13:00:00.000Z"),
      optedOutAt: null,
    });

    const result = await service.recordConsent("tenant-1", "contact-1", {
      status: ConsentDecision.OPTED_IN,
      source: "customer_portal",
      occurredAt: "2026-09-08T13:00:00.000Z",
    });

    expect(updateContact).toHaveBeenCalledWith({
      where: { id: "contact-1" },
      data: expect.objectContaining({
        consentStatus: ConsentStatus.OPTED_IN,
        consentSource: "customer_portal",
        optedOutAt: null,
      }),
    });
    expect(result.contact.consentStatus).toBe(ConsentStatus.OPTED_IN);
  });
});
