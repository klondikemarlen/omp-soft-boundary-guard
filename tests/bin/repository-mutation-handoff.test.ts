import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, expect, test } from "bun:test";

const handoffScript = fileURLToPath(new URL("../../bin/repository-mutation-handoff.ts", import.meta.url));
const currentRepository = "fixture-owner/active-checkout";
const externalRepository = "elsewhere/example";

let fixtureDirectory: string;
let checkoutDirectory: string;

beforeEach(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "omp-handoff-"));
  checkoutDirectory = join(fixtureDirectory, "checkout");
  execFileSync("git", ["init", "--quiet", checkoutDirectory]);
  execFileSync("git", ["-C", checkoutDirectory, "remote", "add", "origin", `https://github.com/${currentRepository}.git`]);
});

afterEach(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

function runHandoff(
  command: string,
  { processCwd = fixtureDirectory, requestCwd }: { processCwd?: string; requestCwd?: string },
) {
  const request = {
    event: {
      toolName: "bash",
      input: {
        command,
      },
    },
    cwd: requestCwd,
  };
  const input = JSON.stringify(request);
  const stdout = execFileSync(process.execPath, [handoffScript], {
    cwd: processCwd,
    input,
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

test("when the request supplies a checkout cwd, allows a push to that checkout's origin", () => {
  // Arrange
  const command = "git push origin HEAD";

  // Act
  const decision = runHandoff(command, {
    requestCwd: checkoutDirectory,
  });

  // Assert
  expect(decision).toMatchObject({
    decision: "allow",
    action: "git push",
    currentRepository,
    target: currentRepository,
  });
});

test("when the request omits cwd, allows a push to the process checkout's origin", () => {
  // Arrange
  const command = "git push origin HEAD";

  // Act
  const decision = runHandoff(command, {
    processCwd: checkoutDirectory,
  });

  // Assert
  expect(decision).toMatchObject({
    decision: "allow",
    action: "git push",
    currentRepository,
    target: currentRepository,
  });
});

test("when a push targets an external repository, prints its approval form", () => {
  // Arrange
  const command = `git push https://github.com/${externalRepository}.git HEAD`;

  // Act
  const decision = runHandoff(command, {
    requestCwd: checkoutDirectory,
  });

  // Assert
  expect(decision).toMatchObject({
    decision: "ask",
    target: externalRepository,
    questionId: "confirm_repository_boundary_mutation",
    ask: {
      html: expect.any(String),
    },
  });
});

test("when an issue creation target is unresolved, fails open", () => {
  // Arrange
  const command = 'gh issue create --repo "$TARGET"';

  // Act
  const decision = runHandoff(command, {
    requestCwd: checkoutDirectory,
  });

  // Assert
  expect(decision).toEqual({
    decision: "allow",
    action: "GitHub issue creation",
    currentRepository,
  });
});

test("when a Git command only reads the worktree status, allows it", () => {
  // Arrange
  const command = "git status --short";

  // Act
  const decision = runHandoff(command, {
    requestCwd: checkoutDirectory,
  });

  // Assert
  expect(decision).toEqual({
    decision: "allow",
  });
});

test("when an issue comment reads quoted heredoc stdin containing Markdown, targets the current checkout", () => {
  // Arrange
  const command = [
    "gh issue comment 354 --body-file - <<'COMMENT'",
    "Run `/verifier` to check the result.",
    "COMMENT",
  ].join("\n");

  // Act
  const decision = runHandoff(command, {
    requestCwd: checkoutDirectory,
  });

  // Assert
  expect(decision).toMatchObject({
    decision: "allow",
    action: "GitHub issue update",
    currentRepository,
    target: currentRepository,
  });
});

test("when an issue comment is followed by a read-back, ignores the read-back's external repository option", () => {
  // Arrange
  const command = [
    "gh issue comment 354 --body-file - <<'COMMENT'",
    "Run `/verifier` to check the result.",
    "COMMENT",
    `gh issue view 354 --repo ${externalRepository} --json comments --jq '.comments[-1].body'`,
  ].join("\n");

  // Act
  const decision = runHandoff(command, {
    requestCwd: checkoutDirectory,
  });

  // Assert
  expect(decision).toMatchObject({
    decision: "allow",
    target: currentRepository,
  });
});

test("when an issue comment uses an external repository option with a quoted heredoc, asks for approval", () => {
  // Arrange
  const command = [
    `gh issue comment 354 --repo '${externalRepository}' --body-file=- <<"COMMENT"`,
    "Run `/verifier` to check the result.",
    "COMMENT",
  ].join("\n");

  // Act
  const decision = runHandoff(command, {
    requestCwd: checkoutDirectory,
  });

  // Assert
  expect(decision).toMatchObject({
    decision: "ask",
    action: "GitHub issue update",
    currentRepository,
    target: externalRepository,
    questionId: "confirm_repository_boundary_mutation",
  });
});

test("when an issue comment uses an external issue URL with a quoted heredoc, asks for approval", () => {
  // Arrange
  const command = [
    `gh issue comment https://github.com/${externalRepository}/issues/354 --body-file=- <<"COMMENT"`,
    "Run `/verifier` to check the result.",
    "COMMENT",
  ].join("\n");

  // Act
  const decision = runHandoff(command, {
    requestCwd: checkoutDirectory,
  });

  // Assert
  expect(decision).toMatchObject({
    decision: "ask",
    action: "GitHub issue update",
    currentRepository,
    target: externalRepository,
    questionId: "confirm_repository_boundary_mutation",
  });
});
