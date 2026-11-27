import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, expect, test } from "bun:test";

const releaseCheckScript = fileURLToPath(new URL("../../scripts/release-check.ts", import.meta.url));
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Release Check Test",
  GIT_AUTHOR_EMAIL: "release-check@example.com",
  GIT_COMMITTER_NAME: "Release Check Test",
  GIT_COMMITTER_EMAIL: "release-check@example.com",
  LC_ALL: "C",
};

let directory: string;

function git(...args: string[]): void {
  execFileSync("git", args, {
    cwd: directory,
    env: gitEnv,
  });
}

function writePackageVersion(version: string): void {
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version }));
}

function runReleaseCheck(env: NodeJS.ProcessEnv = gitEnv) {
  return spawnSync(process.execPath, [releaseCheckScript], {
    cwd: directory,
    env,
    encoding: "utf8",
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omp-release-check-"));
  git("init", "--quiet", "--initial-branch=main", "--template=");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

test("when a higher numeric release tag is on another branch, rejects a version above only the nearest tag", () => {
  // Arrange
  git("commit", "--quiet", "--allow-empty", "-m", "Common history");
  git("switch", "--quiet", "-c", "maintenance");
  git("commit", "--quiet", "--allow-empty", "-m", "Maintenance release");
  git("tag", "v1.10.0");
  git("switch", "--quiet", "main");
  git("commit", "--quiet", "--allow-empty", "-m", "Main release");
  git("tag", "v1.9.0");
  writePackageVersion("1.9.1");

  // Act
  const result = runReleaseCheck();

  // Assert
  expect(result).toMatchObject({
    status: 1,
    stderr: expect.stringContaining("package version 1.9.1 is older than v1.10.0"),
  });
});

test("when newer tags are unrelated, checks the candidate against the stable release tag", () => {
  // Arrange
  git("commit", "--quiet", "--allow-empty", "-m", "Stable release");
  git("tag", "--annotate", "1.2.3", "--message", "Release 1.2.3");
  git("commit", "--quiet", "--allow-empty", "-m", "Unrelated tags");
  git("tag", "checkpoint");
  git("tag", "v9.0.0-rc.1");
  git("tag", "v9.0.0+build.1");
  writePackageVersion("1.2.4");

  // Act
  const result = runReleaseCheck();

  // Assert
  expect(result).toMatchObject({
    status: 0,
    stdout: "release version 1.2.4 (after 1.2.3)\n",
  });
});

test("when the repository has no release tags, allows the first release", () => {
  // Arrange
  writePackageVersion("1.0.0");

  // Act
  const result = runReleaseCheck();

  // Assert
  expect(result).toMatchObject({
    status: 0,
    stdout: "release version 1.0.0\n",
  });
});

test("when Git cannot enumerate refs, fails instead of allowing a first release", () => {
  // Arrange
  writePackageVersion("1.0.0");

  // Act
  const result = runReleaseCheck({
    ...gitEnv,
    GIT_DIR: join(directory, "missing.git"),
  });

  // Assert
  expect(result).toMatchObject({
    status: 1,
    stderr: expect.stringContaining("not a git repository"),
  });
});

test("when the candidate has an older major version, rejects it despite newer minor and patch versions", () => {
  // Arrange
  git("commit", "--quiet", "--allow-empty", "-m", "Stable release");
  git("tag", "v2.0.0");
  writePackageVersion("1.99.99");

  // Act
  const result = runReleaseCheck();

  // Assert
  expect(result).toMatchObject({
    status: 1,
    stderr: expect.stringContaining("package version 1.99.99 is older than v2.0.0"),
  });
});

test("when the candidate equals the release tag, requires a version bump", () => {
  // Arrange
  git("commit", "--quiet", "--allow-empty", "-m", "Stable release");
  git("tag", "v1.2.3");
  writePackageVersion("1.2.3");

  // Act
  const result = runReleaseCheck();

  // Assert
  expect(result).toMatchObject({
    status: 1,
    stderr: expect.stringContaining("package version 1.2.3 is unchanged from v1.2.3; bump it before release"),
  });
});
