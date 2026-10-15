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

test("keeps supported remote, config, stash and worktree inspections silent", () => {
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

  for (const command of commands) {
    expect(localMutation({ toolName: "bash", input: { command } }, invokingCheckout)).toBeUndefined();
  }
});

test("identifies mutating remote, config, stash and worktree commands outside the session checkout", () => {
  const commands = [
    `git -C "${externalCheckout}" remote add upstream https://github.com/elsewhere/upstream.git`,
    `git -C "${externalCheckout}" config --add remote.upstream.url https://github.com/elsewhere/upstream.git`,
    `git -C "${externalCheckout}" config remote.origin.url constructor`,
    `git -c core.quotePath -C "${externalCheckout}" switch -c audit-branch`,
    `git -C "${externalCheckout}" branch constructor`,
    `git -C "${externalCheckout}" stash drop`,
    `git -C "${externalCheckout}" worktree add "${join(externalCheckout, "worktree")}"`,
  ];

  for (const command of commands) {
    expect(localMutation({ toolName: "bash", input: { command } }, invokingCheckout)).toMatchObject({
      action: "git mutation",
      boundary: current,
      targets: [externalCheckout],
    });
  }
});

test("does not treat stash output-file options as read-only inspection", () => {
  const command = `git -C "${externalCheckout}" stash show --output="${join(externalCheckout, "stash.patch")}"`;
  expect(localMutation({ toolName: "bash", input: { command } }, invokingCheckout)).toMatchObject({
    action: "git mutation",
    boundary: current,
    targets: [externalCheckout],
  });
});

test("resolves a symlink-parent Git -C target with Git path semantics", () => {
  const link = join(invokingCheckout, "link");
  const targetSubdirectory = join(externalCheckout, "subdirectory");
  mkdirSync(targetSubdirectory);
  symlinkSync(targetSubdirectory, link);

  try {
    const result = localMutation(
      { toolName: "bash", input: { command: "git -C link/.. switch -c audit-branch" } },
      invokingCheckout,
    );
    expect(result).toMatchObject({
      action: "git mutation",
      boundary: current,
      targets: [externalCheckout],
    });
  } finally {
    rmSync(link, { force: true });
  }
});

test("continues tracking cwd after read-only Git and supported cd segments", () => {
  const command = `git status --short && cd "${externalCheckout}" && git switch -c audit-branch`;
  expect(localMutation({ toolName: "bash", input: { command } }, invokingCheckout)).toMatchObject({
    action: "git mutation",
    boundary: current,
    targets: [externalCheckout],
  });
});

test("leaves mutations after unsupported control flow unresolved", () => {
  const command = `git status --short || git -C "${externalCheckout}" switch -c audit-branch`;
  expect(localMutation({ toolName: "bash", input: { command } }, invokingCheckout)).toBeUndefined();
});

test("treats a help-looking path after the option separator as a checkout mutation", () => {
  const command = `git -C "${externalCheckout}" checkout -- --help`;

  expect(localMutation({ toolName: "bash", input: { command } }, invokingCheckout)).toMatchObject({
    action: "git mutation",
    boundary: current,
    targets: [externalCheckout],
  });
});
