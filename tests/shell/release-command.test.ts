import { expect, test } from "bun:test";

import { releaseExecutionSegments } from "../../shell/release-command.ts";

const cwd = "/session-checkout";

test.each([
  "release main",
  "./bin/dev release main",
  "./scripts/deploy production",
  "npm publish",
  "npm run release",
  "pnpm run deploy",
  "npx release-tool promote",
  "bash -c 'gh release create v1.0.0'",
  "gh release upload v1.0.0 artifact.tgz",
])("when the command is %s, recognizes its release segment", (command) => {
  // Arrange
  const input = { command };

  // Act
  const releases = releaseExecutionSegments(input, cwd);

  // Assert
  expect(releases).toEqual([{ cwd, explicitRepository: undefined }]);
});

test.each([
  "bash -e -c 'npm run release -- --repo Owner/Repository'",
  "bash -c 'bash -c \"npm run release -- --repo Owner/Repository\"'",
])("when %s names a repository through supported shell nesting, resolves it", (command) => {
  // Arrange
  const input = { command };

  // Act
  const releases = releaseExecutionSegments(input, cwd);

  // Assert
  expect(releases).toEqual([{ cwd, explicitRepository: "owner/repository" }]);
});

test("when the nested shell checkout is unknown, still resolves its literal repository", () => {
  // Arrange
  const input = { command: "cd \"$CHECKOUT\" && bash -c 'release --repo Owner/Repository'" };

  // Act
  const releases = releaseExecutionSegments(input, cwd);

  // Assert
  expect(releases).toEqual([{ cwd: undefined, explicitRepository: "owner/repository" }]);
});

test("when a release target is malformed, distinguishes it from an implicit target", () => {
  // Arrange
  const input = { command: 'npm run release -- --repo "$TARGET"' };

  // Act
  const releases = releaseExecutionSegments(input, cwd);

  // Assert
  expect(releases).toEqual([{ cwd, explicitRepository: null }]);
});

test("when another command has release-like arguments, ignores its repository flag", () => {
  // Arrange
  const input = { command: "npm run release && echo 'x; deploy' --repo elsewhere/example" };

  // Act
  const releases = releaseExecutionSegments(input, cwd);

  // Assert
  expect(releases).toEqual([{ cwd, explicitRepository: undefined }]);
});

test.each([
  "bun run release:check",
  "git status --short",
  "gh release view v1.0.0",
  "npm run test",
  "constructor",
  "npm run toString",
  "make hasOwnProperty",
])("when the command is %s, recognizes no release segments", (command) => {
  // Arrange
  const input = { command };

  // Act
  const releases = releaseExecutionSegments(input, cwd);

  // Assert
  expect(releases).toEqual([]);
});
