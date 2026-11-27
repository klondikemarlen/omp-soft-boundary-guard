import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { expect, test } from "bun:test";

import { repositoryMutationHandoff } from "../../index.ts";
import { answerConfirmation, checkout, context, external, guard, requestedAsk } from "../extension/test-support.ts";

test("when pushing to the same origin, allows the push", async () => {
  // Arrange
  const repository = checkout();
  try {
    // Act
    const result = await guard().handler(
      { toolName: "bash", input: { command: "git push origin HEAD" } },
      context(repository),
    );
    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a named push remote needs no repository resolution, allows the push", () => {
  // Arrange
  const repository = checkout();
  try {
    // Act
    const result = repositoryMutationHandoff(
      { toolName: "bash", input: { command: `git push ${external} HEAD` } },
      repository,
    );
    // Assert
    expect(result).toMatchObject({ decision: "allow" });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a Git command is not a push, allows the command", async () => {
  // Arrange
  const repository = checkout();
  try {
    // Act
    const result = await guard().handler(
      { toolName: "bash", input: { command: "git status --short" } },
      context(repository),
    );
    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when pushing to an external repository, asks for approval", async () => {
  // Arrange
  const repository = checkout();
  try {
    // Act
    const result = await guard().handler(
      { toolName: "bash", input: { command: `git push https://github.com/${external}.git HEAD` } },
      context(repository),
    );
    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an external push is approved, allows the exact retry", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();
    const event = { toolName: "bash", input: { command: `git push https://github.com/${external}.git HEAD` } };
    await instance.handler(event, context(repository));
    answerConfirmation(instance, "Approve");

    // Act
    const result = await instance.handler(event, context(repository));
    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a default push remote is configured, asks about its destination", () => {
  // Arrange
  const repository = checkout();
  try {
    execFileSync("git", ["-C", repository, "remote", "add", "upstream", `https://github.com/${external}.git`]);
    execFileSync("git", ["-C", repository, "config", "remote.pushDefault", "upstream"]);
    // Act
    const result = repositoryMutationHandoff(
      { toolName: "bash", input: { command: "git push" } },
      repository,
    );
    // Assert
    expect(result).toMatchObject({ decision: "ask", target: external });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a command-local default push remote is set, resolves its destination", async () => {
  // Arrange
  const repository = checkout();
  try {
    execFileSync("git", ["-C", repository, "remote", "add", "upstream", `https://github.com/${external}.git`]);
    // Act
    const result = await guard().handler(
      { toolName: "bash", input: { command: "git -c remote.pushDefault=upstream push" } },
      context(repository),
    );
    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a command-local push URL override is set, resolves its destination", async () => {
  // Arrange
  const repository = checkout();
  try {
    // Act
    const result = await guard().handler(
      {
        toolName: "bash",
        input: {
          command: "git -c remote.origin.pushurl=https://github.com/elsewhere/example.git push origin HEAD",
        },
      },
      context(repository),
    );
    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an external push changes, requires new approval", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();
    const original = { toolName: "bash", input: { command: `git push https://github.com/${external}.git HEAD` } };
    const changed = { toolName: "bash", input: { command: `git push --force https://github.com/${external}.git HEAD` } };
    await instance.handler(original, context(repository));
    answerConfirmation(instance, "Approve");

    // Act
    const result = await instance.handler(changed, context(repository));
    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when Git repository options are unsupported, allows the push command", async () => {
  // Arrange
  const repository = checkout();
  try {
    // Act
    const result = await guard().handler(
      { toolName: "bash", input: { command: "git --git-dir=/tmp/other.git push origin HEAD" } },
      context(repository),
    );
    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when push text is quoted as an argument, ignores it", async () => {
  // Arrange
  const repository = checkout();
  try {
    // Act
    const result = await guard().handler(
      { toolName: "bash", input: { command: "echo 'git push https://github.com/elsewhere/example.git'" } },
      context(repository),
    );
    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a push uses dry-run mode, allows it", async () => {
  // Arrange
  const repository = checkout();
  try {
    // Act
    const result = await guard().handler(
      { toolName: "bash", input: { command: `git push --dry-run https://github.com/${external}.git HEAD` } },
      context(repository),
    );
    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a push requests help, allows the command", async () => {
  // Arrange
  const repository = checkout();
  try {
    // Act
    const result = await guard().handler(
      { toolName: "bash", input: { command: `git push --help --repo ${external}` } },
      context(repository),
    );
    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an approved push is retried twice, consumes approval once", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();
    const event = { toolName: "bash", input: { command: `git push https://github.com/${external}.git HEAD` } };
    await instance.handler(event, context(repository));
    answerConfirmation(instance, "Approve");

    // Act
    const approvedRetry = await instance.handler(event, context(repository));
    const subsequentRetry = await instance.handler(event, context(repository));

    // Assert
    expect([approvedRetry, subsequentRetry]).toEqual([
      undefined,
      expect.objectContaining({ block: true }),
    ]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when the default push destination changes, requires fresh approval for the same command", async () => {
  // Arrange
  const repository = checkout();
  const changed = "elsewhere/changed";
  try {
    execFileSync("git", ["-C", repository, "remote", "add", "deploy", `https://github.com/${external}.git`]);
    execFileSync("git", ["-C", repository, "config", "remote.pushDefault", "deploy"]);
    const instance = guard();
    const event = { toolName: "bash", input: { command: "git push" } };
    const session = context(repository);
    const originalRequest = await instance.handler(event, session);
    answerConfirmation(instance, "Approve");

    // Act
    execFileSync("git", ["-C", repository, "remote", "set-url", "deploy", `https://github.com/${changed}.git`]);
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

test("when the default push remote changes after approval, names the new target in the confirmation", async () => {
  // Arrange
  const repository = checkout();
  const changed = "elsewhere/changed";
  try {
    execFileSync("git", ["-C", repository, "remote", "add", "deploy", `https://github.com/${external}.git`]);
    execFileSync("git", ["-C", repository, "config", "remote.pushDefault", "deploy"]);
    const instance = guard();
    const event = { toolName: "bash", input: { command: "git push" } };
    await instance.handler(event, context(repository));
    answerConfirmation(instance, "Approve");
    execFileSync("git", ["-C", repository, "remote", "set-url", "deploy", `https://github.com/${changed}.git`]);

    // Act
    await instance.handler(event, context(repository));

    // Assert
    expect(instance.messages.at(-1)).toContain(changed);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a push moves to another session directory, requires approval", async () => {
  // Arrange
  const repository = checkout();
  const sibling = checkout();
  try {
    const instance = guard();
    const event = { toolName: "bash", input: { command: `git push https://github.com/${external}.git HEAD` } };
    await instance.handler(event, context(repository));
    answerConfirmation(instance, "Approve");

    // Act
    const result = await instance.handler(event, context(sibling));
    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(sibling, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an allowed call visits a sibling checkout, invalidates approval in the original checkout", async () => {
  // Arrange
  const repository = checkout();
  const sibling = checkout();
  try {
    const instance = guard();
    const event = { toolName: "bash", input: { command: `git push https://github.com/${external}.git HEAD` } };
    const session = context(repository);
    const initialRequest = await instance.handler(event, session);
    answerConfirmation(instance, "Approve");

    // Act
    const siblingStatus = await instance.handler(
      { toolName: "bash", input: { command: "git status --short" } },
      context(sibling),
    );
    const retry = await instance.handler(event, session);

    // Assert
    expect([initialRequest, siblingStatus, retry]).toEqual([
      expect.objectContaining({ block: true }),
      undefined,
      expect.objectContaining({ block: true }),
    ]);
  } finally {
    rmSync(sibling, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an external push's confirmation is interrupted, blocks the retry and requests confirmation again", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();
    const event = { toolName: "bash", input: { command: `git push https://github.com/${external}.git HEAD` } };
    await instance.handler(event, context(repository));
    instance.answer({
      toolName: "ask",
      input: requestedAsk(instance.messages.at(-1)),
      details: {},
      isError: true,
    });

    // Act
    const result = await instance.handler(event, context(repository));
    // Assert
    expect(result).toMatchObject({
      block: true,
      reason: expect.stringContaining("OMP ask confirmation requested."),
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a prior command switches checkouts, retains no checkout state", async () => {
  // Arrange
  const repository = checkout();
  const otherCheckout = checkout(`git@github.com:${external}.git`);
  try {
    const instance = guard();
    await instance.handler(
      { toolName: "bash", input: { command: `cd ${relative(repository, otherCheckout)} && git status --short` } },
      context(repository),
    );

    // Act
    const result = await instance.handler(
      { toolName: "bash", input: { command: `git push git@github.com:${external}.git HEAD` } },
      context(repository),
    );
    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(otherCheckout, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a push specifies a relative tool cwd, resolves origin in that checkout", () => {
  // Arrange: the same remote name points at different repositories in the two checkouts.
  const repository = checkout();
  const destinationCheckout = checkout(`https://github.com/${external}.git`);
  try {
    const command = "git push origin HEAD";
    const event = { toolName: "bash", input: { command } };
    const relativeCwdEvent = { ...event, input: { command, cwd: relative(repository, destinationCheckout) } };

    // Act
    const withCwd = repositoryMutationHandoff(relativeCwdEvent, repository);
    const withoutCwd = repositoryMutationHandoff(event, repository);
    // Assert
    expect([withCwd, withoutCwd]).toEqual([
      expect.objectContaining({
        decision: "ask",
        action: "git push",
        target: external,
      }),
      expect.objectContaining({ decision: "allow" }),
    ]);
  } finally {
    rmSync(destinationCheckout, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when Git -C quotes an external checkout, resolves its target", async () => {
  // Arrange
  const repository = checkout();
  const directory = mkdtempSync(join(tmpdir(), "omp-guard quoted checkout "));
  const targetCheckout = checkout(`https://github.com/${external}.git`, directory);
  try {
    // Act
    const result = await guard().handler(
      { toolName: "bash", input: { command: `git -c user.name=Guard --no-pager -C "${targetCheckout}" push origin HEAD` } },
      context(repository),
    );

    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
