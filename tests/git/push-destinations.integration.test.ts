import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

import { expect, test } from "bun:test";

import { repositoryMutationHandoff } from "../../guard/handoff.ts";
import { answerConfirmation, checkout, context, current, external, guard } from "../extension/test-support.ts";

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

test("when a remote has multiple explicit push URLs, reports both push repositories in order", () => {
  // Arrange
  const repository = checkout();
  const additionalRepository = "elsewhere/second";
  try {
    execFileSync("git", ["-C", repository, "remote", "set-url", "--add", "--push", "origin", `https://github.com/${external}.git`]);
    execFileSync("git", ["-C", repository, "remote", "set-url", "--add", "--push", "origin", `https://github.com/${additionalRepository}.git`]);
    const event = { toolName: "bash", input: { command: "git push origin HEAD" } };

    // Act
    const result = repositoryMutationHandoff(event, repository);

    // Assert
    expect(result).toMatchObject({
      decision: "ask",
      category: "git",
      target: `${external}, ${additionalRepository}`,
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a push gains a second destination, requires fresh approval for the same command", async () => {
  // Arrange: approve the original push before extending its destination list.
  const repository = checkout();
  const additionalRepository = "elsewhere/second";
  try {
    execFileSync("git", ["-C", repository, "remote", "set-url", "--add", "--push", "origin", `https://github.com/${external}.git`]);
    const event = { toolName: "bash", input: { command: "git push origin HEAD" } };
    const instance = guard();
    const session = context(repository);
    const originalRequest = await instance.handler(event, session);
    answerConfirmation(instance, "Approve");

    // Act: retry the unchanged command, then approve the new request and retry again.
    execFileSync("git", ["-C", repository, "remote", "set-url", "--add", "--push", "origin", `https://github.com/${additionalRepository}.git`]);
    const changedRequest = await instance.handler(event, session);
    answerConfirmation(instance, "Approve");
    const approvedRetry = await instance.handler(event, session);

    // Assert
    expect([originalRequest, changedRequest, approvedRetry]).toEqual([
      expect.objectContaining({ block: true }),
      expect.objectContaining({ block: true }),
      undefined,
    ]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
