import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { gitInvocation, gitInvocationRoot } from "../../git/invocation.ts";

test("leaves unsupported and dynamic Git global options unresolved", () => {
  expect(gitInvocation(["git", "--git-dir=/tmp/other.git", "switch", "-c", "audit-branch"])).toBeUndefined();
  expect(gitInvocation(["git", "-C", undefined, "switch", "-c", "audit-branch"])).toBeUndefined();
  expect(gitInvocation(["git", "-Cother", "switch", "-c", "audit-branch"])).toBeUndefined();
});

test("resolves Git -C symlink-parent semantics without lexical path normalization", () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-soft-boundary-guard-git-invocation-"));
  const invokingDirectory = join(directory, "invoking");
  const targetRepository = join(directory, "target");
  const targetSubdirectory = join(targetRepository, "subdirectory");

  mkdirSync(invokingDirectory);
  mkdirSync(targetSubdirectory, { recursive: true });
  execFileSync("git", ["-C", targetRepository, "init", "--quiet"]);
  symlinkSync(targetSubdirectory, join(invokingDirectory, "link"));

  try {
    expect(gitInvocationRoot(invokingDirectory, ["-C", "link/.."]))
      .toBe(targetRepository);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
