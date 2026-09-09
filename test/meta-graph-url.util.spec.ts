import { metaGraphUrl } from "../src/meta/meta-graph-url.util.js";

function config(value?: string) {
  return {
    get: (name: string) => (name === "META_GRAPH_API_BASE_URL" ? value : undefined),
  } as never;
}

describe("metaGraphUrl", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("uses the official HTTPS Graph host by default", () => {
    process.env.NODE_ENV = "production";
    expect(metaGraphUrl(config(), "v99.0/phone/messages").toString()).toBe(
      "https://graph.facebook.com/v99.0/phone/messages",
    );
  });

  it("allows an HTTP mock only under NODE_ENV=test", () => {
    process.env.NODE_ENV = "test";
    expect(metaGraphUrl(config("http://127.0.0.1:4567"), "v99.0/phone/messages").toString()).toBe(
      "http://127.0.0.1:4567/v99.0/phone/messages",
    );
  });

  it("rejects an HTTP override outside the test environment", () => {
    process.env.NODE_ENV = "production";
    expect(() => metaGraphUrl(config("http://127.0.0.1:4567"), "v99.0/phone/messages")).toThrow(
      "META_GRAPH_API_BASE_URL must use HTTPS outside NODE_ENV=test",
    );
  });

  it("rejects base URLs containing embedded credentials or query data", () => {
    process.env.NODE_ENV = "test";
    expect(() => metaGraphUrl(config("http://user:pass@127.0.0.1:4567"), "v99.0/x")).toThrow();
    expect(() => metaGraphUrl(config("http://127.0.0.1:4567?unsafe=true"), "v99.0/x")).toThrow();
  });
});
