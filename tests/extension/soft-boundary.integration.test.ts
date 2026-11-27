import { expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";

import {
  activateReviewedPolicy,
  AdvisoryRecorder,
  createPolicyState,
  reviewPolicy,
} from "../../index.ts";
import { answerConfirmation, checkout, confirmationId, context, guard } from "./test-support.ts";

const policy = activateReviewedPolicy(reviewPolicy(createPolicyState({
  name: "work",
  positive: "active checkout and source",
  negative: "production and unrelated repositories",
}))).active!;

const command = "gh issue create --title change";
const event = { toolName: "bash", input: { command } };

const allowedClassifications = [
  { classification: "inside", risk: "low", reason: "active checkout", mode: "strict", enforce: true },
  { classification: "uncertain", risk: "low", reason: "ambiguous but low impact", mode: "strict", enforce: true },
  { classification: "outside", risk: "high", reason: "production target", mode: "advisory", enforce: false },
] as const;

test.each(allowedClassifications)(
  "when $mode mode classifies a write as $risk risk and $classification, lets it proceed",
  async ({ classification, risk, reason, enforce }) => {
    // Arrange
    const repository = checkout();
    const instance = guard({ enforce, policy, classifier: async () => ({ classification, risk, reason }) });
    try {
      // Act
      const decision = await instance.handler(event, context(repository));

      // Assert
      expect(decision).toBeUndefined();
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  },
);

test.each(allowedClassifications)(
  "when $mode mode classifies a write as $risk risk and $classification, does not request confirmation",
  async ({ classification, risk, reason, enforce }) => {
    // Arrange
    const repository = checkout();
    const instance = guard({ enforce, policy, classifier: async () => ({ classification, risk, reason }) });
    try {
      // Act
      await instance.handler(event, context(repository));

      // Assert
      expect(instance.messages).toEqual([]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  },
);

test.each(allowedClassifications)(
  "when $mode mode classifies a write as $risk risk and $classification, records the allowed outcome",
  async ({ classification, risk, reason, enforce }) => {
    // Arrange
    const repository = checkout();
    const recorder = new AdvisoryRecorder();
    const instance = guard({ enforce, policy, recorder, classifier: async () => ({ classification, risk, reason }) });
    try {
      // Act
      await instance.handler(event, context(repository));

      // Assert
      expect(recorder.evidence()).toMatchObject([{ classification, risk, outcome: "allowed" }]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  },
);

test("when a high-risk outside write is approved, allows the exact retry but blocks a changed write", async () => {
  // Arrange
  const repository = checkout();
  const instance = guard({
    policy,
    classifier: async () => ({ classification: "outside", risk: "high", reason: "production target" }),
  });
  const changedEvent = { toolName: "bash", input: { command: `${command} --body changed` } };
  try {
    // Act
    const beforeApproval = await instance.handler(event, context(repository));
    answerConfirmation(instance, "Approve");
    const exactRetry = await instance.handler(event, context(repository));
    const changedWrite = await instance.handler(changedEvent, context(repository));

    // Assert
    expect([beforeApproval, exactRetry, changedWrite]).toEqual([
      expect.objectContaining({ block: true }),
      undefined,
      expect.objectContaining({ block: true }),
    ]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a write is classified as uncertain and medium-risk, blocks execution", async () => {
  // Arrange
  const repository = checkout();
  const instance = guard({
    policy,
    classifier: async () => ({ classification: "uncertain", risk: "medium", reason: "target is unclear" }),
  });
  try {
    // Act
    const decision = await instance.handler(event, context(repository));

    // Assert
    expect(decision).toMatchObject({ block: true });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test.each([
  { classification: "outside", risk: "high", reason: "production target" },
  { classification: "uncertain", risk: "medium", reason: "target is unclear" },
] as const)(
  "when a write is classified as $risk risk and $classification, requests confirmation once",
  async ({ classification, risk, reason }) => {
    // Arrange
    const repository = checkout();
    const instance = guard({ policy, classifier: async () => ({ classification, risk, reason }) });
    try {
      // Act
      await instance.handler(event, context(repository));

      // Assert
      expect(instance.messages).toEqual([expect.stringContaining(confirmationId)]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  },
);

test("when the classifier cannot produce a result, lets the write proceed", async () => {
  // Arrange
  const repository = checkout();
  const instance = guard({ policy, classifier: async () => undefined });
  try {
    // Act
    const decision = await instance.handler(event, context(repository));

    // Assert
    expect(decision).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when the classifier cannot produce a result, does not request confirmation", async () => {
  // Arrange
  const repository = checkout();
  const instance = guard({ policy, classifier: async () => undefined });
  try {
    // Act
    await instance.handler(event, context(repository));

    // Assert
    expect(instance.messages).toEqual([]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an injected policy was not reviewed and activated, skips classification", async () => {
  // Arrange
  const repository = checkout();
  const classify = mock(async () => ({ classification: "outside", risk: "high", reason: "production target" }) as const);
  const instance = guard({
    policy: { ...policy, reviewed: true } as never,
    classifier: classify,
  });
  try {
    // Act
    await instance.handler(event, context(repository));

    // Assert
    expect(classify).not.toHaveBeenCalled();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an injected policy was not reviewed and activated, lets the write proceed", async () => {
  // Arrange
  const repository = checkout();
  const instance = guard({
    policy: { ...policy, reviewed: true } as never,
    classifier: async () => ({ classification: "outside", risk: "high", reason: "production target" }),
  });
  try {
    // Act
    const decision = await instance.handler(event, context(repository));

    // Assert
    expect(decision).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
