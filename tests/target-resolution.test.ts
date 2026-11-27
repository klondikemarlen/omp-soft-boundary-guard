import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { repositoryMutationHandoff } from "../guard/handoff.ts";
import { releaseHandoff } from "../guard/release-handoff.ts";

const currentRepository = "klondikemarlen/omp-soft-boundary-guard";
const externalRepository = "elsewhere/example";

function checkout(repository: string): string {
  const directory = mkdtempSync(join(tmpdir(), "omp-target-resolution-"));
  execFileSync("git", ["-C", directory, "init", "--quiet"]);
  execFileSync("git", ["-C", directory, "remote", "add", "origin", `https://github.com/${repository}.git`]);
  return directory;
}

test("when shell cd selects another checkout for a GitHub write, asks for approval", () => {
  // Arrange
  const sessionCheckout = checkout(currentRepository);
  const targetCheckout = checkout(externalRepository);

  try {
    // Act
    const handoff = repositoryMutationHandoff(
      {
        toolName: "bash",
        input: {
          cwd: sessionCheckout,
          command: `cd ${targetCheckout} && gh issue create --title audit --body audit`,
        },
      },
      sessionCheckout,
    );

    // Assert
    expect(handoff).toMatchObject({
      decision: "ask",
      action: "GitHub issue creation",
      currentRepository,
      target: externalRepository,
    });
  } finally {
    rmSync(sessionCheckout, { recursive: true, force: true });
    rmSync(targetCheckout, { recursive: true, force: true });
  }
});

test("when a read-only Git segment precedes a mutation, tracks the mutation checkout", () => {
  // Arrange
  const sessionCheckout = checkout(currentRepository);
  const targetCheckout = checkout(externalRepository);

  try {
    // Act
    const handoff = repositoryMutationHandoff(
      {
        toolName: "bash",
        input: {
          cwd: sessionCheckout,
          command: `git status --short && cd ${targetCheckout} && gh issue create --title audit --body audit`,
        },
      },
      sessionCheckout,
    );
    // Assert

    expect(handoff).toMatchObject({
      decision: "ask",
      action: "GitHub issue creation",
      currentRepository,
      target: externalRepository,
    });
  } finally {
    rmSync(sessionCheckout, { recursive: true, force: true });
    rmSync(targetCheckout, { recursive: true, force: true });
  }
});

test("when the tool execution checkout is external, uses it as the release target", () => {
  // Arrange
  const sessionCheckout = checkout(currentRepository);
  const toolCheckout = checkout(externalRepository);

  try {
    // Act
    const handoff = releaseHandoff(
      { toolName: "bash", input: { cwd: toolCheckout, command: "npm run release" } },
      sessionCheckout,
    );

    // Assert
    expect(handoff).toMatchObject({
      decision: "ask",
      currentRepository,
      target: externalRepository,
    });
  } finally {
    rmSync(sessionCheckout, { recursive: true, force: true });
    rmSync(toolCheckout, { recursive: true, force: true });
  }
});

test("when shell cd selects an external checkout, uses it as the release target", () => {
  // Arrange
  const sessionCheckout = checkout(currentRepository);
  const targetCheckout = checkout(externalRepository);

  try {
    // Act
    const handoff = releaseHandoff(
      {
        toolName: "bash",
        input: { cwd: sessionCheckout, command: `cd ${targetCheckout} && npm run release` },
      },
      sessionCheckout,
    );

    // Assert
    expect(handoff).toMatchObject({
      decision: "ask",
      currentRepository,
      target: externalRepository,
    });
  } finally {
    rmSync(sessionCheckout, { recursive: true, force: true });
    rmSync(targetCheckout, { recursive: true, force: true });
  }
});

test("when a release targets the owned checkout, allows it silently", () => {
  // Arrange
  const repository = checkout(currentRepository);

  try {
    // Act
    const handoff = releaseHandoff(
      { toolName: "bash", input: { cwd: repository, command: "npm run release" } },
      repository,
    );

    // Assert
    expect(handoff).toMatchObject({ decision: "allow", currentRepository, target: currentRepository });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when release-like arguments belong to another command, ignores them as targets", () => {
  // Arrange
  const repository = checkout(currentRepository);

  try {
    // Act
    const handoff = releaseHandoff(
      {
        toolName: "bash",
        input: {
          cwd: repository,
          command: "npm run release && echo 'x; deploy' --repo elsewhere/example",
        },
      },
      repository,
    );

    // Assert
    expect(handoff).toMatchObject({ decision: "allow", currentRepository, target: currentRepository });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a nested shell changes checkout before release, resolves that target", () => {
  // Arrange
  const sessionCheckout = checkout(currentRepository);
  const targetCheckout = checkout(externalRepository);
  try {
    // Act / Assert
    expect(releaseHandoff({
      toolName: "bash",
      input: { command: `bash -c 'cd ${targetCheckout} && npm run release'` },
    }, sessionCheckout)).toMatchObject({
      decision: "ask",
      currentRepository,
      target: externalRepository,
    });
  } finally {
    rmSync(sessionCheckout, { recursive: true, force: true });
    rmSync(targetCheckout, { recursive: true, force: true });
  }
});

test("when a quoted issue comment is followed by a simple directory change and release, resolves the release checkout", () => {
  // Arrange
  const sessionCheckout = checkout(currentRepository);
  const targetCheckout = checkout(externalRepository);
  const command = [
    "gh issue comment 354 --body-file - <<'COMMENT'",
    "Synthetic comment.",
    "COMMENT",
    `cd ${targetCheckout} && npm run release`,
  ].join("\n");

  try {
    // Act
    const handoff = releaseHandoff({
      toolName: "bash",
      input: { command },
    }, sessionCheckout);

    // Assert
    expect(handoff).toMatchObject({
      decision: "ask",
      category: "release",
      target: externalRepository,
    });
  } finally {
    rmSync(sessionCheckout, { recursive: true, force: true });
    rmSync(targetCheckout, { recursive: true, force: true });
  }
});

test("when a directory change is inside a conditional after a quoted issue comment, does not assign its checkout to a release", () => {
  // Arrange
  const sessionCheckout = checkout(currentRepository);
  const targetCheckout = checkout(externalRepository);
  const command = [
    "gh issue comment 354 --body-file - <<'COMMENT'",
    "Synthetic comment.",
    "COMMENT",
    "git status --short; if false; then",
    `  cd ${targetCheckout}`,
    "fi",
    "npm run release",
  ].join("\n");

  try {
    // Act
    const handoff = releaseHandoff({
      toolName: "bash",
      input: { command },
    }, sessionCheckout);

    // Assert
    expect(handoff).toEqual({ decision: "allow" });
  } finally {
    rmSync(sessionCheckout, { recursive: true, force: true });
    rmSync(targetCheckout, { recursive: true, force: true });
  }
});

test("when a release still names an external repository after unsupported syntax, preserves the explicit destination", () => {
  // Arrange
  const repository = checkout(currentRepository);
  const command = [
    "gh issue comment 354 --body-file - <<'COMMENT'",
    "Synthetic comment.",
    "COMMENT",
    `(cd /tmp); npm run release -- --repo ${externalRepository}`,
  ].join("\n");

  try {
    // Act
    const handoff = releaseHandoff({
      toolName: "bash",
      input: {
        command,
      },
    }, repository);

    // Assert
    expect(handoff).toMatchObject({
      decision: "ask",
      category: "release",
      target: externalRepository,
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a conditional suffix contains a second GitHub write, keeps the combined destination unresolved", () => {
  // Arrange
  const repository = checkout(currentRepository);
  const command = [
    `gh issue comment 354 --repo ${externalRepository} --body-file - <<'COMMENT'`,
    "Synthetic comment.",
    "COMMENT",
    "if false; then",
    `  gh issue reopen 354 --repo ${externalRepository}`,
    "fi",
  ].join("\n");

  try {
    // Act
    const handoff = repositoryMutationHandoff({
      toolName: "bash",
      input: {
        command,
      },
    }, repository);

    // Assert
    expect(handoff).toMatchObject({
      decision: "allow",
      action: "GitHub write",
      target: undefined,
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an explicit owned release is followed by a nested release in another checkout, describes both destinations", () => {
  // Arrange
  const sessionCheckout = checkout(currentRepository);
  const targetCheckout = checkout(externalRepository);
  const command = `npm run release -- --repo ${currentRepository} && bash -c 'cd ${targetCheckout} && npm run release'`;

  try {
    // Act
    const handoff = releaseHandoff({ toolName: "bash", input: { command } }, sessionCheckout);

    // Assert
    expect(handoff).toMatchObject({
      decision: "ask",
      category: "release",
      target: `${currentRepository}, ${externalRepository}`,
      question: expect.stringContaining(
        `Release destinations in command order: ${currentRepository}; ${externalRepository}`,
      ),
    });
  } finally {
    rmSync(sessionCheckout, { recursive: true, force: true });
    rmSync(targetCheckout, { recursive: true, force: true });
  }
});

test("when releases name different repositories, describes each explicit destination", () => {
  // Arrange
  const repository = checkout(currentRepository);
  const command = `release --repo ${currentRepository} && deploy --repo ${externalRepository}`;

  try {
    // Act
    const handoff = releaseHandoff({ toolName: "bash", input: { command } }, repository);

    // Assert
    expect(handoff).toMatchObject({
      decision: "ask",
      target: `${currentRepository}, ${externalRepository}`,
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a known external release is paired with an unresolved checkout, keeps the outside classification", () => {
  // Arrange
  const repository = checkout(currentRepository);
  const command = `release --repo ${externalRepository} && cd "$CHECKOUT" && deploy`;

  try {
    // Act
    const handoff = releaseHandoff({ toolName: "bash", input: { command } }, repository);

    // Assert
    expect(handoff).toMatchObject({
      decision: "ask",
      target: `${externalRepository}, unresolved destination`,
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when no checkout can be resolved for a release segment, does not classify the command as inside", () => {
  // Arrange
  const repository = checkout(currentRepository);
  const command = `release --repo ${currentRepository} && cd "$CHECKOUT" && deploy`;

  try {
    // Act
    const handoff = releaseHandoff({ toolName: "bash", input: { command } }, repository);

    // Assert
    expect(handoff).toEqual({ decision: "allow" });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an explicit release destination is unresolved, identifies the checkout as context only", () => {
  // Arrange
  const repository = checkout(currentRepository);
  const command = 'release --repo "$TARGET"';

  try {
    // Act
    const handoff = releaseHandoff({ toolName: "bash", input: { command } }, repository);

    // Assert
    expect(handoff).toMatchObject({
      decision: "ask",
      target: `unresolved destination (execution checkout: ${currentRepository})`,
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
