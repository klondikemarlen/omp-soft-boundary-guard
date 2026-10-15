import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { afterAll, expect, test } from "bun:test";

import { localMutation } from "../../guard/local-mutation.ts";
import { checkout, current, external } from "../extension/test-support.ts";

const invokingCheckout = checkout();
const externalCheckout = checkout(`https://github.com/${external}.git`);

afterAll(() => {
  rmSync(invokingCheckout, { recursive: true, force: true });
  rmSync(externalCheckout, { recursive: true, force: true });
});

test("when supported remote, config, stash, and worktree commands inspect state, allows them silently", () => {
  // Arrange: use the shared checkouts to prepare inspection commands.
  const commands = [
    `git -C "${externalCheckout}" remote -v`,
    `git -C "${externalCheckout}" remote show origin`,
    `git -C "${externalCheckout}" remote get-url origin`,
    `git -C "${externalCheckout}" config --get remote.origin.url`,
    `git -C "${externalCheckout}" config --get-all remote.origin.url`,
    `git -C "${externalCheckout}" config --get-regexp remote.origin`,
    `git -C "${externalCheckout}" config --list`,
    `git -C "${externalCheckout}" stash list`,
    `git -C "${externalCheckout}" stash show --stat`,
    `git -C "${externalCheckout}" worktree list --porcelain`,
  ];

  // Act / Assert
  for (const command of commands) {
    expect(localMutation({ toolName: "bash", input: { command } }, invokingCheckout)).toBeUndefined();
  }
});

test("when remote, config, stash, or worktree commands mutate outside the checkout, identifies the target", () => {
  // Arrange: use the shared checkouts to prepare mutations.
  const commands = [
    `git -C "${externalCheckout}" remote add upstream https://github.com/elsewhere/upstream.git`,
    `git -C "${externalCheckout}" config --add remote.upstream.url https://github.com/elsewhere/upstream.git`,
    `git -C "${externalCheckout}" config remote.origin.url constructor`,
    `git -c core.quotePath -C "${externalCheckout}" switch -c audit-branch`,
    `git -C "${externalCheckout}" branch constructor`,
    `git -C "${externalCheckout}" stash drop`,
    `git -C "${externalCheckout}" worktree add "${join(externalCheckout, "worktree")}"`,
  ];

  // Act / Assert
  for (const command of commands) {
    expect(localMutation({ toolName: "bash", input: { command } }, invokingCheckout)).toMatchObject({
      action: "git mutation",
      boundary: current,
      targets: [externalCheckout],
    });
  }
});

test("when stash show writes to an output file, treats it as a mutation", () => {
  // Arrange: target the shared external checkout with a stash output file.
  const command = `git -C "${externalCheckout}" stash show --output="${join(externalCheckout, "stash.patch")}"`;

  // Act / Assert
  expect(localMutation({ toolName: "bash", input: { command } }, invokingCheckout)).toMatchObject({
    action: "git mutation",
    boundary: current,
    targets: [externalCheckout],
  });
});

test("when Git -C uses a symlink parent, resolves the target with Git path semantics", () => {
  // Arrange: create a symlink from the shared invoking checkout to the external checkout.
  const link = join(invokingCheckout, "link");
  const targetSubdirectory = join(externalCheckout, "subdirectory");
  mkdirSync(targetSubdirectory);
  symlinkSync(targetSubdirectory, link);

  try {
    // Act
    const result = localMutation(
      { toolName: "bash", input: { command: "git -C link/.. switch -c audit-branch" } },
      invokingCheckout,
    );
    // Assert
    expect(result).toMatchObject({
      action: "git mutation",
      boundary: current,
      targets: [externalCheckout],
    });
  } finally {
    rmSync(link, { force: true });
  }
});

test("when a read-only Git segment precedes supported cd, tracks the changed cwd", () => {
  // Arrange: use the shared external checkout after a read-only Git segment.
  const command = `git status --short && cd "${externalCheckout}" && git switch -c audit-branch`;

  // Act / Assert
  expect(localMutation({ toolName: "bash", input: { command } }, invokingCheckout)).toMatchObject({
    action: "git mutation",
    boundary: current,
    targets: [externalCheckout],
  });
});

test("when a mutation follows unsupported control flow, leaves it unresolved", () => {
  // Arrange: use the shared external checkout after unsupported control flow.
  const command = `git status --short || git -C "${externalCheckout}" switch -c audit-branch`;

  // Act / Assert
  expect(localMutation({ toolName: "bash", input: { command } }, invokingCheckout)).toBeUndefined();
});

test("when --help is a path after the option separator, treats it as a checkout mutation", () => {
  // Arrange: use the shared external checkout as the checkout argument.
  const command = `git -C "${externalCheckout}" checkout -- --help`;

  // Act / Assert
  expect(localMutation({ toolName: "bash", input: { command } }, invokingCheckout)).toMatchObject({
    action: "git mutation",
    boundary: current,
    targets: [externalCheckout],
  });
});
