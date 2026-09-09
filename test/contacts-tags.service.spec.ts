import { jest } from "@jest/globals";
import { ContactsService } from "../src/contacts/contacts.service.js";

const TENANT_ID = "123e4567-e89b-42d3-a456-426614174000";
const CONTACT_ID = "76502a14-7dd9-4bf2-894e-ff7d477f40f0";

describe("ContactsService tags", () => {
  const contactFindUnique = jest.fn();
  const contactFindFirst = jest.fn();
  const contactCreate = jest.fn();
  const contactUpdate = jest.fn();

  const service = new ContactsService({
    contact: {
      findUnique: contactFindUnique,
      findFirst: contactFindFirst,
      create: contactCreate,
      update: contactUpdate,
    },
  } as never);

  beforeEach(() => {
    jest.clearAllMocks();
    contactFindUnique.mockResolvedValue(null);
    contactFindFirst.mockResolvedValue({ id: CONTACT_ID, tenantId: TENANT_ID });
    contactCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: CONTACT_ID,
      ...data,
    }));
    contactUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: CONTACT_ID,
      ...data,
    }));
  });

  it("stores tags lowercase, deduplicated, and sorted", async () => {
    await service.create(TENANT_ID, {
      phone: "+96170123456",
      tags: ["VIP", "renewal:2026", "vip", "Marketing"],
    });

    expect(contactCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT_ID,
        tags: ["marketing", "renewal:2026", "vip"],
      }),
    });
  });

  it("allows replacing the tag set with an empty array", async () => {
    await service.update(TENANT_ID, CONTACT_ID, { tags: [] });

    expect(contactUpdate).toHaveBeenCalledWith({
      where: { id: CONTACT_ID },
      data: expect.objectContaining({ tags: [] }),
    });
  });
});
