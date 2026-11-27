import { execFileSync } from "node:child_process";
import { expect, test } from "bun:test";

const current = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" })
  .trim()
  .replace(/^.*github\.com[/:]/i, "")
  .replace(/\.git$/, "")
  .toLowerCase();
const external = "elsewhere/example";

function handoff(command: string) {
  const result = Bun.spawnSync({
    cmd: ["bun", "bin/repository-mutation-handoff.ts"],
    stdin: new TextEncoder().encode(JSON.stringify({ event: { toolName: "bash", input: { command } } })),
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Handoff classifier exited with status ${result.exitCode}`);
  }
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

test("when a push targets origin, allows the current checkout's repository", () => {
  // Arrange
  const command = "git push origin HEAD";

  // Act
  const decision = handoff(command);

  // Assert
  expect(decision).toMatchObject({ decision: "allow", target: current });
});

test("when a push targets an external repository, prints its approval form", () => {
  // Arrange
  const command = `git push https://github.com/${external}.git HEAD`;

  // Act
  const decision = handoff(command);

  // Assert
  expect(decision).toMatchObject({
    decision: "ask",
    target: external,
    questionId: "confirm_repository_boundary_mutation",
    ask: { html: expect.any(String) },
  });
});

test("when an issue creation target is unresolved, fails open", () => {
  // Arrange
  const command = 'gh issue create --repo "$TARGET"';

  // Act
  const decision = handoff(command);

  // Assert
  expect(decision).toMatchObject({ decision: "allow" });
});

test("when a Git command only reads the worktree status, allows it", () => {
  // Arrange
  const command = "git status --short";

  // Act
  const decision = handoff(command);

  // Assert
  expect(decision).toMatchObject({ decision: "allow" });
});

test("when an issue comment reads quoted heredoc stdin containing Markdown, targets the current checkout", () => {
  // Arrange
  const command = [
    "gh issue comment 354 --body-file - <<'COMMENT'",
    "Run `/verifier` to check the result.",
    "COMMENT",
  ].join("\n");

  // Act
  const decision = handoff(command);

  // Assert
  expect(decision).toMatchObject({
    decision: "allow",
    action: "GitHub issue update",
    currentRepository: current,
    target: current,
  });
});

test("when an issue comment is followed by a read-back, ignores the read-back's external repository option", () => {
  // Arrange
  const command = [
    "gh issue comment 354 --body-file - <<'COMMENT'",
    "Run `/verifier` to check the result.",
    "COMMENT",
    `gh issue view 354 --repo ${external} --json comments --jq '.comments[-1].body'`,
  ].join("\n");

  // Act
  const decision = handoff(command);

  // Assert
  expect(decision).toMatchObject({ decision: "allow", target: current });
});

test.each([
  ["an explicit repository option", `354 --repo '${external}'`],
  ["an external issue URL", `https://github.com/${external}/issues/354`],
])("when %s targets an external issue, asks despite the quoted heredoc", (_targetForm, targetArgument) => {
  // Arrange
  const command = [
    `gh issue comment ${targetArgument} --body-file=- <<"COMMENT"`,
    "Run `/verifier` to check the result.",
    "COMMENT",
  ].join("\n");

  // Act
  const decision = handoff(command);

  // Assert
  expect(decision).toMatchObject({
    decision: "ask",
    action: "GitHub issue update",
    currentRepository: current,
    target: external,
    questionId: "confirm_repository_boundary_mutation",
  });
});
