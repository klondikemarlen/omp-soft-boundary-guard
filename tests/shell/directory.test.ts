import { expect, test } from "bun:test";

import { shellExecutionSegments, toolDirectory } from "../../shell/directory.ts";

test("tracks a later directory change after read-only commands", () => {
  const segments = shellExecutionSegments(
    { cwd: "/workspace", command: "git status --short && cd /tmp/../var && gh issue create" },
    "/session",
  );

  expect(segments.map(({ cwd }) => cwd)).toEqual(["/workspace", "/workspace", "/var"]);
});

test("tracks an environment-prefixed directory change", () => {
  const segments = shellExecutionSegments(
    { command: "GH_HOST=github.com cd /tmp/../var && gh issue create" },
    "/workspace",
  );

  expect(segments.map(({ cwd }) => cwd)).toEqual(["/workspace", "/var"]);
});

test("accepts quoted directories with spaces", () => {
  const segments = shellExecutionSegments(
    { command: "cd '/tmp/external checkout' && gh issue create" },
    "/workspace",
  );

  expect(segments.map(({ cwd }) => cwd)).toEqual(["/workspace", "/tmp/external checkout"]);
});

test("normalizes explicit directories", () => {
  expect(toolDirectory({ cwd: "/tmp/../var" }, "/workspace")).toBe("/var");
});

test("propagates unresolved cwd after unsupported control flow", () => {
  const segments = shellExecutionSegments(
    { command: "git status --short || cd /tmp/external && gh issue create" },
    "/workspace",
  );

  expect(segments.map(({ cwd }) => cwd)).toEqual(["/workspace", undefined, undefined]);
});

test("applies cd to later commands rather than the cd command itself", () => {
  const segments = shellExecutionSegments(
    { command: "cd /tmp/external && gh issue create && cd /workspace" },
    "/session",
  );

  expect(segments.map(({ cwd }) => cwd)).toEqual(["/session", "/tmp/external", "/tmp/external"]);
});
