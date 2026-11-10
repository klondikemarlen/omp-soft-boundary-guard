import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";

import { currentCheckoutRepository } from "../../index.ts";
import { approve, checkout, checkoutOutsideTemporaryDirectory, context, current, external, guard } from "../extension/test-support.ts";

test("when invoked below a checkout root, resolves the same origin", () => {
  // Arrange
  const repository = checkout();
  const nested = `${repository}/nested`;
  try {
    mkdirSync(nested);
    // Act / Assert
    expect([currentCheckoutRepository(repository), currentCheckoutRepository(nested)]).toEqual([current, current]);
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
    // Act / Assert
    expect(currentCheckoutRepository(`${nested}/src`)).toBe(current);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when nested Git metadata is invalid, permits edits below it", async () => {
  // Arrange
  const repository = checkout();
  const nested = `${repository}/api`;
  const target = `${nested}/src/inside.ts`;
  try {
    mkdirSync(`${nested}/src`, { recursive: true });
    writeFileSync(`${nested}/.git`, "");
    const instance = guard();
    // Act
    const result = await instance.handler(
      { toolName: "edit", input: { input: `[file ${target}#ABCD]\nSWAP 1.=1:\n+export {};` } },
      context(repository),
    );
    // Assert
    expect([result, instance.messages]).toEqual([undefined, []]);
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
    // Act / Assert
    expect(currentCheckoutRepository(worktree)).toBe(current);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when worktrees have no remote, permits mutations within their shared repository", async () => {
  // Arrange
  const repository = checkout(null);
  const worktree = `/tmp/omp-soft-boundary-guard-${crypto.randomUUID()}`;
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
    expect([result, instance.messages]).toEqual([undefined, []]);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
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
    // Act
    await instance.handler(event, context(repository));
    approve(instance, "file write", target);
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

test("when a local target cannot resolve, passes without asking", async () => {
  // Arrange
  const repository = checkout();
  const target = resolve(repository, "..", `unresolved-${crypto.randomUUID()}`, "created.ts");
  try {
    const instance = guard();
    // Act
    const result = await instance.handler(
      { toolName: "write", input: { path: target, content: "" } },
      context(repository),
    );
    // Assert
    expect([result, instance.messages]).toEqual([undefined, []]);
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
    const target = `${otherCheckout}/created.ts`;
    const event = { toolName: "write", input: { path: "outside/created.ts", content: "export {};\n" } };
    const instance = guard();
    // Act
    await instance.handler(event, context(repository));
    approve(instance, "file write", target);
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
  const sameRepositoryCheckout = checkout();
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

test("when a symlink target is dangling, passes without asking", async () => {
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
    expect([result, instance.messages]).toEqual([undefined, []]);
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
  const destination = `${otherCheckout}/moved.ts`;
  try {
    writeFileSync(`${repository}/inside.ts`, "export {};\n");
    const event = {
      toolName: "edit",
      input: { input: `*** Begin Patch\n[inside.ts#ABCD]\nMV ${relative(repository, otherCheckout)}/moved.ts\n*** End Patch\n` },
    };
    const instance = guard();
    // Act
    await instance.handler(event, context(repository));
    approve(instance, "file edit", destination);
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
    // Act
    await instance.handler(event, context(repository));
    approve(instance, "file edit", source);
    const result = await instance.handler(event, context(repository));
    // Assert
    expect(result).toBeUndefined();
  } finally {
    rmSync(otherCheckout, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});
