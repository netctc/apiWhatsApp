import {
  MediaUploadPolicyError,
  resolveMediaUploadPolicy,
} from "../src/media/media-upload.policy.js";

const MIB = 1024 * 1024;

describe("resolveMediaUploadPolicy", () => {
  it("accepts supported image, audio, video, and document MIME types", () => {
    expect(resolveMediaUploadPolicy("image/jpeg", 5 * MIB)).toEqual(
      expect.objectContaining({ category: "IMAGE", maxBytes: 5 * MIB }),
    );
    expect(resolveMediaUploadPolicy("audio/ogg", 16 * MIB)).toEqual(
      expect.objectContaining({ category: "AUDIO", maxBytes: 16 * MIB }),
    );
    expect(resolveMediaUploadPolicy("video/mp4", 16 * MIB)).toEqual(
      expect.objectContaining({ category: "VIDEO", maxBytes: 16 * MIB }),
    );
    expect(resolveMediaUploadPolicy("application/pdf", 100 * MIB)).toEqual(
      expect.objectContaining({ category: "DOCUMENT", maxBytes: 100 * MIB }),
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

  it("enforces the per-category size instead of only the global 100 MiB limit", () => {
    expect(() => resolveMediaUploadPolicy("image/jpeg", 5 * MIB + 1)).toThrow(
      "IMAGE upload exceeds the 5 MiB platform limit",
    );
    expect(() => resolveMediaUploadPolicy("video/mp4", 16 * MIB + 1)).toThrow(
      "VIDEO upload exceeds the 16 MiB platform limit",
    );
  });
});
