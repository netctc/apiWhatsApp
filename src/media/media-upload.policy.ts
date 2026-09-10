export type MediaUploadCategory = "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT";

export interface MediaUploadPolicy {
  category: MediaUploadCategory;
  mimeType: string;
  maxBytes: number;
  providerFilename: string;
}

const MB = 1_000_000;

export const MAX_MEDIA_UPLOAD_BYTES = 100 * MB;

const POLICIES: Readonly<Record<string, MediaUploadPolicy>> = Object.freeze({
  "image/jpeg": {
    category: "IMAGE",
    mimeType: "image/jpeg",
    maxBytes: 5 * MB,
    providerFilename: "upload.jpg",
  },
  "image/png": {
    category: "IMAGE",
    mimeType: "image/png",
    maxBytes: 5 * MB,
    providerFilename: "upload.png",
  },
  "audio/aac": {
    category: "AUDIO",
    mimeType: "audio/aac",
    maxBytes: 16 * MB,
    providerFilename: "upload.aac",
  },
  "audio/mp4": {
    category: "AUDIO",
    mimeType: "audio/mp4",
    maxBytes: 16 * MB,
    providerFilename: "upload.m4a",
  },
  "audio/mpeg": {
    category: "AUDIO",
    mimeType: "audio/mpeg",
    maxBytes: 16 * MB,
    providerFilename: "upload.mp3",
  },
  "audio/amr": {
    category: "AUDIO",
    mimeType: "audio/amr",
    maxBytes: 16 * MB,
    providerFilename: "upload.amr",
  },
  "audio/ogg": {
    category: "AUDIO",
    mimeType: "audio/ogg",
    maxBytes: 16 * MB,
    providerFilename: "upload.ogg",
  },
  "video/mp4": {
    category: "VIDEO",
    mimeType: "video/mp4",
    maxBytes: 16 * MB,
    providerFilename: "upload.mp4",
  },
  "video/3gpp": {
    category: "VIDEO",
    mimeType: "video/3gpp",
    maxBytes: 16 * MB,
    providerFilename: "upload.3gp",
  },
  "text/plain": {
    category: "DOCUMENT",
    mimeType: "text/plain",
    maxBytes: 100 * MB,
    providerFilename: "upload.txt",
  },
  "application/pdf": {
    category: "DOCUMENT",
    mimeType: "application/pdf",
    maxBytes: 100 * MB,
    providerFilename: "upload.pdf",
  },
  "application/msword": {
    category: "DOCUMENT",
    mimeType: "application/msword",
    maxBytes: 100 * MB,
    providerFilename: "upload.doc",
  },
  "application/vnd.ms-excel": {
    category: "DOCUMENT",
    mimeType: "application/vnd.ms-excel",
    maxBytes: 100 * MB,
    providerFilename: "upload.xls",
  },
  "application/vnd.ms-powerpoint": {
    category: "DOCUMENT",
    mimeType: "application/vnd.ms-powerpoint",
    maxBytes: 100 * MB,
    providerFilename: "upload.ppt",
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    category: "DOCUMENT",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    maxBytes: 100 * MB,
    providerFilename: "upload.docx",
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    category: "DOCUMENT",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    maxBytes: 100 * MB,
    providerFilename: "upload.xlsx",
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    category: "DOCUMENT",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    maxBytes: 100 * MB,
    providerFilename: "upload.pptx",
  },
});

export class MediaUploadPolicyError extends Error {
  readonly reason: "EMPTY_FILE" | "UNSUPPORTED_MIME" | "FILE_TOO_LARGE";

  constructor(
    message: string,
    reason: "EMPTY_FILE" | "UNSUPPORTED_MIME" | "FILE_TOO_LARGE",
  ) {
    super(message);
    this.name = "MediaUploadPolicyError";
    this.reason = reason;
  }
}

export function resolveMediaUploadPolicy(mimeType: string, size: number): MediaUploadPolicy {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new MediaUploadPolicyError("Media upload file cannot be empty", "EMPTY_FILE");
  }

  const normalizedMimeType = mimeType.trim().toLowerCase();
  const policy = POLICIES[normalizedMimeType];
  if (!policy) {
    throw new MediaUploadPolicyError(
      `Unsupported WhatsApp media MIME type: ${normalizedMimeType || "unknown"}`,
      "UNSUPPORTED_MIME",
    );
  }

  if (size > policy.maxBytes) {
    throw new MediaUploadPolicyError(
      `${policy.category} upload exceeds the ${Math.floor(policy.maxBytes / MB)} MB platform limit`,
      "FILE_TOO_LARGE",
    );
  }

  return policy;
}
