import { expect, test } from "bun:test";

import { authorizationKey, retryIdentity } from "../../guard/authorization-key.ts";

test("when distinct Unicode keys are reordered, canonical identity remains locale-independent", () => {
  // Arrange
  const original = { payload: { "\u00e9": "composed", "e\u0301": "decomposed" } };
  const reordered = { payload: { "e\u0301": "decomposed", "\u00e9": "composed" } };

  // Act / Assert
  expect(retryIdentity("eval", reordered, "/checkout"))
    .toBe(retryIdentity("eval", original, "/checkout"));
});

test("when nested domain fields are named title or i, canonical identity preserves them", () => {
  // Arrange
  const original = { title: "display", payload: { title: "original", i: "original" } };
  const changed = { title: "display", payload: { title: "changed", i: "changed" } };

  // Act / Assert
  expect(retryIdentity("eval", changed, "/checkout"))
    .not.toBe(retryIdentity("eval", original, "/checkout"));
});

test("when invocation arguments have different order, canonical identity preserves array order", () => {
  // Arrange: compare the two inline argument arrays.
  // Act / Assert
  expect(retryIdentity("eval", { arguments: ["first", "second"] }, "/checkout"))
    .not.toBe(retryIdentity("eval", { arguments: ["second", "first"] }, "/checkout"));
});

test("when the invoking tool changes, the authorization key changes", () => {
  // Arrange
  const input = { command: "synthetic invocation" };

  // Act / Assert
  expect(authorizationKey("bash", "GitHub API write", "elsewhere/example", input, "/checkout"))
    .not.toBe(authorizationKey("eval", "GitHub API write", "elsewhere/example", input, "/checkout"));
});
