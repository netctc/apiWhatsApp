import { MessageType } from "../src/generated/prisma/client.js";
import { mapMessageToMetaPayload } from "../src/meta/meta-message.mapper.js";

describe("mapMessageToMetaPayload", () => {
  it("maps a provider-neutral text message to the Meta payload", () => {
    const result = mapMessageToMetaPayload({
      type: MessageType.TEXT,
      to: "+961 70 123 456",
      payload: {
        body: "Order 48291 has been confirmed.",
        previewUrl: false,
      },
    });

    expect(result).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "96170123456",
      type: "text",
      text: {
        body: "Order 48291 has been confirmed.",
        preview_url: false,
      },
    });
  });

  it("maps a template message and preserves Meta template components", () => {
    const components = [
      {
        type: "body",
        parameters: [{ type: "text", text: "48291" }],
      },
    ];

    const result = mapMessageToMetaPayload({
      type: MessageType.TEMPLATE,
      to: "+96170123456",
      payload: {
        name: "order_confirmation",
        language: "en_US",
        components,
      },
    });

    expect(result).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "96170123456",
      type: "template",
      template: {
        name: "order_confirmation",
        language: { code: "en_US" },
        components,
      },
    });
  });

  it("maps an image link and caption", () => {
    expect(
      mapMessageToMetaPayload({
        type: MessageType.IMAGE,
        to: "+96170123456",
        payload: {
          link: "https://cdn.example.com/delivery.jpg?token=abc",
          caption: "Delivery photo",
        },
      }),
    ).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "96170123456",
      type: "image",
      image: {
        link: "https://cdn.example.com/delivery.jpg?token=abc",
        caption: "Delivery photo",
      },
    });
  });

  it("maps a video media id", () => {
    expect(
      mapMessageToMetaPayload({
        type: MessageType.VIDEO,
        to: "+96170123456",
        payload: { id: "video-media-id" },
      }),
    ).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "96170123456",
      type: "video",
      video: { id: "video-media-id" },
    });
  });

  it("maps an audio media id without unsupported caption fields", () => {
    expect(
      mapMessageToMetaPayload({
        type: MessageType.AUDIO,
        to: "+96170123456",
        payload: { id: "audio-media-id" },
      }),
    ).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "96170123456",
      type: "audio",
      audio: { id: "audio-media-id" },
    });
  });

  it("maps a document link with caption and filename", () => {
    expect(
      mapMessageToMetaPayload({
        type: MessageType.DOCUMENT,
        to: "+96170123456",
        payload: {
          link: "https://cdn.example.com/invoice.pdf",
          caption: "Invoice 48291",
          filename: "invoice-48291.pdf",
        },
      }),
    ).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "96170123456",
      type: "document",
      document: {
        link: "https://cdn.example.com/invoice.pdf",
        caption: "Invoice 48291",
        filename: "invoice-48291.pdf",
      },
    });
  });

  it("rejects an invalid text payload before calling Meta", () => {
    expect(() =>
      mapMessageToMetaPayload({
        type: MessageType.TEXT,
        to: "+96170123456",
        payload: {},
      }),
    ).toThrow("TEXT payload requires a non-empty 'body' string");
  });

  it("rejects an invalid media payload before calling Meta", () => {
    expect(() =>
      mapMessageToMetaPayload({
        type: MessageType.IMAGE,
        to: "+96170123456",
        payload: { link: "http://cdn.example.com/image.jpg" },
      }),
    ).toThrow("IMAGE payload 'link' must be an absolute HTTPS URL");
  });

  it("rejects an invalid international recipient", () => {
    expect(() =>
      mapMessageToMetaPayload({
        type: MessageType.TEXT,
        to: "123",
        payload: { body: "Hello" },
      }),
    ).toThrow("Outbound message recipient must be a valid international phone number");
  });
});
