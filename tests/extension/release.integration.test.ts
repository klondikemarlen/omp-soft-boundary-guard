import { execFileSync } from "node:child_process";
import { expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";

import {
  activateReviewedPolicy,
  createPolicyState,
  repositoryMutationHandoff,
  reviewPolicy,
} from "../../index.ts";
import { type ToolCallEvent } from "../../extension/contract.ts";
import { authorizeInternalRelease, releaseHandoff } from "../../guard/release-handoff.ts";
import { answerConfirmation, checkout, context, current, external, guard, requestedAsk } from "./test-support.ts";

const highRiskPolicy = activateReviewedPolicy(reviewPolicy(createPolicyState({
  name: "release",
  positive: "current owned checkout",
  negative: "other repositories",
}))).active!;
const highRiskClassification = {
  classification: "outside",
  risk: "high",
  reason: "production target",
} as const;

test("when releasing from the owned current checkout, allows the release", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();

    // Act
    const result = await instance.handler(
      { toolName: "bash", input: { command: "npm run release" } },
      context(repository),
    );

    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when releasing from the owned current checkout, sends no confirmation", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();

    // Act
    await instance.handler(
      { toolName: "bash", input: { command: "npm run release" } },
      context(repository),
    );

    // Assert
    expect(instance.messages).toEqual([]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when releasing from a different owner's checkout, requires approval", async () => {
  // Arrange
  const repository = checkout(`https://github.com/${external}.git`);
  try {
    const instance = guard();

    // Act
    const result = await instance.handler(
      { toolName: "bash", input: { command: "npm run release" } },
      context(repository),
    );

    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when releasing from an external checkout, displays its origin in the confirmation form", async () => {
  // Arrange
  const repository = checkout(`https://github.com/${external}.git`);
  const instance = guard();
  try {
    // Act
    await instance.handler({ toolName: "bash", input: { command: "npm run release" } }, context(repository));
    const { html } = requestedAsk(instance.messages.at(-1));

    // Assert
    expect(html.match(/^Repository: .+$/gm)).toEqual([`Repository: ${external}`]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when releasing across the boundary in advisory mode, allows the release", async () => {
  // Arrange
  const repository = checkout(`https://github.com/${external}.git`);
  try {
    const instance = guard({ enforce: false });

    // Act
    const result = await instance.handler(
      { toolName: "bash", input: { command: "npm run release" } },
      context(repository),
    );

    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when releasing across the boundary in advisory mode, sends no confirmation", async () => {
  // Arrange
  const repository = checkout(`https://github.com/${external}.git`);
  try {
    const instance = guard({ enforce: false });

    // Act
    await instance.handler(
      { toolName: "bash", input: { command: "npm run release" } },
      context(repository),
    );

    // Assert
    expect(instance.messages).toEqual([]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a release from an owned checkout names another repository, requires approval", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();

    // Act
    const result = await instance.handler(
      { toolName: "bash", input: { command: `npm run release -- --repo ${external}` } },
      context(repository),
    );

    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an explicit release target cannot be resolved, requires approval", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();

    // Act
    const result = await instance.handler(
      { toolName: "bash", input: { command: 'npm run release -- --repo "$TARGET"' } },
      context(repository),
    );

    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a nested release names another repository, requires approval", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();

    // Act
    const result = await instance.handler(
      { toolName: "bash", input: { command: `bash -c 'npm run release -- --repo ${external}'` } },
      context(repository),
    );

    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a release nested in Bash with flags names another repository, requires approval", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();

    // Act
    const result = await instance.handler(
      { toolName: "bash", input: { command: `bash -e -c 'npm run release -- --repo ${external}'` } },
      context(repository),
    );

    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when only the adjacent command has a repository flag, keeps the release local", () => {
  // Arrange
  const repository = checkout();
  try {
    // Act
    const handoff = repositoryMutationHandoff(
      { toolName: "bash", input: { command: `npm run release && gh issue view -R ${external}` } },
      repository,
    );

    // Assert
    expect(handoff).toMatchObject({ decision: "allow", action: "release/deploy", target: current });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an active policy is configured for a release to the owned checkout, skips classification", async () => {
  // Arrange
  const repository = checkout();
  try {
    const classifier = mock(async () => highRiskClassification);
    const instance = guard({
      policy: highRiskPolicy,
      classifier,
    });
    const event = { toolName: "bash", input: { command: `npm run release -- --repo ${current}` } };

    // Act
    await instance.handler(event, context(repository));

    // Assert
    expect(classifier).not.toHaveBeenCalled();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a release explicitly targets the owned checkout under an active policy, allows it", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard({
      policy: highRiskPolicy,
      classifier: async () => highRiskClassification,
    });
    const event = { toolName: "bash", input: { command: `npm run release -- --repo ${current}` } };

    // Act
    const result = await instance.handler(event, context(repository));

    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a release explicitly targets the owned checkout under an active policy, sends no confirmation", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard({
      policy: highRiskPolicy,
      classifier: async () => highRiskClassification,
    });
    const event = { toolName: "bash", input: { command: `npm run release -- --repo ${current}` } };

    // Act
    await instance.handler(event, context(repository));

    // Assert
    expect(instance.messages).toEqual([]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an external release is approved through the confirmation flow, allows exactly one retry", async () => {
  // Arrange
  const repository = checkout(`https://github.com/${external}.git`);
  try {
    const instance = guard();
    const event = { toolName: "bash", input: { command: "npm run release" } };
    await instance.handler(event, context(repository));
    answerConfirmation(instance, "Approve");

    // Act
    const approvedRetry = await instance.handler(event, context(repository));
    const subsequentRetry = await instance.handler(event, context(repository));

    // Assert
    expect([approvedRetry, subsequentRetry]).toEqual([
      undefined,
      expect.objectContaining({ block: true }),
    ]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an approved release changes, blocks the change and preserves approval for the original", async () => {
  // Arrange
  const repository = checkout(`https://github.com/${external}.git`);
  try {
    const instance = guard();
    const event = { toolName: "bash", input: { command: "npm run release" } };
    const changed = { toolName: "bash", input: { command: "npm run release -- --dry-run" } };
    await instance.handler(event, context(repository));
    answerConfirmation(instance, "Approve");

    // Act
    const changedResult = await instance.handler(changed, context(repository));
    const originalResult = await instance.handler(event, context(repository));

    // Assert
    expect([changedResult, originalResult]).toEqual([
      expect.objectContaining({ block: true }),
      undefined,
    ]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an approved release is retried in a different checkout, requires fresh approval", async () => {
  // Arrange
  const repository = checkout(`https://github.com/${external}.git`);
  const otherRepository = checkout("https://github.com/elsewhere/another.git");
  try {
    const instance = guard();
    const event = { toolName: "bash", input: { command: "npm run release" } };
    await instance.handler(event, context(repository));
    answerConfirmation(instance, "Approve");

    // Act
    const result = await instance.handler(event, context(otherRepository));

    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(otherRepository, { recursive: true, force: true });
  }
});

test("when an approved release's origin changes in the same checkout, requires fresh approval", async () => {
  // Arrange
  const repository = checkout(`https://github.com/${external}.git`);
  try {
    const instance = guard();
    const event = { toolName: "bash", input: { command: "npm run release" } };
    await instance.handler(event, context(repository));
    answerConfirmation(instance, "Approve");
    execFileSync("git", ["-C", repository, "remote", "set-url", "origin", "https://github.com/elsewhere/another.git"]);

    // Act
    const result = await instance.handler(event, context(repository));

    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a release has no resolved origin or approval UI, allows the release", async () => {
  // Arrange
  const repository = checkout(null);
  try {
    const instance = guard();

    // Act
    const result = await instance.handler(
      { toolName: "bash", input: { command: "npm run release" } },
      context(repository, false),
    );

    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a release command supplies its own internal-release flag, still requires approval", () => {
  // Arrange
  const repository = checkout(null);
  try {
    const event = { toolName: "bash", input: { command: "deploy production", internalRelease: true } };

    // Act
    const handoff = releaseHandoff(event, repository);

    // Assert
    expect(handoff).toMatchObject({ decision: "ask" });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a command changes after receiving the internal release capability, requires approval", () => {
  // Arrange
  const repository = checkout(null);
  try {
    const event: ToolCallEvent = { toolName: "bash", input: { command: "deploy production" } };
    authorizeInternalRelease(event);
    event.input.command = "publish production";

    // Act
    const handoff = releaseHandoff(event, repository);

    // Assert
    expect(handoff).toMatchObject({ decision: "ask" });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a release receives the internal capability, allows exactly one invocation", () => {
  // Arrange
  const repository = checkout(null);
  try {
    const event: ToolCallEvent = { toolName: "bash", input: { command: "deploy production" } };
    authorizeInternalRelease(event);

    // Act
    const authorizedHandoff = releaseHandoff(event, repository);
    const subsequentHandoff = releaseHandoff(event, repository);

    // Assert
    expect([authorizedHandoff, subsequentHandoff]).toEqual([
      { decision: "allow" },
      expect.objectContaining({ decision: "ask" }),
    ]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a release command accompanies an external push, still requires approval for the push", () => {
  // Arrange
  const repository = checkout();
  try {
    // Act
    const handoff = repositoryMutationHandoff(
      { toolName: "bash", input: { command: `npm run release && git push https://github.com/${external}.git HEAD` } },
      repository,
    );

    // Assert
    expect(handoff).toMatchObject({ decision: "ask", action: "git push", target: external });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
