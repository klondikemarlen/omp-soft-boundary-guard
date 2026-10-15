import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { gitInvocation, gitInvocationRoot } from "../../git/invocation.ts";

test("when Git global options are unsupported or dynamic, leaves the invocation unresolved", () => {
  // Arrange: use the literal unsupported and dynamic invocations below.

  // Act / Assert
  expect(gitInvocation(["git", "--git-dir=/tmp/other.git", "switch", "-c", "audit-branch"])).toBeUndefined();
  expect(gitInvocation(["git", "-C", undefined, "switch", "-c", "audit-branch"])).toBeUndefined();
  expect(gitInvocation(["git", "-Cother", "switch", "-c", "audit-branch"])).toBeUndefined();
});

test("when -C resolves through a symlink parent, preserves Git path semantics", () => {
  // Arrange
  const directory = mkdtempSync(join(tmpdir(), "omp-soft-boundary-guard-git-invocation-"));
  const invokingDirectory = join(directory, "invoking");
  const targetRepository = join(directory, "target");
  const targetSubdirectory = join(targetRepository, "subdirectory");

  mkdirSync(invokingDirectory);
  mkdirSync(targetSubdirectory, { recursive: true });
  execFileSync("git", ["-C", targetRepository, "init", "--quiet"]);
  symlinkSync(targetSubdirectory, join(invokingDirectory, "link"));

  try {
    // Act / Assert
    expect(gitInvocationRoot(invokingDirectory, ["-C", "link/.."]))
      .toBe(targetRepository);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
