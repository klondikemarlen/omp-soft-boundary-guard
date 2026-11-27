import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

import { expect, test } from "bun:test";

import { answerConfirmation, checkout, context, current, external, guard } from "./test-support.ts";

test("when a nested-directory write stays in the approved checkout, permits only one exact retry", async () => {
  // Arrange
  const repository = checkout();
  const nestedDirectory = `${repository}/nested`;
  const externalIssue = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title Nested` } };
  const sameOriginIssue = { toolName: "bash", input: { command: `gh issue create --repo ${current} --title Allowed` } };
  const instance = guard();
  try {
    mkdirSync(nestedDirectory);
    await instance.handler(externalIssue, context(repository));
    answerConfirmation(instance, "Approve");

    // Act
    await instance.handler(sameOriginIssue, context(nestedDirectory));
    const firstRetry = await instance.handler(externalIssue, context(nestedDirectory));
    const secondRetry = await instance.handler(externalIssue, context(nestedDirectory));

    // Assert
    expect([firstRetry, secondRetry]).toEqual([
      undefined,
      expect.objectContaining({ block: true, reason: expect.stringContaining("OMP ask confirmation requested") }),
    ]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a different action in the same checkout omits origin metadata, keeps the first confirmation pending", async () => {
  // Arrange
  const repository = checkout();
  const otherRepository = checkout(`https://github.com/${external}.git`);
  const instance = guard();
  const externalIssue = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title Pending` } };
  const gitAdd = { toolName: "bash", input: { command: `git -C ${otherRepository} add README.md` } };
  try {
    await instance.handler(externalIssue, context(repository));

    // Act
    const result = await instance.handler(gitAdd, context(repository));

    // Assert
    expect(result).toMatchObject({ block: true, reason: expect.stringContaining("confirmation is already pending") });
  } finally {
    rmSync(otherRepository, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a release retry changes in the same checkout without an origin, retains the exact release approval", async () => {
  // Arrange
  const repository = checkout(null);
  const instance = guard();
  const release = { toolName: "bash", input: { command: `npm run release -- --repo ${external}` } };
  const changedRelease = { toolName: "bash", input: { command: "npm run release -- --repo elsewhere/another" } };
  try {
    await instance.handler(release, context(repository));
    answerConfirmation(instance, "Approve");

    // Act
    await instance.handler(changedRelease, context(repository));
    const exactRetry = await instance.handler(release, context(repository));

    // Assert
    expect(exactRetry).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test.each([
  { state: "pending", answer: undefined },
  { state: "approved", answer: "Approve" },
  { state: "rejected", answer: "Reject" },
] as const)("when an allowed write takes place in another checkout, clears $state confirmation state", async ({ answer }) => {
  // Arrange
  const repository = checkout();
  const otherCheckout = checkout();
  const instance = guard();
  const externalIssue = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title Scoped` } };
  const sameOriginIssue = { toolName: "bash", input: { command: `gh issue create --repo ${current} --title Allowed` } };
  try {
    await instance.handler(externalIssue, context(repository));
    if (answer) {
      answerConfirmation(instance, answer);
    }

    // Act
    await instance.handler(sameOriginIssue, context(otherCheckout));
    const result = await instance.handler(externalIssue, context(repository));

    // Assert
    expect(result).toMatchObject({ block: true, reason: expect.stringContaining("OMP ask confirmation requested") });
  } finally {
    rmSync(otherCheckout, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an observed origin changes without moving checkouts, revokes an explicitly targeted release approval", async () => {
  // Arrange
  const repository = checkout();
  const instance = guard();
  const release = { toolName: "bash", input: { command: `npm run release -- --repo ${external}` } };
  const differentOrigin = "elsewhere/another";
  const sameOriginIssue = { toolName: "bash", input: { command: `gh issue create --repo ${differentOrigin} --title Allowed` } };
  try {
    await instance.handler(release, context(repository));
    answerConfirmation(instance, "Approve");
    execFileSync("git", ["-C", repository, "remote", "set-url", "origin", `https://github.com/${differentOrigin}.git`]);

    // Act
    await instance.handler(sameOriginIssue, context(repository));
    execFileSync("git", ["-C", repository, "remote", "set-url", "origin", `https://github.com/${current}.git`]);
    const result = await instance.handler(release, context(repository));

    // Assert
    expect(result).toMatchObject({ block: true, reason: expect.stringContaining("OMP ask confirmation requested") });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an early external approval is followed by a checkout change, requires fresh approval", async () => {
  // Arrange
  const repository = checkout();
  const otherCheckout = checkout();
  const instance = guard();
  const command = `gh api --method PATCH repos/${external}/issues/6458 -f body="Fixture"`;
  const externalWrite = { toolName: "bash", input: { command } };
  const sameOriginIssue = { toolName: "bash", input: { command: `gh issue create --repo ${current} --title Allowed` } };
  const earlyAsk = {
    toolName: "ask",
    input: {
      questions: [{
        id: "confirm_external_github_write",
        question: `Allow one GitHub API write to ${external}?\nCommand: ${command}`,
      }],
    },
  };
  try {
    await instance.handler(earlyAsk, context(repository));
    instance.answer({ ...earlyAsk, details: { selectedOptions: ["Approve"] }, isError: false });

    // Act
    await instance.handler(sameOriginIssue, context(otherCheckout));
    const result = await instance.handler(externalWrite, context(repository));

    // Assert
    expect(result).toMatchObject({ block: true, reason: expect.stringContaining("OMP ask confirmation requested") });
  } finally {
    rmSync(otherCheckout, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test.each([
  { enforce: false, toolName: "read", input: { path: "README.md" } },
  { enforce: false, toolName: "bash", input: { command: "git status" } },
  { enforce: true, toolName: "read", input: { path: "README.md" } },
  { enforce: true, toolName: "bash", input: { command: "git status" } },
])("when an unrelated $toolName call has no live approval (enforce=$enforce), skips checkout probing", async ({ enforce, toolName, input }) => {
  // Arrange
  const repository = checkout();
  const executable = `${repository}/git`;
  const probe = `${repository}/checkout-probed`;
  const originalPath = process.env.PATH;
  try {
    writeFileSync(executable, `#!/bin/sh\n: > "${probe}"\n`);
    chmodSync(executable, 0o755);
    process.env.PATH = `${repository}:${originalPath}`;

    // Act
    await guard({ enforce }).handler({ toolName, input }, context(repository));

    // Assert
    expect(existsSync(probe)).toBeFalse();
  } finally {
    process.env.PATH = originalPath;
    rmSync(repository, { recursive: true, force: true });
  }
});
