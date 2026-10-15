import { rmSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { activateReviewedPolicy, createPolicyState, reviewPolicy } from "../../index.ts";
import {
  approve,
  checkout,
  checkoutOutsideTemporaryDirectory,
  context,
  current,
  external,
  installedGuard,
  type Guard,
} from "./test-support.ts";

type AskPayload = { questions: [{ question: string }] };

function askPayload(instance: Guard): AskPayload {
  const message = instance.messages.at(-1);
  if (!message) {
    throw new Error("missing confirmation request");
  }

  const start = message.indexOf("{");
  const end = message.indexOf("}. If approved", start) + 1;
  return JSON.parse(message.slice(start, end)) as AskPayload;
}

function answer(instance: Guard, selection: string): void {
  instance.answer({
    toolName: "ask",
    input: askPayload(instance),
    details: { selectedOptions: [selection] },
    isError: false,
  });
}

const reviewedPolicy = activateReviewedPolicy(reviewPolicy(createPolicyState({
  name: "same-boundary",
  positive: "current checkout",
  negative: "external repository",
}))).active!;

describe("installed default GitHub enforcement", () => {
  test("when an external GitHub API write is requested, permits one exact retry", async () => {
    // Arrange
    const repository = checkout();
    const command = `gh api --method POST repos/${external}/issues -f title='External issue' -f body='Issue details'`;
    const event = { toolName: "bash", input: { command } };
    try {
      const instance = installedGuard();
      // Act / Assert
      expect(await instance.handler(event, context(repository))).toMatchObject({ block: true });
      expect(instance.messages).toHaveLength(1);
      expect(askPayload(instance).questions[0].question).toContain(`Target repository: ${external}`);
      expect(askPayload(instance).questions[0].question).toContain(`Command: ${command}`);

      approve(instance, "GitHub issue creation", external);
      // Act / Assert
      expect(await instance.handler(event, context(repository))).toBeUndefined();
      expect(await instance.handler(event, context(repository))).toMatchObject({ block: true });
      expect(instance.messages).toHaveLength(2);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("when a compound command targets an external release, requires GitHub approval", async () => {
    // Arrange
    const repository = checkout();
    const command = "npm run release -- --repo elsewhere/release && gh issue create --repo elsewhere/example --title audit --body audit";
    try {
      const instance = installedGuard();
      // Act / Assert
      expect(await instance.handler(
        { toolName: "bash", input: { command } },
        context(repository),
      )).toMatchObject({ block: true });
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("when a GitHub write payload changes, requests fresh confirmation", async () => {
    // Arrange
    const repository = checkout();
    const originalCommand = `gh api --method POST repos/${external}/issues -f title='Original issue' -f body='Original body'`;
    const changedCommand = `gh api --method POST repos/${external}/issues -f title='Original issue' -f body='Changed body'`;
    try {
      const instance = installedGuard();
      const original = { toolName: "bash", input: { command: originalCommand } };
      // Act / Assert
      expect(await instance.handler(original, context(repository))).toMatchObject({ block: true });
      approve(instance, "GitHub issue creation", external);

      const changed = { toolName: "bash", input: { command: changedCommand } };
      // Act / Assert
      expect(await instance.handler(changed, context(repository))).toMatchObject({
        block: true,
        reason: expect.stringContaining("OMP ask confirmation requested"),
      });
      expect(instance.messages).toHaveLength(2);
      expect(askPayload(instance).questions[0].question).toContain(`Command: ${changedCommand}`);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("when a GitHub destination changes, requests fresh confirmation", async () => {
    // Arrange
    const repository = checkout();
    const originalCommand = `gh api --method POST repos/${external}/issues -f title='Original issue' -f body='Issue details'`;
    const changedTarget = "elsewhere/another-example";
    const changedCommand = `gh api --method POST repos/${changedTarget}/issues -f title='Original issue' -f body='Issue details'`;
    try {
      const instance = installedGuard();
      const original = { toolName: "bash", input: { command: originalCommand } };
      // Act / Assert
      expect(await instance.handler(original, context(repository))).toMatchObject({ block: true });

      // Act
      approve(instance, "GitHub issue creation", external);

      const changed = { toolName: "bash", input: { command: changedCommand } };
      // Act / Assert
      expect(await instance.handler(changed, context(repository))).toMatchObject({
        block: true,
        reason: expect.stringContaining("OMP ask confirmation requested"),
      });
      expect(instance.messages).toHaveLength(2);
      expect(askPayload(instance).questions[0].question).toContain(`Target repository: ${changedTarget}`);
      expect(askPayload(instance).questions[0].question).toContain(`Command: ${changedCommand}`);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("when an external GitHub write is declined, keeps it blocked", async () => {
    // Arrange
    const repository = checkout();
    const event = {
      toolName: "bash",
      input: { command: `gh issue create --repo ${external} --title 'Declined issue'` },
    };
    try {
      const instance = installedGuard();
      // Act / Assert
      expect(await instance.handler(event, context(repository))).toMatchObject({ block: true });
      answer(instance, "Reject");
      // Act / Assert
      expect(await instance.handler(event, context(repository))).toMatchObject({
        block: true,
        reason: expect.stringContaining("previous confirmation was not approved"),
      });
      expect(instance.messages).toHaveLength(1);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("when an external xd GitHub publication is requested, asks first", async () => {
    // Arrange
    const repository = checkout();
    const event = {
      toolName: "write",
      input: {
        path: "xd://github",
        content: JSON.stringify({ op: "issue_create", repo: external, title: "External device issue" }),
      },
    };
    try {
      const instance = installedGuard();
      // Act / Assert
      expect(await instance.handler(event, context(repository))).toMatchObject({ block: true });
      expect(askPayload(instance).questions[0].question).toContain(`Target repository: ${external}`);
      expect(askPayload(instance).questions[0].question).toContain("Issue title: External device issue");

      approve(instance, "GitHub issue creation", external, "\nIssue title: External device issue");
      // Act / Assert
      expect(await instance.handler(event, context(repository))).toBeUndefined();
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("when a GitHub write targets the same boundary, stays silent", async () => {
    // Arrange
    const repository = checkout();
    try {
      const instance = installedGuard();
      // Act
      const result = await instance.handler(
        { toolName: "bash", input: { command: `gh issue create --repo ${current} --title 'Internal issue'` } },
        context(repository),
      );
      // Assert
      expect(result).toBeUndefined();
      expect(instance.messages).toEqual([]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("when policy classifies a same-boundary write as outside, keeps it advisory", async () => {
    // Arrange: use the reviewed policy fixture with a same-boundary write.
    const repository = checkout();
    try {
      const instance = installedGuard();
      // Act
      const result = await instance.handler(
        { toolName: "bash", input: { command: `gh issue create --repo ${current} --title 'Internal issue'` } },
        {
          ...context(repository),
          boundaryPolicy: reviewedPolicy,
          boundaryClassifier: async () => ({
            classification: "outside",
            risk: "high",
            reason: "policy classification is advisory for installed GitHub enforcement",
          }),
        },
      );
      // Assert
      expect(result).toBeUndefined();
      expect(instance.messages).toEqual([]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("when a boundary write is not a GitHub write, keeps it advisory", async () => {
    // Arrange
    const repository = checkout();
    const otherRepository = checkoutOutsideTemporaryDirectory(null);
    try {
      const instance = installedGuard();
      // Act
      const result = await instance.handler(
        { toolName: "write", input: { path: `${otherRepository}/outside.ts`, content: "" } },
        context(repository),
      );
      // Assert
      expect(result).toBeUndefined();
      expect(instance.messages).toEqual([]);
    } finally {
      rmSync(otherRepository, { recursive: true, force: true });
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("when UI is unavailable for an external write, fails open", async () => {
    // Arrange
    const repository = checkout();
    try {
      const instance = installedGuard();
      // Act
      const result = await instance.handler(
        { toolName: "bash", input: { command: `gh issue create --repo ${external} --title 'No UI issue'` } },
        context(repository, false),
      );
      // Assert
      expect(result).toBeUndefined();
      expect(instance.messages).toEqual([]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("when GitHub input is malformed, passes it through without prompting", async () => {
    // Arrange
    const repository = checkout();
    try {
      const instance = installedGuard();
      // Act
      const result = await instance.handler(
        { toolName: "write", input: { path: "xd://github", content: "{ malformed" } },
        context(repository),
      );
      // Assert
      expect(result).toBeUndefined();
      expect(instance.messages).toEqual([]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("when confirmation delivery throws, fails open and retries confirmation", async () => {
    // Arrange
    const repository = checkout();
    let deliveryUnavailable = true;
    try {
      const instance = installedGuard(() => {

        if (deliveryUnavailable) {
          throw new Error("confirmation delivery unavailable");
        }
      });
      const event = {
        toolName: "bash",
        input: { command: `gh issue create --repo ${external} --title 'Delivery error issue'` },
      };
      // Act / Assert
      expect(await instance.handler(event, context(repository))).toBeUndefined();

      deliveryUnavailable = false;
      // Act / Assert
      expect(await instance.handler(event, context(repository))).toMatchObject({ block: true });
      expect(instance.messages).toHaveLength(2);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
