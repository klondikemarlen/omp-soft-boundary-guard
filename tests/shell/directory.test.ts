import { expect, test } from "bun:test";

import { shellExecutionSegments, toolDirectory } from "../../shell/directory.ts";

test("when read-only commands precede a directory change, later commands use the changed directory", () => {
  // Arrange: pass an inline shell command and starting directory.

  // Act
  const segments = shellExecutionSegments(
    { cwd: "/workspace", command: "git status --short && cd /tmp/../var && gh issue create" },
    "/session",
  );

  // Assert
  expect(segments.map(({ cwd }) => cwd)).toEqual(["/workspace", "/workspace", "/var"]);
});

test("when a directory change is environment-prefixed, later commands use the changed directory", () => {
  // Arrange: pass the environment-prefixed command and starting directory inline.

  // Act
  const segments = shellExecutionSegments(
    { command: "GH_HOST=github.com cd /tmp/../var && gh issue create" },
    "/workspace",
  );

  // Assert
  expect(segments.map(({ cwd }) => cwd)).toEqual(["/workspace", "/var"]);
});

test("when a directory path contains quoted spaces, shell segments preserve the path", () => {
  // Arrange: pass the quoted directory command and starting directory inline.

  // Act
  const segments = shellExecutionSegments(
    { command: "cd '/tmp/external checkout' && gh issue create" },
    "/workspace",
  );

  // Assert
  expect(segments.map(({ cwd }) => cwd)).toEqual(["/workspace", "/tmp/external checkout"]);
});

test("when an explicit directory contains parent segments, the resolved directory is normalized", () => {
  // Arrange: pass the explicit directory and session fallback inline.

  // Act / Assert
  expect(toolDirectory({ cwd: "/tmp/../var" }, "/workspace")).toBe("/var");
});

test("when unsupported control flow leaves the working directory unresolved, later segments retain that uncertainty", () => {
  // Arrange: pass the command with unsupported control flow inline.

  // Act
  const segments = shellExecutionSegments(
    { command: "git status --short || cd /tmp/external && gh issue create" },
    "/workspace",
  );

  // Assert
  expect(segments.map(({ cwd }) => cwd)).toEqual(["/workspace", undefined, undefined]);
});

test("when a command changes directories, the change applies only to later commands", () => {
  // Arrange: pass the command and starting directory inline.

  // Act
  const segments = shellExecutionSegments(
    { command: "cd /tmp/external && gh issue create && cd /workspace" },
    "/session",
  );

  // Assert
  expect(segments.map(({ cwd }) => cwd)).toEqual(["/session", "/tmp/external", "/tmp/external"]);
});
