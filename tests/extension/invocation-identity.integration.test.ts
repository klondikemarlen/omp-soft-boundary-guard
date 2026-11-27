import { rmSync } from "node:fs";

import { afterAll, expect, test } from "bun:test";

import { answerConfirmation, checkout, context, installedGuard } from "./test-support.ts";

const repository = checkout();

afterAll(() => rmSync(repository, { recursive: true, force: true }));

test("when nested object keys are reordered, preserves the one-shot approval", async () => {
  // Arrange
  const instance = installedGuard();
  const command = "gh api --method POST repos/elsewhere/example/issues -f title=synthetic";
  const original = { toolName: "bash", input: { command, ready: { host: "127.0.0.1", port: 3000 } } };
  const retry = { toolName: "bash", input: { command, ready: { port: 3000, host: "127.0.0.1" } } };
  await instance.handler(original, context(repository));
  answerConfirmation(instance, "Approve");

  // Act
  const approvedRetry = await instance.handler(retry, context(repository));
  const subsequentRetry = await instance.handler(retry, context(repository));

  // Assert
  expect([approvedRetry, subsequentRetry]).toEqual([
    undefined,
    expect.objectContaining({ block: true }),
  ]);
});

test("when only the display title changes, preserves one-shot Python approval", async () => {
  // Arrange
  const instance = installedGuard();
  const code = 'import subprocess\nsubprocess.run(["gh", "api", "--method", "POST", "repos/elsewhere/example/issues/1/comments", "-f", "body=synthetic"])';
  const original = { toolName: "eval", input: { language: "py", code, title: "Inspecting publication" } };
  const retry = { toolName: "eval", input: { language: "py", code, title: "Retrying approved publication" } };
  await instance.handler(original, context(repository));
  answerConfirmation(instance, "Approve");

  // Act
  const approvedRetry = await instance.handler(retry, context(repository));
  const subsequentRetry = await instance.handler(retry, context(repository));

  // Assert
  expect([approvedRetry, subsequentRetry]).toEqual([
    undefined,
    expect.objectContaining({ block: true }),
  ]);
});

test("when Python code changes without changing the display title, requires fresh approval", async () => {
  // Arrange
  const instance = installedGuard();
  const original = {
    toolName: "eval",
    input: {
      language: "py",
      code: 'import subprocess\nsubprocess.run(["gh", "api", "--method", "POST", "repos/elsewhere/example/issues/1/comments", "-f", "body=original"])',
      title: "Inspecting publication",
    },
  };
  const changed = {
    toolName: "eval",
    input: {
      language: "py",
      code: 'import subprocess\nsubprocess.run(["gh", "api", "--method", "POST", "repos/elsewhere/example/issues/1/comments", "-f", "body=changed"])',
      title: original.input.title,
    },
  };
  await instance.handler(original, context(repository));
  answerConfirmation(instance, "Approve");

  // Act
  const result = await instance.handler(changed, context(repository));

  // Assert
  expect(result).toMatchObject({ block: true });
});

test("when a nested execution value changes, requires fresh approval", async () => {
  // Arrange
  const instance = installedGuard();
  const command = "gh api --method POST repos/elsewhere/example/issues -f title=synthetic";
  const original = { toolName: "bash", input: { command, ready: { host: "127.0.0.1", port: 3000 } } };
  const changed = { toolName: "bash", input: { command, ready: { host: "127.0.0.1", port: 4000 } } };
  await instance.handler(original, context(repository));
  answerConfirmation(instance, "Approve");

  // Act
  const result = await instance.handler(changed, context(repository));

  // Assert
  expect(result).toMatchObject({ block: true });
});
