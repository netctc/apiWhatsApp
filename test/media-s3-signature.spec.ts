import { createHash } from "node:crypto";
import { createS3SignedHeaders } from "../src/media/media-s3-signature.js";

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

describe("S3 Signature V4", () => {
  it("matches the published AWS S3 GET object signing vector", () => {
    const signed = createS3SignedHeaders({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      payloadHash: EMPTY_SHA256,
      date: new Date("2013-05-24T00:00:00.000Z"),
      headers: {
        range: "bytes=0-9",
      },
    });

    expect(signed.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request," +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date," +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(signed.headers).toEqual({
      host: "examplebucket.s3.amazonaws.com",
      range: "bytes=0-9",
      "x-amz-content-sha256": EMPTY_SHA256,
      "x-amz-date": "20130524T000000Z",
    });
  });

  it("signs an optional temporary security token", () => {
    const signed = createS3SignedHeaders({
      method: "HEAD",
      url: new URL("https://storage.example.com/media-bucket"),
      region: "eu-west-1",
      accessKeyId: "test-access",
      secretAccessKey: "test-secret",
      sessionToken: "temporary-session-token",
      payloadHash: EMPTY_SHA256,
      date: new Date("2026-09-10T12:00:00.000Z"),
    });

    expect(signed.headers["x-amz-security-token"]).toBe("temporary-session-token");
    expect(signed.authorization).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
    );
  });

  it("keeps signer-derived security headers authoritative over optional caller headers", () => {
    const signed = createS3SignedHeaders({
      method: "HEAD",
      url: new URL("https://storage.example.com/media-bucket"),
      region: "eu-west-1",
      accessKeyId: "test-access",
      secretAccessKey: "test-secret",
      sessionToken: "expected-session-token",
      payloadHash: EMPTY_SHA256,
      date: new Date("2026-09-10T12:00:00.000Z"),
      headers: {
        Host: "attacker.example.com",
        "x-amz-date": "19990101T000000Z",
        "x-amz-content-sha256": "bad-payload-hash",
        "x-amz-security-token": "bad-session-token",
      },
    });

    expect(signed.headers.host).toBe("storage.example.com");
    expect(signed.headers["x-amz-date"]).toBe("20260910T120000Z");
    expect(signed.headers["x-amz-content-sha256"]).toBe(EMPTY_SHA256);
    expect(signed.headers["x-amz-security-token"]).toBe("expected-session-token");
  });
});
