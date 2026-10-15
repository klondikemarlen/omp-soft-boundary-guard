import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { expect, test } from "bun:test";

import { repositoryMutationHandoff } from "../../index.ts";
import { approve, checkout, context, external, guard } from "../extension/test-support.ts";

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

test("when an external push is approved, allows one retry", async () => {
  // Arrange
  const repository = checkout();
  try {

    const instance = guard();
    const event = { toolName: "bash", input: { command: `git push https://github.com/${external}.git HEAD` } };
    // Act
    await instance.handler(event, context(repository));
    approve(instance, "git push", external, `\nCommand: ${event.input.command}`);
    // Act
    const result = await instance.handler(event, context(repository));
    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a default push remote is configured, resolves its destination", async () => {
  // Arrange
  const repository = checkout();
  try {
    execFileSync("git", ["-C", repository, "remote", "add", "upstream", `https://github.com/${external}.git`]);
    execFileSync("git", ["-C", repository, "config", "remote.pushDefault", "upstream"]);
    // Act
    const result = await guard().handler(
      { toolName: "bash", input: { command: "git push" } },
      context(repository),
    );
    // Assert
    expect(result).toMatchObject({ block: true });
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
    // Act
    await instance.handler(original, context(repository));
    approve(instance, "git push", external, `\nCommand: ${original.input.command}`);
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
    // Act
    await instance.handler(event, context(repository));
    approve(instance, "git push", external, `\nCommand: ${event.input.command}`);
    // Act
    await instance.handler(event, context(repository));
    const result = await instance.handler(event, context(repository));
    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when the default push remote changes, requires fresh approval", async () => {
  // Arrange
  const repository = checkout();
  const changed = "elsewhere/changed";
  try {

    execFileSync("git", ["-C", repository, "remote", "add", "deploy", `https://github.com/${external}.git`]);
    execFileSync("git", ["-C", repository, "config", "remote.pushDefault", "deploy"]);
    const instance = guard();
    const event = { toolName: "bash", input: { command: "git push" } };
    // Act / Assert
    expect(await instance.handler(event, context(repository))).toMatchObject({ block: true });

    approve(instance, "git push", external, "\nCommand: git push");
    execFileSync("git", ["-C", repository, "remote", "set-url", "deploy", `https://github.com/${changed}.git`]);
    // Act / Assert
    expect(await instance.handler(event, context(repository))).toMatchObject({ block: true });
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
    // Act
    await instance.handler(event, context(repository));
    approve(instance, "git push", external, `\nCommand: ${event.input.command}`);
    // Act
    const result = await instance.handler(event, context(sibling));
    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(sibling, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an allowed call runs in a sibling checkout, retains no approval", async () => {
  // Arrange
  const repository = checkout();
  const sibling = checkout();
  try {

    const instance = guard();
    const event = { toolName: "bash", input: { command: `git push https://github.com/${external}.git HEAD` } };
    // Act
    await instance.handler(event, context(repository));
    approve(instance, "git push", external, `\nCommand: ${event.input.command}`);
    // Act / Assert

    expect(await instance.handler({ toolName: "bash", input: { command: "git status --short" } }, context(sibling))).toBeUndefined();
    // Act / Assert
    expect(await instance.handler(event, context(sibling))).toMatchObject({ block: true });

  } finally {
    rmSync(sibling, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when approval is interrupted, prompts again", async () => {
  // Arrange
  const repository = checkout();
  try {

    const instance = guard();
    const event = { toolName: "bash", input: { command: `git push https://github.com/${external}.git HEAD` } };
    // Act
    await instance.handler(event, context(repository));
    // Act
    instance.answer({ toolName: "ask", input: { questions: [] }, details: {}, isError: false });
    const result = await instance.handler(event, context(repository));
    // Assert
    expect(result).toMatchObject({ block: true });
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
    // Act
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

test("when tool directories are relative, resolves them from the session checkout", async () => {
  // Arrange
  const repository = checkout();
  try {

    mkdirSync(`${repository}/web`);
    mkdirSync(`${repository}/api`);
    const instance = guard();
    // Act
    await instance.handler(
      { toolName: "bash", input: { command: "git status --short", cwd: "web" } },
      context(repository),
    );
    await instance.handler(
      { toolName: "bash", input: { command: "git status --short", cwd: "api" } },
      context(repository),
    );
    // Act
    const result = await instance.handler(
      { toolName: "bash", input: { command: "git push origin HEAD" } },
      context(repository),
    );
    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when Git -C quotes an external checkout, resolves its target", async () => {
  // Arrange
  const repository = checkout();
  const directory = mkdtempSync(join(tmpdir(), "omp-guard quoted checkout "));
  const targetCheckout = checkout(`https://github.com/${external}.git`, directory);
  try {
    // Act / Assert
    expect(await guard().handler({
      toolName: "bash",
      input: { command: `git -c user.name=Guard --no-pager -C "${targetCheckout}" push origin HEAD` },
    }, context(repository))).toMatchObject({ block: true });
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
