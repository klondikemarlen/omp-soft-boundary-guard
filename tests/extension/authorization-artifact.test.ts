import { expect, test } from "bun:test";

import { AuthorizationState } from "../../extension/authorization-state.ts";
import { confirmationForm, type RepositoryMutationHandoff } from "../../guard/ask.ts";

const question = "Allow one git push to elsewhere/example?";
const questionId = "confirm_repository_boundary_mutation";
const handoff: Extract<RepositoryMutationHandoff, { decision: "ask" }> = {
  decision: "ask",
  action: "git push",
  category: "git",
  target: "elsewhere/example",
  fingerprint: "key",
  question,
  questionId,
  ask: { html: confirmationForm(question, questionId) },
};

test("when an exact retry is approved, retains its canonical artifact until consumption", () => {
  // Arrange
  const state = new AuthorizationState();
  state.resetFor("/checkout");
  // Act / Assert
  expect(state.begin("key", question, "same-input", handoff)).toBe(true);
  expect(state.artifact("same-input")).toBe(handoff);
  expect(state.artifact("changed-input")).toBeUndefined();

  state.record({
    toolName: "ask",
    input: handoff.ask,
    details: { answers: [{ name: questionId, answer: "Approve" }] },
    isError: false,
  });
  expect(state.artifact("same-input")).toBe(handoff);
  expect(state.consume("key")).toBe("authorized");
  expect(state.artifact("same-input")).toBeUndefined();
});
