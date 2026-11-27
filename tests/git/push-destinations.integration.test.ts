import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

import { expect, test } from "bun:test";

import { repositoryMutationHandoff } from "../../guard/handoff.ts";
import { checkout, current, external } from "../extension/test-support.ts";

test("when a remote has multiple fetch URLs and no push URLs, reports the known push repositories in order", () => {
  // Arrange: Git uses all configured URLs when there are no explicit push URLs.
  const repository = checkout();
  try {
    execFileSync("git", ["-C", repository, "remote", "set-url", "--add", "origin", `git@github.com:${current}.git`]);
    execFileSync("git", ["-C", repository, "remote", "set-url", "--add", "origin", `https://github.com/${external}.git`]);
    const event = { toolName: "bash", input: { command: "git push origin HEAD" } };

    // Act / Assert
    expect(repositoryMutationHandoff(event, repository)).toMatchObject({
      decision: "ask",
      category: "git",
      target: `${current}, ${external}`,
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a remote has both unknown and known push URLs, retains the known destination instead of the fetch URL", () => {
  // Arrange: only the second push URL resolves to GitHub; the fetch URL is not a push destination.
  const repository = checkout();
  try {
    execFileSync("git", ["-C", repository, "remote", "set-url", "--add", "--push", "origin", "ssh://git.example.test/project"]);
    execFileSync("git", ["-C", repository, "remote", "set-url", "--add", "--push", "origin", `https://github.com/${external}.git`]);
    const event = { toolName: "bash", input: { command: "git push origin HEAD" } };

    // Act / Assert
    expect(repositoryMutationHandoff(event, repository)).toMatchObject({
      decision: "ask",
      category: "git",
      target: external,
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a second push repository is added, changes the exact retry fingerprint", () => {
  // Arrange: keep the command and first push destination fixed across both decisions.
  const repository = checkout();
  const additionalRepository = "elsewhere/second";
  try {
    execFileSync("git", ["-C", repository, "remote", "set-url", "--add", "--push", "origin", `https://github.com/${external}.git`]);
    const event = { toolName: "bash", input: { command: "git push origin HEAD" } };

    // Act
    const original = repositoryMutationHandoff(event, repository);
    execFileSync("git", ["-C", repository, "remote", "set-url", "--add", "--push", "origin", `https://github.com/${additionalRepository}.git`]);
    const changed = repositoryMutationHandoff(event, repository);

    // Assert
    expect(original).toMatchObject({ decision: "ask", target: external });
    expect(changed).toMatchObject({ decision: "ask", target: `${external}, ${additionalRepository}` });
    if (original.decision === "ask" && changed.decision === "ask") {
      expect(changed.fingerprint).not.toBe(original.fingerprint);
    }
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
