import { expect, test } from "bun:test";

import { authorizationKey, retryIdentity } from "../../guard/authorization-key.ts";

test("canonicalizes distinct Unicode keys without locale-dependent ordering", () => {
  const original = { payload: { "\u00e9": "composed", "e\u0301": "decomposed" } };
  const reordered = { payload: { "e\u0301": "decomposed", "\u00e9": "composed" } };

  expect(retryIdentity("eval", reordered, "/checkout"))
    .toBe(retryIdentity("eval", original, "/checkout"));
});

test("does not discard nested domain fields named title or i", () => {
  const original = { title: "display", payload: { title: "original", i: "original" } };
  const changed = { title: "display", payload: { title: "changed", i: "changed" } };

  expect(retryIdentity("eval", changed, "/checkout"))
    .not.toBe(retryIdentity("eval", original, "/checkout"));
});

test("preserves execution-significant array order", () => {
  expect(retryIdentity("eval", { arguments: ["first", "second"] }, "/checkout"))
    .not.toBe(retryIdentity("eval", { arguments: ["second", "first"] }, "/checkout"));
});

test("binds approval to the tool performing the invocation", () => {
  const input = { command: "synthetic invocation" };

  expect(authorizationKey("bash", "GitHub API write", "elsewhere/example", input, "/checkout"))
    .not.toBe(authorizationKey("eval", "GitHub API write", "elsewhere/example", input, "/checkout"));
});
