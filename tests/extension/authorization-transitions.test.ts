import { expect, test } from "bun:test";

import { AuthorizationState } from "../../extension/authorization-state.ts";
import { askHandoff, confirmationForm } from "../../guard/ask.ts";
import { confirmationQuestionId } from "../../guard/confirmation-question.ts";

const question = "Allow one git push to elsewhere/example?";

test("when a checkout observation omits origin, preserves an observed absence until the origin changes", () => {
  // Arrange
  const state = new AuthorizationState();
  state.resetFor("/checkout", null);
  state.begin("key", question);
  state.record({
    toolName: "ask",
    input: { html: confirmationForm(question, confirmationQuestionId) },
    details: { answers: [{ name: confirmationQuestionId, answer: "Approve" }] },
    isError: false,
  });

  // Act
  state.resetFor("/checkout");
  const liveAfterUnreportedOrigin = state.hasLiveState;
  state.resetFor("/checkout", "elsewhere/example");
  const retryAfterOriginChanged = state.consume("key");

  // Assert
  expect({ liveAfterUnreportedOrigin, retryAfterOriginChanged }).toEqual({
    liveAfterUnreportedOrigin: true,
    retryAfterOriginChanged: "missing",
  });
});

test("when a different retry is rejected, preserves the exact release approval", () => {
  // Arrange
  const state = new AuthorizationState();
  const releaseEvent = { toolName: "bash", input: { command: "npm run release" } };
  const release = askHandoff("release/deploy", "elsewhere/example", releaseEvent, "/checkout", "release");
  state.resetFor("/checkout");
  state.begin(release.fingerprint, release.question, undefined, release, release.questionId);
  state.record({
    toolName: "ask",
    input: release.ask,
    details: { answers: [{ name: release.questionId, answer: "Approve" }] },
    isError: false,
  });
  state.begin("other", question);
  state.record({
    toolName: "ask",
    input: { html: confirmationForm(question, confirmationQuestionId) },
    details: { answers: [{ name: confirmationQuestionId, answer: "Reject" }] },
    isError: false,
  });

  // Act
  const otherRetry = state.consume("other");
  const firstReleaseRetry = state.consume(release.fingerprint);
  const secondReleaseRetry = state.consume(release.fingerprint);

  // Assert
  expect({ otherRetry, firstReleaseRetry, secondReleaseRetry }).toEqual({
    otherRetry: "rejected",
    firstReleaseRetry: "authorized",
    secondReleaseRetry: "missing",
  });
});
