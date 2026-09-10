import {
  MediaUploadPolicyError,
  resolveMediaUploadPolicy,
} from "../src/media/media-upload.policy.js";

const MB = 1_000_000;

describe("resolveMediaUploadPolicy", () => {
  it("accepts supported image, audio, video, and document MIME types", () => {
    expect(resolveMediaUploadPolicy("image/jpeg", 5 * MB)).toEqual(
      expect.objectContaining({ category: "IMAGE", maxBytes: 5 * MB }),
    );
    expect(resolveMediaUploadPolicy("audio/ogg", 16 * MB)).toEqual(
      expect.objectContaining({ category: "AUDIO", maxBytes: 16 * MB }),
    );
    expect(resolveMediaUploadPolicy("video/mp4", 16 * MB)).toEqual(
      expect.objectContaining({ category: "VIDEO", maxBytes: 16 * MB }),
    );
    expect(resolveMediaUploadPolicy("application/pdf", 100 * MB)).toEqual(
      expect.objectContaining({ category: "DOCUMENT", maxBytes: 100 * MB }),
    );
  });

  it("normalizes MIME type case and whitespace", () => {
    expect(resolveMediaUploadPolicy(" IMAGE/PNG ", 1024)).toEqual(
      expect.objectContaining({ category: "IMAGE", mimeType: "image/png" }),
    );
  });

  it("rejects unsupported MIME types", () => {
    expect(() => resolveMediaUploadPolicy("application/zip", 1024)).toThrow(
      "Unsupported WhatsApp media MIME type: application/zip",
    );
  });

  it("rejects empty files", () => {
    expect(() => resolveMediaUploadPolicy("image/jpeg", 0)).toThrow(MediaUploadPolicyError);
  });

  it("enforces the per-category size instead of only the global 100 MB limit", () => {
    expect(() => resolveMediaUploadPolicy("image/jpeg", 5 * MB + 1)).toThrow(
      "IMAGE upload exceeds the 5 MB platform limit",
    );
    expect(() => resolveMediaUploadPolicy("video/mp4", 16 * MB + 1)).toThrow(
      "VIDEO upload exceeds the 16 MB platform limit",
    );
  });
});
