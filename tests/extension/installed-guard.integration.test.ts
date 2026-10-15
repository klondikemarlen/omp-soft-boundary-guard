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
  test("asks for an external GitHub API write and permits one exact retry", async () => {
    const repository = checkout();
    const command = `gh api --method POST repos/${external}/issues -f title='External issue' -f body='Issue details'`;
    const event = { toolName: "bash", input: { command } };
    try {
      const instance = installedGuard();
      expect(await instance.handler(event, context(repository))).toMatchObject({ block: true });
      expect(instance.messages).toHaveLength(1);
      expect(askPayload(instance).questions[0].question).toContain(`Target repository: ${external}`);
      expect(askPayload(instance).questions[0].question).toContain(`Command: ${command}`);

      approve(instance, "GitHub issue creation", external);
      expect(await instance.handler(event, context(repository))).toBeUndefined();
      expect(await instance.handler(event, context(repository))).toMatchObject({ block: true });
      expect(instance.messages).toHaveLength(2);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("requires GitHub approval when a compound command also targets an external release", async () => {
    const repository = checkout();
    const command = "npm run release -- --repo elsewhere/release && gh issue create --repo elsewhere/example --title audit --body audit";
    try {
      const instance = installedGuard();
      expect(await instance.handler(
        { toolName: "bash", input: { command } },
        context(repository),
      )).toMatchObject({ block: true });
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("requests fresh confirmation for a changed GitHub write payload", async () => {
    const repository = checkout();
    const originalCommand = `gh api --method POST repos/${external}/issues -f title='Original issue' -f body='Original body'`;
    const changedCommand = `gh api --method POST repos/${external}/issues -f title='Original issue' -f body='Changed body'`;
    try {
      const instance = installedGuard();
      const original = { toolName: "bash", input: { command: originalCommand } };
      expect(await instance.handler(original, context(repository))).toMatchObject({ block: true });
      approve(instance, "GitHub issue creation", external);

      const changed = { toolName: "bash", input: { command: changedCommand } };
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

  test("requests fresh confirmation for a changed GitHub destination", async () => {
    const repository = checkout();
    const originalCommand = `gh api --method POST repos/${external}/issues -f title='Original issue' -f body='Issue details'`;
    const changedTarget = "elsewhere/another-example";
    const changedCommand = `gh api --method POST repos/${changedTarget}/issues -f title='Original issue' -f body='Issue details'`;
    try {
      const instance = installedGuard();
      const original = { toolName: "bash", input: { command: originalCommand } };
      expect(await instance.handler(original, context(repository))).toMatchObject({ block: true });
      approve(instance, "GitHub issue creation", external);

      const changed = { toolName: "bash", input: { command: changedCommand } };
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

  test("keeps a declined external GitHub write blocked", async () => {
    const repository = checkout();
    const event = {
      toolName: "bash",
      input: { command: `gh issue create --repo ${external} --title 'Declined issue'` },
    };
    try {
      const instance = installedGuard();
      expect(await instance.handler(event, context(repository))).toMatchObject({ block: true });
      answer(instance, "Reject");
      expect(await instance.handler(event, context(repository))).toMatchObject({
        block: true,
        reason: expect.stringContaining("previous confirmation was not approved"),
      });
      expect(instance.messages).toHaveLength(1);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("asks before an external xd GitHub publication", async () => {
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
      expect(await instance.handler(event, context(repository))).toMatchObject({ block: true });
      expect(askPayload(instance).questions[0].question).toContain(`Target repository: ${external}`);
      expect(askPayload(instance).questions[0].question).toContain("Issue title: External device issue");

      approve(instance, "GitHub issue creation", external, "\nIssue title: External device issue");
      expect(await instance.handler(event, context(repository))).toBeUndefined();
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("keeps same-boundary GitHub writes silent", async () => {
    const repository = checkout();
    try {
      const instance = installedGuard();
      const result = await instance.handler(
        { toolName: "bash", input: { command: `gh issue create --repo ${current} --title 'Internal issue'` } },
        context(repository),
      );
      expect(result).toBeUndefined();
      expect(instance.messages).toEqual([]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("keeps policy-classified same-boundary writes advisory", async () => {
    const repository = checkout();
    try {
      const instance = installedGuard();
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
      expect(result).toBeUndefined();
      expect(instance.messages).toEqual([]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("leaves non-GitHub boundary writes advisory", async () => {
    const repository = checkout();
    const otherRepository = checkoutOutsideTemporaryDirectory(null);
    try {
      const instance = installedGuard();
      const result = await instance.handler(
        { toolName: "write", input: { path: `${otherRepository}/outside.ts`, content: "" } },
        context(repository),
      );
      expect(result).toBeUndefined();
      expect(instance.messages).toEqual([]);
    } finally {
      rmSync(otherRepository, { recursive: true, force: true });
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("fails open for external writes without UI", async () => {
    const repository = checkout();
    try {
      const instance = installedGuard();
      const result = await instance.handler(
        { toolName: "bash", input: { command: `gh issue create --repo ${external} --title 'No UI issue'` } },
        context(repository, false),
      );
      expect(result).toBeUndefined();
      expect(instance.messages).toEqual([]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("passes malformed GitHub input through without prompting", async () => {
    const repository = checkout();
    try {
      const instance = installedGuard();
      const result = await instance.handler(
        { toolName: "write", input: { path: "xd://github", content: "{ malformed" } },
        context(repository),
      );
      expect(result).toBeUndefined();
      expect(instance.messages).toEqual([]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("fails open and retries confirmation after delivery throws", async () => {
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
      expect(await instance.handler(event, context(repository))).toBeUndefined();

      deliveryUnavailable = false;
      expect(await instance.handler(event, context(repository))).toMatchObject({ block: true });
      expect(instance.messages).toHaveLength(2);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
