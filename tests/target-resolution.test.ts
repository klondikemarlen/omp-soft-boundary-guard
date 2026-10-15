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

test("asks for a GitHub write in the checkout selected by shell cd", () => {
  const sessionCheckout = checkout(currentRepository);
  const targetCheckout = checkout(externalRepository);

  try {
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

test("keeps tracking the mutation checkout after a read-only Git segment", () => {
  const sessionCheckout = checkout(currentRepository);
  const targetCheckout = checkout(externalRepository);

  try {
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

test("uses the tool execution checkout as a release target without changing its boundary", () => {
  const sessionCheckout = checkout(currentRepository);
  const toolCheckout = checkout(externalRepository);

  try {
    const handoff = releaseHandoff(
      { toolName: "bash", input: { cwd: toolCheckout, command: "npm run release" } },
      sessionCheckout,
    );

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

test("uses the shell cd checkout as a release target without changing its boundary", () => {
  const sessionCheckout = checkout(currentRepository);
  const targetCheckout = checkout(externalRepository);

  try {
    const handoff = releaseHandoff(
      {
        toolName: "bash",
        input: { cwd: sessionCheckout, command: `cd ${targetCheckout} && npm run release` },
      },
      sessionCheckout,
    );

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

test("keeps a release in the same owned checkout silently allowed", () => {
  const repository = checkout(currentRepository);

  try {
    const handoff = releaseHandoff(
      { toolName: "bash", input: { cwd: repository, command: "npm run release" } },
      repository,
    );

    expect(handoff).toMatchObject({ decision: "allow", currentRepository, target: currentRepository });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("does not treat quoted arguments to another command as a release target", () => {
  const repository = checkout(currentRepository);

  try {
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

    expect(handoff).toMatchObject({ decision: "allow", currentRepository, target: currentRepository });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("resolves the release checkout inside a supported nested shell", () => {
  const sessionCheckout = checkout(currentRepository);
  const targetCheckout = checkout(externalRepository);
  try {
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
