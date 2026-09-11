import assert from "node:assert/strict";
import { describe, it } from "@jest/globals";
import { CannedResponseInputError, MAX_REVISION, prepareCannedResponseCreate, prepareCannedResponsePatch } from "../src/canned-responses/canned-response.policy.js";

const content = { shortcut: "order_status", title: "Order status", body: "We are checking your order." };

describe("canned response input policy", () => {
  it("normalizes at the boundary without evaluating plain-text expressions", () => {
    const input = { shortcut: " ORDER_Status ", title: " Order status ", body: " {{customer.name}}\n<script>text</script> " };
    assert.deepEqual(prepareCannedResponseCreate(input), { shortcut: "order_status", title: "Order status", body: "{{customer.name}}\n<script>text</script>" });
    assert.equal(input.shortcut, " ORDER_Status ");
  });

  it("accepts maximum lengths and Unicode scalar values", () => {
    const result = prepareCannedResponseCreate({ shortcut: "a".repeat(32), title: "x".repeat(100), body: "\u{1f600}".repeat(4096) });
    assert.equal(Array.from(result.body).length, 4096);
  });

  const invalidCreates: [string, unknown][] = [
    ["null object", null], ["array object", []], ["missing content", {}],
    ["foreign tenant", { ...content, tenantId: "foreign" }],
    ["caller revision", { ...content, revision: 2 }],
    ["caller active", { ...content, active: false }],
    ["null shortcut", { ...content, shortcut: null }],
    ["blank shortcut", { ...content, shortcut: " " }],
    ["numeric shortcut", { ...content, shortcut: 42 }],
    ["slash shortcut", { ...content, shortcut: "/hello" }],
    ["internal shortcut space", { ...content, shortcut: "hello world" }],
    ["oversized shortcut", { ...content, shortcut: "a".repeat(33) }],
    ["numeric prefix", { ...content, shortcut: "1hello" }],
    ["Unicode shortcut", { ...content, shortcut: "\u00e9" }],
    ["empty title", { ...content, title: "\n " }],
    ["null title", { ...content, title: null }],
    ["oversized title", { ...content, title: "x".repeat(101) }],
    ["empty body", { ...content, body: "\n\t" }],
    ["null body", { ...content, body: null }],
    ["oversized body", { ...content, body: "x".repeat(4097) }],
    ["NUL body", { ...content, body: "before\0after" }],
    ["unpaired high surrogate", { ...content, body: "\ud800" }],
    ["unpaired low surrogate", { ...content, body: "\udc00" }],
  ];
  for (const [name, value] of invalidCreates) it(`rejects ${name}`, () => {
    assert.throws(() => prepareCannedResponseCreate(value), CannedResponseInputError);
  });

  it("preserves false in a valid deactivation and ignores undefined optional properties", () => {
    assert.deepEqual(prepareCannedResponsePatch({ expectedRevision: 1, active: false, title: undefined }), { expectedRevision: 1, changes: { active: false } });
  });
  it("accepts the maximum updatable revision and normalizes content patches", () => {
    assert.deepEqual(prepareCannedResponsePatch({ expectedRevision: MAX_REVISION, shortcut: " NEW ", title: " New " }), { expectedRevision: MAX_REVISION, changes: { shortcut: "new", title: "New" } });
  });
  for (const revision of [undefined, null, 0, -1, 1.5, "1", true, NaN, Infinity, MAX_REVISION + 1]) {
    it(`rejects unsupported revision ${String(revision)}`, () => assert.throws(() => prepareCannedResponsePatch({ expectedRevision: revision, active: false }), CannedResponseInputError));
  }
  for (const [name, patch] of [
    ["no mutable fields", { expectedRevision: 1 }],
    ["null active", { expectedRevision: 1, active: null }],
    ["string active", { expectedRevision: 1, active: "false" }],
    ["null title", { expectedRevision: 1, title: null }],
    ["blank body", { expectedRevision: 1, body: " " }],
    ["unknown field", { expectedRevision: 1, title: "Good", tenantId: "foreign" }],
  ] as const) it(`rejects patch with ${name}`, () => assert.throws(() => prepareCannedResponsePatch(patch), CannedResponseInputError));
});
