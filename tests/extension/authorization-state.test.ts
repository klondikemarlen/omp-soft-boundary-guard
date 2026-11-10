import { expect, test } from "bun:test";

import { AuthorizationState } from "../../extension/authorization-state.ts";
import { confirmationForm } from "../../guard/ask.ts";
import { nativeAskApproval } from "./native-ask-fixture.ts";
import { confirmationId } from "./test-support.ts";

const question = "Allow one git push to elsewhere/example?";

function approval() {
  return {
    ...nativeAskApproval,
    input: { html: confirmationForm(question, confirmationId) },
  };
}

test("when the native form is approved, authorizes exactly one retry", () => {
  // Arrange
  const state = new AuthorizationState();
  state.resetFor("/checkout");
  state.begin("key", question);
  // Act
  state.record(approval());
  // Assert
  expect(state.consume("key")).toBe("authorized");
  expect(state.consume("key")).toBe("missing");
});

test("when an approved retry changes, consumes and rejects the old approval", () => {
  // Arrange
  const state = new AuthorizationState();
  state.resetFor("/checkout");
  state.begin("key", question);
  state.record(approval());
  // Act / Assert
  expect(state.consume("different")).toBe("mismatched");
  expect(state.consume("key")).toBe("missing");
});

test("when another HTML form is approved, retains the pending confirmation", () => {
  // Arrange
  const state = new AuthorizationState();
  state.resetFor("/checkout");
  state.begin("key", question);
  // Act
  state.record(nativeAskApproval);
  // Assert
  expect(state.consume("key")).toBe("missing");
  expect(state.begin("next", question)).toBe(false);
});

test("when the checkout changes, clears pending authorization", () => {
  // Arrange
  const state = new AuthorizationState();
  state.resetFor("/checkout");
  state.begin("key", question);
  // Act
  state.resetFor("/other-checkout");
  // Assert
  expect(state.begin("next", question)).toBe(true);
});

test("when an external approval has no pending request, retains it for the first checkout", () => {
  // Arrange
  const state = new AuthorizationState();
  // Act
  state.record({
    toolName: "ask",
    input: {
      questions: [{ id: "confirm_external_github_write", question: "Allow one GitHub issue creation to elsewhere/example?" }],
    },
    details: { selectedOptions: ["Approve"] },
    isError: false,
  });
  state.resetFor("/checkout");
  // Assert
  expect(state.consumeExternal("Allow one GitHub issue creation to elsewhere/example?")).toBe(true);
  expect(state.consume("key")).toBe("missing");
});

test("when an external approval names a different command, preserves it for the matching command", () => {
  // Arrange
  const state = new AuthorizationState();
  const original = "Allow one GitHub API write to elsewhere/example?\nCommand: gh api repos/elsewhere/example/issues";
  const changed = "Allow one GitHub API write to elsewhere/example?\nCommand: gh api repos/elsewhere/example/pulls";
  // Act
  state.record({
    toolName: "ask",
    input: { questions: [{ id: "confirm_external_github_write", question: original }] },
    details: { selectedOptions: ["Approve"] },
    isError: false,
  });
  state.resetFor("/checkout");
  // Assert
  expect(state.consumeExternal(changed)).toBe(false);
  expect(state.consumeExternal(original)).toBe(true);
});

test("when the exact form is rejected, keeps its retry rejected", () => {
  // Arrange
  const state = new AuthorizationState();
  state.resetFor("/checkout");
  state.begin("key", question);
  // Act
  state.record({
    ...approval(),
    details: { answers: [{ name: confirmationId, answer: "Reject" }] },
  });
  // Assert
  expect(state.consume("key")).toBe("rejected");
  expect(state.consume("key")).toBe("rejected");
});

const unsupportedResults = [
  { name: "cancelled", details: undefined, isError: false },
  { name: "errored", details: nativeAskApproval.details, isError: true },
  { name: "timed out", details: { ...nativeAskApproval.details, timedOut: true }, isError: false },
  { name: "wrong field", details: { answers: [{ name: "other_question", answer: "Approve" }] }, isError: false },
  { name: "duplicate answers", details: { answers: [...nativeAskApproval.details.answers, ...nativeAskApproval.details.answers] }, isError: false },
  { name: "top-level data", details: { [confirmationId]: "Approve" }, isError: false },
  { name: "custom input", details: { customInput: "Approve" }, isError: false },
  { name: "unknown answer", details: { answers: [{ name: confirmationId, answer: "Maybe" }] }, isError: false },
];

for (const result of unsupportedResults) {
  test(`when the exact form result has ${result.name}, clears pending without authorization`, () => {
    // Arrange
    const state = new AuthorizationState();
    state.resetFor("/checkout");
    state.begin("key", question);
    // Act
    state.record({ ...approval(), details: result.details, isError: result.isError });
    // Assert
    expect(state.consume("key")).toBe("unsupported");
    expect(state.begin("next", question)).toBe(true);
  });
}

test("when only a different pending key is cancelled, preserves the matching pending and approval", () => {
  // Arrange
  const state = new AuthorizationState();
  state.resetFor("/checkout");
  state.begin("approved", question);
  state.record(approval());
  state.begin("pending", question);
  // Act
  state.cancelPending("other");
  // Assert
  expect(state.begin("another", question)).toBe(false);
  state.cancelPending("pending");
  expect(state.consume("approved")).toBe("authorized");
  expect(state.begin("next", question)).toBe(true);
});
