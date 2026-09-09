import {
  CampaignPersonalizationTemplateError,
  CampaignPersonalizationValueError,
  isCampaignPersonalizationEnabled,
  renderCampaignComponents,
  validateCampaignComponents,
} from "../src/campaigns/campaign-personalization.util.js";

describe("campaign personalization", () => {
  it("requires explicit persisted opt-in before personalization is considered enabled", () => {
    expect(isCampaignPersonalizationEnabled(undefined)).toBe(false);
    expect(isCampaignPersonalizationEnabled({ allOptedIn: true })).toBe(false);
    expect(isCampaignPersonalizationEnabled({ personalizationEnabled: false })).toBe(false);
    expect(isCampaignPersonalizationEnabled({ personalizationEnabled: true })).toBe(true);
  });

  it("renders allowlisted contact fields and top-level scalar metadata", () => {
    const components = [
      {
        type: "body",
        parameters: [
          { type: "text", text: "{{contact.name}}" },
          { type: "text", text: "{{contact.phone}}" },
          { type: "text", text: "{{contact.metadata.plan}}" },
          { type: "text", text: "{{contact.metadata.points}}" },
        ],
      },
    ];

    validateCampaignComponents(components);
    expect(
      renderCampaignComponents(components, {
        name: "Jane Doe",
        phone: "+96170123456",
        language: "en_US",
        timezone: "Asia/Beirut",
        metadata: { plan: "gold", points: 42 },
      }),
    ).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "Jane Doe" },
          { type: "text", text: "+96170123456" },
          { type: "text", text: "gold" },
          { type: "text", text: "42" },
        ],
      },
    ]);
  });

  it("rejects partial interpolation and unsupported expressions", () => {
    expect(() =>
      validateCampaignComponents([
        { type: "body", parameters: [{ type: "text", text: "Hello {{contact.name}}" }] },
      ]),
    ).toThrow(CampaignPersonalizationTemplateError);

    expect(() =>
      validateCampaignComponents([
        { type: "body", parameters: [{ type: "text", text: "{{contact.metadata.profile.name}}" }] },
      ]),
    ).toThrow(CampaignPersonalizationTemplateError);
  });

  it("fails one recipient when a required value is absent or non-scalar", () => {
    const components = [
      { type: "body", parameters: [{ type: "text", text: "{{contact.metadata.plan}}" }] },
    ];

    expect(() =>
      renderCampaignComponents(components, {
        name: null,
        phone: "+96170123456",
        metadata: {},
      }),
    ).toThrow(CampaignPersonalizationValueError);

    expect(() =>
      renderCampaignComponents(components, {
        name: "Jane",
        phone: "+96170123456",
        metadata: { plan: { nested: true } },
      }),
    ).toThrow(CampaignPersonalizationValueError);
  });
});
