import { expect, test } from "bun:test";

import { releaseCommand, releaseTarget } from "../../shell/release-command.ts";

test("when direct release or deploy commands are supplied, each command is recognized", () => {
  // Arrange: exercise the inline direct release and deploy commands.

  // Act / Assert
  for (const command of ["release main", "./bin/dev release main", "./scripts/deploy production", "npm publish"]) {
    expect(releaseCommand(command)).toBe(command);
  }
});

test("when release commands use scripts, wrappers, or nested shells, each command is recognized", () => {
  // Arrange: exercise the inline script, wrapper, and nested-shell commands.

  // Act / Assert
  for (const command of [
    "npm run release",
    "pnpm run deploy",
    "npx release-tool promote",
    "bash -c 'gh release create v1.0.0'",
    "gh release upload v1.0.0 artifact.tgz",
  ]) {
    expect(releaseCommand(command)).toBe(command);
  }
});

test("when a nested release command names a repository, its target is resolved", () => {
  // Arrange: pass the nested release command inline.

  // Act / Assert
  expect(releaseTarget("bash -e -c 'npm run release -- --repo Owner/Repository'")).toEqual({
    repository: "owner/repository",
    unresolved: false,
  });
});

test("when release commands nest to the supported shell limit, the target is resolved", () => {
  // Arrange: pass a command nested to the supported shell limit inline.

  // Act / Assert
  expect(releaseTarget("bash -c 'bash -c \"npm run release -- --repo Owner/Repository\"'")).toEqual({
    repository: "owner/repository",
    unresolved: false,
  });
});

test("when a release target is malformed, it is marked unresolved", () => {
  // Arrange: pass a malformed target inline.

  // Act / Assert
  expect(releaseTarget('npm run release -- --repo "$TARGET"')).toEqual({ unresolved: true });
});

test("when another command contains a quoted release-like argument, no release target is inferred", () => {
  // Arrange: pass the mixed command inline.

  // Act / Assert
  expect(releaseTarget("npm run release && echo 'x; deploy' --repo elsewhere/example")).toEqual({
    unresolved: false,
  });
});

test("when commands are read-only checks, they are not classified as release tooling", () => {
  // Arrange: exercise inline read-only checks.

  // Act / Assert
  for (const command of ["bun run release:check", "git status --short", "gh release view v1.0.0", "npm run test"]) {
    expect(releaseCommand(command)).toBeUndefined();
  }
});

test("when release operations use object-prototype names, they are not supported", () => {
  // Arrange: exercise inline object-prototype names.

  // Act / Assert
  for (const command of ["constructor", "npm run toString", "make hasOwnProperty"]) {
    expect(releaseCommand(command)).toBeUndefined();
  }
});
