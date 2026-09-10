import {
  MediaPayloadError,
  normalizeMediaPayload,
} from "../src/messages/media-payload.util.js";

describe("normalizeMediaPayload", () => {
  it("normalizes an image link and caption", () => {
    expect(
      normalizeMediaPayload("IMAGE", {
        link: " https://cdn.example.com/image.jpg?token=abc ",
        caption: " Delivery photo ",
      }),
    ).toEqual({
      link: "https://cdn.example.com/image.jpg?token=abc",
      caption: "Delivery photo",
    });
  });

  it("normalizes a document media id and filename", () => {
    expect(
      normalizeMediaPayload("DOCUMENT", {
        id: " 987654321 ",
        caption: "Invoice",
        filename: " invoice-48291.pdf ",
      }),
    ).toEqual({
      id: "987654321",
      caption: "Invoice",
      filename: "invoice-48291.pdf",
    });
  });

  it("requires exactly one media source", () => {
    expect(() => normalizeMediaPayload("VIDEO", {})).toThrow(
      "VIDEO payload requires exactly one of 'id' or 'link'",
    );
    expect(() =>
      normalizeMediaPayload("VIDEO", {
        id: "123",
        link: "https://cdn.example.com/video.mp4",
      }),
    ).toThrow("VIDEO payload requires exactly one of 'id' or 'link'");
  });

  it("rejects non-HTTPS and credential-bearing links", () => {
    expect(() =>
      normalizeMediaPayload("IMAGE", { link: "http://cdn.example.com/image.jpg" }),
    ).toThrow("IMAGE payload 'link' must be an absolute HTTPS URL");
    expect(() =>
      normalizeMediaPayload("IMAGE", { link: "https://user:secret@cdn.example.com/image.jpg" }),
    ).toThrow("IMAGE payload 'link' cannot contain embedded credentials");
  });

  it("rejects fragments and unsupported media fields", () => {
    expect(() =>
      normalizeMediaPayload("DOCUMENT", { link: "https://cdn.example.com/file.pdf#page=1" }),
    ).toThrow("DOCUMENT payload 'link' cannot contain a URL fragment");
    expect(() =>
      normalizeMediaPayload("AUDIO", { id: "123", caption: "not supported" }),
    ).toThrow("AUDIO payload contains unsupported field 'caption'");
  });

  it("rejects unsafe document filenames", () => {
    expect(() =>
      normalizeMediaPayload("DOCUMENT", { id: "123", filename: "invoice\nfinal.pdf" }),
    ).toThrow("DOCUMENT payload 'filename' cannot contain control characters");
  });

  it("throws a typed error for unsupported media kinds", () => {
    expect(() => normalizeMediaPayload("STICKER", { id: "123" })).toThrow(MediaPayloadError);
  });
});
