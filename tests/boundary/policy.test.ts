import { expect, test } from "bun:test";

import {
  activateReviewedPolicy,
  compileBoundaryPolicy,
  createPolicyState,
  loadReviewedPolicy,
  promoteReviewedRule,
  reviewPolicy,
  updatePolicySource,
} from "../../index.ts";

const source = {
  name: "Customer repository work",
  positive: "active checkout\nsource and tests",
  negative: "other repositories\nproduction targets",
};

test("when reviewed positive and negative descriptions are compiled, the active policy preserves their rules and behavior", () => {
  // Arrange: use the shared policy source fixture.

  // Act
  const state = activateReviewedPolicy(reviewPolicy(createPolicyState(source)));

  // Assert
  expect(state.active).toMatchObject({
    version: 1,
    name: source.name,
    positive: ["active checkout", "source and tests"],
    negative: ["other repositories", "production targets"],
    behavior: {
      mode: "ask-on-boundary-crossing",
      uncertain: "ask-or-allow-by-risk",
      failure: "allow-and-record",
    },
  });
});

test("when an environment policy matches its review fingerprint, it is activated and unreviewed variants are rejected", () => {
  // Arrange
  // Use the shared source fixture to derive the reviewed policy and fingerprint.
  const fingerprint = compileBoundaryPolicy(source).sourceFingerprint;
  const raw = JSON.stringify(source);

  // Act / Assert
  expect(loadReviewedPolicy({ OMP_SOFT_BOUNDARY_POLICY: raw, OMP_SOFT_BOUNDARY_POLICY_REVIEWED: fingerprint })).toMatchObject({
    sourceFingerprint: fingerprint,
  });
  expect(loadReviewedPolicy({ OMP_SOFT_BOUNDARY_POLICY: raw })).toBeUndefined();
  expect(loadReviewedPolicy({ OMP_SOFT_BOUNDARY_POLICY: raw, OMP_SOFT_BOUNDARY_POLICY_REVIEWED: "wrong" })).toBeUndefined();
  expect(loadReviewedPolicy({ OMP_SOFT_BOUNDARY_POLICY: "{bad", OMP_SOFT_BOUNDARY_POLICY_REVIEWED: fingerprint })).toBeUndefined();
  expect(loadReviewedPolicy({
    OMP_SOFT_BOUNDARY_POLICY: JSON.stringify({ ...source, negative: "edited" }),
    OMP_SOFT_BOUNDARY_POLICY_REVIEWED: fingerprint,
  })).toBeUndefined();
});

test("when an advisory rule is explicitly reviewed, promotion accepts it and rejects an unreviewed rule", () => {
  // Arrange: use the shared policy source fixture.
  const state = activateReviewedPolicy(reviewPolicy(createPolicyState(source)));

  // Act
  const promoted = promoteReviewedRule(state, { kind: "include", pattern: "workspace", source: "user-reviewed" }, true);

  // Assert
  expect(promoted.active?.rules).toEqual([{ kind: "include", pattern: "workspace", source: "user-reviewed" }]);
  expect(() => promoteReviewedRule(state, { kind: "exclude", pattern: "production", source: "user-reviewed" }, false)).toThrow("requires");
});

test("when a reviewed policy source is edited, its active compiled version is invalidated", () => {
  // Arrange: use the shared policy source fixture and activate its reviewed policy.
  const active = activateReviewedPolicy(reviewPolicy(createPolicyState(source)));

  // Act
  const edited = updatePolicySource(active, { ...source, negative: "production targets only" });

  // Assert
  expect(edited.active).toBeUndefined();
  expect(() => activateReviewedPolicy(edited)).toThrow("requires review");
});

test("when policy behavior requests an unsupported failure mode, compilation rejects the second policy language", () => {
  // Arrange: use the shared policy source fixture with an unsupported behavior.

  // Act / Assert
  expect(() => compileBoundaryPolicy({ ...source, behavior: { failure: "block" as never } })).toThrow("unsupported boundary behavior");
});

test("when supplementary Unicode text changes after review, an earlier review token is rejected", () => {
  // Arrange
  const reviewedSource = {
    name: "Reviewed Unicode policy",
    positive: "active checkout",
    negative: "outside target \u{1F600}",
  };
  const reviewedFingerprint = compileBoundaryPolicy(reviewedSource).sourceFingerprint;
  const editedSource = { ...reviewedSource, negative: "outside target \u{1F601}" };

  // Act / Assert
  expect(loadReviewedPolicy({
    OMP_SOFT_BOUNDARY_POLICY: JSON.stringify(editedSource),
    OMP_SOFT_BOUNDARY_POLICY_REVIEWED: reviewedFingerprint,
  })).toBeUndefined();
});

test("when a policy has only a legacy 32-bit review token, fresh review is required", () => {
  // Arrange
  const unicodeSource = {
    name: "Reviewed Unicode policy",
    positive: "active checkout",
    negative: "outside target \u{1F600}",
  };

  // Act / Assert
  expect(loadReviewedPolicy({
    OMP_SOFT_BOUNDARY_POLICY: JSON.stringify(unicodeSource),
    OMP_SOFT_BOUNDARY_POLICY_REVIEWED: "7793f2f2",
  })).toBeUndefined();
});
