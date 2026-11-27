import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { implicitIssueRepository } from "../../github/implicit-issue-repository.ts";

const origin = "owner/fork";
const upstream = "elsewhere/project";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args]);
}

function withCheckout(assertDestination: (cwd: string, env: NodeJS.ProcessEnv) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "omp-issue-repository-"));
  try {
    git(cwd, "init", "--quiet");
    git(cwd, "remote", "add", "origin", `https://github.com/${origin}.git`);
    assertDestination(cwd, {});
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("when gh cannot prompt and only origin exists, resolves origin offline", () => {
  // Arrange
  withCheckout((cwd, env) => {
    // Act / Assert
    expect(implicitIssueRepository(cwd, { env, nonInteractive: true })).toBe(origin);
  });
});

test("when gh can prompt and no default is configured, does not assume origin has no fork parent", () => {
  // Arrange
  withCheckout((cwd, env) => {
    // Act / Assert
    expect(implicitIssueRepository(cwd, { env })).toBeUndefined();
  });
});

test("when the command disables gh prompts, resolves the offline default", () => {
  withCheckout((cwd, env) => {
    // Arrange
    const shellWords = ["GH_PROMPT_DISABLED=", "gh", "issue", "create"];

    // Act / Assert
    expect(implicitIssueRepository(cwd, { env, shellWords })).toBe(origin);
  });
});

test("when gh cannot prompt and no default is configured, prefers upstream to origin", () => {
  withCheckout((cwd, env) => {
    // Arrange
    git(cwd, "remote", "add", "upstream", `git@github.com:${upstream}.git`);

    // Act / Assert
    expect(implicitIssueRepository(cwd, { env, nonInteractive: true })).toBe(upstream);
  });
});

test("when gh's default is the upstream remote, resolves upstream instead of origin", () => {
  withCheckout((cwd, env) => {
    // Arrange
    git(cwd, "remote", "add", "upstream", `git@github.com:${upstream}.git`);
    git(cwd, "config", "remote.upstream.gh-resolved", "base");

    // Act / Assert
    expect(implicitIssueRepository(cwd, { env })).toBe(upstream);
  });
});

test("when gh's configured default has no named remote, resolves the repository directly", () => {
  withCheckout((cwd, env) => {
    // Arrange
    git(cwd, "config", "remote.origin.gh-resolved", upstream);

    // Act / Assert
    expect(implicitIssueRepository(cwd, { env })).toBe(upstream);
  });
});

test("when configured destinations conflict, does not fall back to origin", () => {
  withCheckout((cwd, env) => {
    // Arrange
    git(cwd, "remote", "add", "upstream", `https://github.com/${upstream}.git`);
    git(cwd, "config", "remote.origin.gh-resolved", "base");
    git(cwd, "config", "remote.upstream.gh-resolved", "base");

    // Act / Assert
    expect(implicitIssueRepository(cwd, { env, nonInteractive: true })).toBeUndefined();
  });
});

test("when a configured default is malformed, does not fall back to origin", () => {
  withCheckout((cwd, env) => {
    // Arrange
    git(cwd, "config", "remote.origin.gh-resolved", "not-a-repository");

    // Act / Assert
    expect(implicitIssueRepository(cwd, { env, nonInteractive: true })).toBeUndefined();
  });
});

test("when distinct remote destinations have equal priority, leaves the destination unresolved", () => {
  withCheckout((cwd, env) => {
    // Arrange
    git(cwd, "remote", "rename", "origin", "fork");
    git(cwd, "remote", "add", "parent", `https://github.com/${upstream}.git`);

    // Act / Assert
    expect(implicitIssueRepository(cwd, { env, nonInteractive: true })).toBeUndefined();
  });
});

test("when GH_REPO and GH_HOST are set, uses them instead of the configured default", () => {
  withCheckout((cwd, env) => {
    // Arrange
    git(cwd, "config", "remote.origin.gh-resolved", "base");
    const commandEnv = { ...env, GH_REPO: upstream, GH_HOST: "github.com" };

    // Act / Assert
    expect(implicitIssueRepository(cwd, { env: commandEnv })).toBe(upstream);
  });
});

test("when the command sets a host-qualified GH_REPO, uses it instead of the inherited value", () => {
  withCheckout((cwd, env) => {
    // Arrange
    const commandEnv = { ...env, GH_REPO: `github.com/${upstream}` };
    const shellWords = ["GH_REPO=github.com/third/project", "gh", "issue", "create"];

    // Act / Assert
    expect(implicitIssueRepository(cwd, { env: commandEnv, shellWords })).toBe("third/project");
  });
});

test("when the command clears GH_REPO, uses the configured default", () => {
  withCheckout((cwd, env) => {
    // Arrange
    git(cwd, "config", "remote.origin.gh-resolved", "base");
    const commandEnv = { ...env, GH_REPO: `github.com/${upstream}` };
    const shellWords = ["GH_REPO=", "gh", "issue", "create"];

    // Act / Assert
    expect(implicitIssueRepository(cwd, { env: commandEnv, shellWords })).toBe(origin);
  });
});

test("when GH_REPO omits the host and GH_HOST is unset, leaves the destination unresolved", () => {
  withCheckout((cwd, env) => {
    // Arrange
    const commandEnv = { ...env, GH_REPO: origin };

    // Act / Assert
    expect(implicitIssueRepository(cwd, { env: commandEnv, nonInteractive: true })).toBeUndefined();
  });
});

test("when GH_HOST selects another host, does not equate its repositories with github.com", () => {
  withCheckout((cwd, env) => {
    // Arrange
    const shellWords = ["GH_HOST=github.example.com", "gh", "issue", "create"];

    // Act / Assert
    expect(implicitIssueRepository(cwd, { env, shellWords, nonInteractive: true })).toBeUndefined();
  });
});

test.each([
  { shellWords: ["GIT_DIR=elsewhere", "gh", "issue", "create"] },
  { shellWords: ["GH_REPO=", undefined, "gh", "issue", "create"] },
])("when command-local repository settings are opaque, leaves the destination unresolved", ({ shellWords }) => {
  // Arrange
  withCheckout((cwd, env) => {
    // Act / Assert
    expect(implicitIssueRepository(cwd, {
      env,
      nonInteractive: true,
      shellWords,
    })).toBeUndefined();
  });
});
