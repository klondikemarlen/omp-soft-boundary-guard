import { rmSync } from "node:fs";

import { afterAll, expect, test } from "bun:test";

import { approve, checkout, context, installedGuard } from "./test-support.ts";

const repository = checkout();

afterAll(() => rmSync(repository, { recursive: true, force: true }));

test("when nested object keys are reordered, preserves the one-shot approval", async () => {
  // Arrange: use the shared checkout and prepare an approved invocation.
  const instance = installedGuard();
  const command = "gh api --method POST repos/elsewhere/example/issues -f title=synthetic";
  const original = { toolName: "bash", input: { command, ready: { host: "127.0.0.1", port: 3000 } } };
  // Act
  await instance.handler(original, context(repository));
  approve(instance, "GitHub API write", "elsewhere/example");

  const retry = { toolName: "bash", input: { command, ready: { port: 3000, host: "127.0.0.1" } } };
  // Act / Assert
  expect(await instance.handler(retry, context(repository))).toBeUndefined();
  expect(await instance.handler(retry, context(repository))).toMatchObject({ block: true });
});

test("when only the display title changes, preserves one-shot Python approval", async () => {
  // Arrange: use the shared checkout and prepare an approved invocation.
  const instance = installedGuard();
  const code = 'import subprocess\nsubprocess.run(["gh", "api", "--method", "POST", "repos/elsewhere/example/issues/1/comments", "-f", "body=synthetic"])';
  const original = { toolName: "eval", input: { language: "py", code, title: "Inspecting publication" } };
  // Act
  await instance.handler(original, context(repository));
  approve(instance, "GitHub API write", "elsewhere/example");

  const retry = { toolName: "eval", input: { language: "py", code, title: "Retrying approved publication" } };
  // Act / Assert
  expect(await instance.handler(retry, context(repository))).toBeUndefined();
  expect(await instance.handler(retry, context(repository))).toMatchObject({ block: true });
});

test("when Python code changes, does not treat it as presentation metadata", async () => {
  // Arrange: use the shared checkout and prepare an approved invocation.
  const instance = installedGuard();
  const original = {
    toolName: "eval",
    input: {
      language: "py",
      code: 'import subprocess\nsubprocess.run(["gh", "api", "--method", "POST", "repos/elsewhere/example/issues/1/comments", "-f", "body=original"])',
      title: "Inspecting publication",
    },
  };
  // Act
  await instance.handler(original, context(repository));
  approve(instance, "GitHub API write", "elsewhere/example");

  const changed = {
    toolName: "eval",
    input: {
      language: "py",
      code: 'import subprocess\nsubprocess.run(["gh", "api", "--method", "POST", "repos/elsewhere/example/issues/1/comments", "-f", "body=changed"])',
      title: "Retrying publication",
    },
  };
  // Act / Assert
  expect(await instance.handler(changed, context(repository))).toMatchObject({ block: true });
});

test("when a nested execution value changes, requires fresh approval", async () => {
  // Arrange: use the shared checkout and prepare an approved invocation.
  const instance = installedGuard();
  const command = "gh api --method POST repos/elsewhere/example/issues -f title=synthetic";
  const original = { toolName: "bash", input: { command, ready: { host: "127.0.0.1", port: 3000 } } };
  // Act
  await instance.handler(original, context(repository));
  approve(instance, "GitHub API write", "elsewhere/example");

  const changed = { toolName: "bash", input: { command, ready: { host: "127.0.0.1", port: 4000 } } };
  // Act / Assert
  expect(await instance.handler(changed, context(repository))).toMatchObject({ block: true });
});
