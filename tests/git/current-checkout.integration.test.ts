import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";

import { currentCheckoutRepository } from "../../index.ts";
import { answerConfirmation, checkout, checkoutOutsideTemporaryDirectory, context, current, external, guard } from "../extension/test-support.ts";

test("when invoked below a checkout root, resolves the same origin", () => {
  // Arrange
  const repository = checkout();
  const nested = `${repository}/nested`;
  try {
    mkdirSync(nested);

    // Act
    const origins = [repository, nested].map(currentCheckoutRepository);

    // Assert
    expect(origins).toEqual([current, current]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when nested Git metadata is invalid, resolves the enclosing checkout", () => {
  // Arrange
  const repository = checkout();
  const nested = `${repository}/api`;
  try {
    mkdirSync(`${nested}/src`, { recursive: true });
    writeFileSync(`${nested}/.git`, "");

    // Act
    const origin = currentCheckoutRepository(`${nested}/src`);

    // Assert
    expect(origin).toBe(current);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when nested Git metadata is invalid, permits edits below it", async () => {
  // Arrange
  const repository = checkoutOutsideTemporaryDirectory();
  const nested = `${repository}/api`;
  const target = `${nested}/src/inside.ts`;
  try {
    mkdirSync(`${nested}/src`, { recursive: true });
    writeFileSync(`${nested}/.git`, "");
    writeFileSync(target, "export const original = true;\n");
    const instance = guard();
    // Act
    const result = await instance.handler(
      { toolName: "edit", input: { input: `*** Begin Patch\n[${target}#ABCD]\nPUT 1.=1:\n+export {};\n*** End Patch\n` } },
      context(repository),
    );
    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an edit stays below invalid nested Git metadata, sends no confirmation", async () => {
  // Arrange
  const repository = checkoutOutsideTemporaryDirectory();
  const nested = `${repository}/api`;
  const target = `${nested}/src/inside.ts`;
  try {
    mkdirSync(`${nested}/src`, { recursive: true });
    writeFileSync(`${nested}/.git`, "");
    writeFileSync(target, "export const original = true;\n");
    const instance = guard();

    // Act
    await instance.handler(
      { toolName: "edit", input: { input: `*** Begin Patch\n[${target}#ABCD]\nPUT 1.=1:\n+export {};\n*** End Patch\n` } },
      context(repository),
    );

    // Assert
    expect(instance.messages).toEqual([]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when invoked in a worktree, resolves its origin", () => {
  // Arrange
  const repository = checkout();
  const worktree = `/tmp/omp-soft-boundary-guard-${crypto.randomUUID()}`;
  try {
    execFileSync("git", ["-C", repository, "-c", "user.name=Guard", "-c", "user.email=guard@example.test", "commit", "--allow-empty", "-m", "initial"]);
    execFileSync("git", ["-C", repository, "worktree", "add", worktree, "-b", "feature"]);

    // Act
    const origin = currentCheckoutRepository(worktree);

    // Assert
    expect(origin).toBe(current);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when worktrees have no remote, permits mutations within their shared repository", async () => {
  // Arrange
  const repository = checkout(null);
  const worktree = resolve(`omp-soft-boundary-guard-${crypto.randomUUID()}`);
  const nested = `${repository}/nested`;
  try {
    execFileSync("git", ["-C", repository, "-c", "user.name=Guard", "-c", "user.email=guard@example.test", "commit", "--allow-empty", "-m", "initial"]);
    execFileSync("git", ["-C", repository, "worktree", "add", worktree, "-b", "feature"]);
    mkdirSync(nested);
    const instance = guard();
    // Act
    const result = await instance.handler(
      { toolName: "write", input: { path: `${worktree}/inside.ts`, content: "export {};\n" } },
      context(nested),
    );
    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a write targets a linked worktree without a remote, sends no confirmation", async () => {
  // Arrange
  const repository = checkout(null);
  const worktree = resolve(`omp-soft-boundary-guard-${crypto.randomUUID()}`);
  const nested = `${repository}/nested`;
  try {
    execFileSync("git", ["-C", repository, "-c", "user.name=Guard", "-c", "user.email=guard@example.test", "commit", "--allow-empty", "-m", "initial"]);
    execFileSync("git", ["-C", repository, "worktree", "add", worktree, "-b", "feature"]);
    mkdirSync(nested);
    const instance = guard();

    // Act
    await instance.handler(
      { toolName: "write", input: { path: `${worktree}/inside.ts`, content: "export {};\n" } },
      context(nested),
    );

    // Assert
    expect(instance.messages).toEqual([]);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a write targets an independent repository without an origin, requires approval", async () => {
  // Arrange
  const repository = checkout(null);
  const otherCheckout = checkoutOutsideTemporaryDirectory(null);
  try {
    const target = `${otherCheckout}/outside.ts`;
    // Act
    const result = await guard().handler(
      { toolName: "write", input: { path: target, content: "export {};\n" } },
      context(repository),
    );
    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(otherCheckout, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a write targets the active repository, permits it", async () => {
  // Arrange
  const repository = checkout();
  try {
    // Act
    const result = await guard().handler(
      { toolName: "write", input: { path: "inside.ts", content: "export {};\n" } },
      context(repository),
    );
    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a write targets a temporary checkout, permits it", async () => {
  // Arrange
  const repository = checkout();
  const temporaryCheckout = checkout(`git@github.com:${external}.git`, tmpdir());
  try {
    // Act
    const result = await guard().handler(
      { toolName: "write", input: { path: `${temporaryCheckout}/inside.ts`, content: "export {};\n" } },
      context(repository),
    );
    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(temporaryCheckout, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a temporary symlink escapes to another repository, requires approval", async () => {
  // Arrange
  const repository = checkout();
  const otherCheckout = checkoutOutsideTemporaryDirectory(`git@github.com:${external}.git`);
  const temporaryRoot = resolve(tmpdir(), `omp-soft-boundary-guard-${crypto.randomUUID()}`);
  try {
    mkdirSync(temporaryRoot);
    symlinkSync(otherCheckout, `${temporaryRoot}/outside`);
    // Act
    const result = await guard().handler(
      { toolName: "write", input: { path: `${temporaryRoot}/outside/created.ts`, content: "export {};\n" } },
      context(repository),
    );
    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
    rmSync(otherCheckout, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an external write is approved, permits its retry", async () => {
  // Arrange
  const repository = checkout();
  const otherCheckout = checkoutOutsideTemporaryDirectory(`git@github.com:${external}.git`);
  try {
    const instance = guard();
    const target = `${otherCheckout}/outside.ts`;
    const event = { toolName: "write", input: { path: target, content: "export {};\n" } };
    await instance.handler(event, context(repository));
    answerConfirmation(instance, "Approve");

    // Act
    const retry = await instance.handler(event, context(repository));
    // Assert
    expect(retry).toBeUndefined();
  } finally {
    rmSync(otherCheckout, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an external write resolves, requires approval", async () => {
  // Arrange
  const repository = checkout();
  const otherCheckout = checkoutOutsideTemporaryDirectory(`git@github.com:${external}.git`);
  try {
    const target = `${otherCheckout}/outside.ts`;
    // Act
    const result = await guard().handler(
      { toolName: "write", input: { path: target, content: "export {};\n" } },
      context(repository),
    );
    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(otherCheckout, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a symlink loop prevents resolving a write target, allows the write", async () => {
  // Arrange
  const repository = checkoutOutsideTemporaryDirectory();
  try {
    symlinkSync("loop", `${repository}/loop`);
    const instance = guard();
    // Act
    const result = await instance.handler(
      { toolName: "write", input: { path: "loop/created.ts", content: "" } },
      context(repository),
    );
    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a symlink loop prevents resolving a write target, sends no confirmation", async () => {
  // Arrange
  const repository = checkoutOutsideTemporaryDirectory();
  try {
    symlinkSync("loop", `${repository}/loop`);
    const instance = guard();

    // Act
    await instance.handler(
      { toolName: "write", input: { path: "loop/created.ts", content: "" } },
      context(repository),
    );

    // Assert
    expect(instance.messages).toEqual([]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an external symlink write is approved, permits its retry", async () => {
  // Arrange
  const repository = checkout();
  const otherCheckout = checkoutOutsideTemporaryDirectory(`git@github.com:${external}.git`);
  try {
    symlinkSync(otherCheckout, `${repository}/outside`);
    const event = { toolName: "write", input: { path: "outside/created.ts", content: "export {};\n" } };
    const instance = guard();
    await instance.handler(event, context(repository));
    answerConfirmation(instance, "Approve");

    // Act
    const retry = await instance.handler(event, context(repository));
    // Assert
    expect(retry).toBeUndefined();
  } finally {
    rmSync(otherCheckout, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a symlink write targets another repository, requires approval", async () => {
  // Arrange
  const repository = checkout();
  const otherCheckout = checkoutOutsideTemporaryDirectory(`git@github.com:${external}.git`);
  try {
    symlinkSync(otherCheckout, `${repository}/outside`);
    // Act
    const result = await guard().handler(
      { toolName: "write", input: { path: "outside/created.ts", content: "export {};\n" } },
      context(repository),
    );
    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(otherCheckout, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a move stays within one repository, permits it", async () => {
  // Arrange
  const repository = checkout();
  const sameRepositoryCheckout = checkoutOutsideTemporaryDirectory();
  try {
    writeFileSync(`${repository}/inside.ts`, "export {};\n");
    const destination = relative(repository, sameRepositoryCheckout);
    // Act
    const result = await guard().handler(
      {
        toolName: "edit",
        input: { input: `*** Begin Patch\n[inside.ts#ABCD]\nMV ${destination}/inside-moved.ts\n*** End Patch\n` },
      },
      context(repository),
    );
    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(sameRepositoryCheckout, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a symlink target is dangling, allows the write", async () => {
  // Arrange
  const repository = checkout();
  try {
    symlinkSync("../outside-missing", `${repository}/dangling-outside`);
    const instance = guard();
    // Act
    const result = await instance.handler(
      { toolName: "write", input: { path: "dangling-outside/created.ts", content: "" } },
      context(repository),
    );
    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a symlink target is dangling, sends no confirmation", async () => {
  // Arrange
  const repository = checkout();
  try {
    symlinkSync("../outside-missing", `${repository}/dangling-outside`);
    const instance = guard();

    // Act
    await instance.handler(
      { toolName: "write", input: { path: "dangling-outside/created.ts", content: "" } },
      context(repository),
    );

    // Assert
    expect(instance.messages).toEqual([]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a move targets another repository, requires approval", async () => {
  // Arrange
  const otherCheckout = checkoutOutsideTemporaryDirectory(`git@github.com:${external}.git`);
  const repository = checkout();
  try {
    writeFileSync(`${repository}/inside.ts`, "export {};\n");
    const event = {
      toolName: "edit",
      input: { input: `*** Begin Patch\n[inside.ts#ABCD]\nMV ${relative(repository, otherCheckout)}/moved.ts\n*** End Patch\n` },
    };
    // Act
    const result = await guard().handler(event, context(repository));
    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(otherCheckout, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an outbound move is approved, permits its retry", async () => {
  // Arrange
  const otherCheckout = checkoutOutsideTemporaryDirectory(`git@github.com:${external}.git`);
  const repository = checkout();
  try {
    writeFileSync(`${repository}/inside.ts`, "export {};\n");
    const event = {
      toolName: "edit",
      input: { input: `*** Begin Patch\n[inside.ts#ABCD]\nMV ${relative(repository, otherCheckout)}/moved.ts\n*** End Patch\n` },
    };
    const instance = guard();
    await instance.handler(event, context(repository));
    answerConfirmation(instance, "Approve");

    // Act
    const result = await instance.handler(event, context(repository));
    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(otherCheckout, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a move originates in another repository, requires approval", async () => {
  // Arrange
  const repository = checkout();
  const otherCheckout = checkoutOutsideTemporaryDirectory(`git@github.com:${external}.git`);
  const source = `${otherCheckout}/outside.ts`;
  try {
    writeFileSync(source, "export {};\n");
    const event = {
      toolName: "edit",
      input: { input: `*** Begin Patch\n[${relative(repository, otherCheckout)}/outside.ts#ABCD]\nMV moved.ts\n*** End Patch\n` },
    };
    // Act
    const result = await guard().handler(event, context(repository));
    // Assert
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(otherCheckout, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an inbound move is approved, permits its retry", async () => {
  // Arrange
  const repository = checkout();
  const otherCheckout = checkoutOutsideTemporaryDirectory(`git@github.com:${external}.git`);
  const source = `${otherCheckout}/outside.ts`;
  try {
    writeFileSync(source, "export {};\n");
    const event = {
      toolName: "edit",
      input: { input: `*** Begin Patch\n[${relative(repository, otherCheckout)}/outside.ts#ABCD]\nMV moved.ts\n*** End Patch\n` },
    };
    const instance = guard();
    await instance.handler(event, context(repository));
    answerConfirmation(instance, "Approve");

    // Act
    const result = await instance.handler(event, context(repository));
    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(otherCheckout, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});
