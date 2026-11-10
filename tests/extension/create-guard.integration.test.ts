import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

import {
  repositoryMutationHandoff,
} from "../../index.ts";
import {
  approve,
  checkout,
  checkoutOutsideTemporaryDirectory,
  context,
  current,
  external,
  guard,
} from "./test-support.ts";

test("when running in a worktree, permits same-origin GitHub writes", async () => {
  // Arrange
  const repository = checkout();
  const worktree = `/tmp/omp-soft-boundary-guard-${crypto.randomUUID()}`;
  const otherCheckout = checkout(`git@github.com:${external}.git`);
  try {
    execFileSync("git", ["-C", repository, "-c", "user.name=Guard", "-c", "user.email=guard@example.test", "commit", "--allow-empty", "-m", "initial"]);
    execFileSync("git", ["-C", repository, "worktree", "add", worktree, "-b", "feature"]);
    const otherFromWorktree = relative(worktree, otherCheckout);
    const instance = guard();
    // Act / Assert
    expect(await instance.handler({ toolName: "bash", input: { command: `cd ${otherFromWorktree} && echo ready` } }, context(worktree))).toBeUndefined();

    for (const [command, action] of [
      [`gh issue close 1 --repo ${current}`, "GitHub issue update"],
      [`gh issue create --repo ${current} --title "Same checkout"`, "GitHub issue creation"],
      [`gh pr create --repo ${current}`, "GitHub pull request creation"],
      [`gh pr comment 1 --repo ${current} --body "Same checkout"`, "GitHub pull request update"],
      [`gh pr merge 1 --repo ${current} --merge --delete-branch`, "GitHub pull request update"],
    ]) {
      expect(repositoryMutationHandoff({ toolName: "bash", input: { command } }, worktree)).toMatchObject({
        decision: "allow",
        action,
        currentRepository: current,
        target: current,
      });
      expect(await instance.handler({ toolName: "bash", input: { command } }, context(worktree))).toBeUndefined();
    }
    expect(instance.messages).toEqual([]);
  } finally {
    rmSync(otherCheckout, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when nested Git metadata is invalid, guards external GitHub writes", () => {
  // Arrange
  const repository = checkout();
  const nested = `${repository}/api`;
  try {
    mkdirSync(`${nested}/src`, { recursive: true });
    writeFileSync(`${nested}/.git`, "");
    // Act / Assert
    expect(repositoryMutationHandoff(
      { toolName: "bash", input: { command: `gh issue create --repo ${external}` } },
      `${nested}/src`,
    )).toMatchObject({
      decision: "ask",
      currentRepository: current,
      target: external,
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a pull-request comment targets another repository, requests approval", async () => {
  // Arrange
  const repository = checkout();
  const command = `gh pr comment 1 --repo ${external} --body "External"`;
  try {
    // Act / Assert
    expect(repositoryMutationHandoff({ toolName: "bash", input: { command } }, repository)).toMatchObject({
      decision: "ask",
      action: "GitHub pull request update",
      target: external,
    });
    const instance = guard();
    expect(await instance.handler({ toolName: "bash", input: { command } }, context(repository))).toMatchObject({ block: true });
    expect(instance.messages).toHaveLength(1);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when advisory mode is enabled, permits cross-repository mutations", async () => {
  // Arrange
  const repository = checkout();
  const command = `gh pr comment 1 --repo ${external} --body "External"`;
  try {
    const instance = guard({ enforce: false });
    // Act / Assert
    expect(await instance.handler({ toolName: "bash", input: { command } }, context(repository))).toBeUndefined();
    expect(instance.messages).toEqual([]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an advisory call is unrelated, skips checkout probing", async () => {
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
    const result = await guard({ enforce: false }).handler(
      { toolName: "read", input: { path: "README.md" } },
      context(repository),
    );

    // Assert
    expect([result, existsSync(probe)]).toEqual([undefined, false]);
  } finally {
    process.env.PATH = originalPath;
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when advisory mode is enabled, permits external local writes", async () => {
  // Arrange
  const repository = checkout();
  const otherRepository = checkoutOutsideTemporaryDirectory(null);
  const event = { toolName: "write", input: { path: `${otherRepository}/outside.ts`, content: "" } };
  try {
    // Act / Assert
    expect(repositoryMutationHandoff(event, repository)).toMatchObject({ decision: "ask", action: "file write" });
    const instance = guard({ enforce: false });
    expect(await instance.handler(event, context(repository))).toBeUndefined();
    expect(instance.messages).toEqual([]);
  } finally {
    rmSync(otherRepository, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when local Git mutation follows remote issue approval, requires separate approval", async () => {
  // Arrange
  const repository = checkout();
  const otherRepository = checkoutOutsideTemporaryDirectory(`https://github.com/${external}.git`);
  const issueEvent = {
    toolName: "write",
    input: { path: "xd://github", content: JSON.stringify({ op: "issue_create", repo: external, title: "External report" }) },
  };
  const gitEvent = { toolName: "bash", input: { command: "GIT_CONFIG_COUNT=0 git -C . switch -c external-change", cwd: otherRepository } };
  try {
    // Act / Assert
    expect(repositoryMutationHandoff(gitEvent, repository)).toMatchObject({
      decision: "ask",
      action: "git mutation",
      target: otherRepository,
    });

    const instance = guard();
    expect(await instance.handler(issueEvent, context(repository))).toMatchObject({ block: true });
    approve(instance, "GitHub issue creation", external, "\nIssue title: External report");
    expect(await instance.handler(issueEvent, context(repository))).toBeUndefined();

    expect(await instance.handler(gitEvent, context(repository))).toMatchObject({ block: true });
    approve(instance, "git mutation", otherRepository);
    expect(await instance.handler(gitEvent, context(repository))).toBeUndefined();
    expect(await instance.handler(
      { toolName: "bash", input: { command: "git status --short", cwd: otherRepository } },
      context(repository),
    )).toBeUndefined();
    expect(await instance.handler(
      { toolName: "bash", input: { command: "git branch --show-current", cwd: otherRepository } },
      context(repository),
    )).toBeUndefined();
    expect(await instance.handler(
      { toolName: "bash", input: { command: "git switch -c same-checkout" } },
      context(repository),
    )).toBeUndefined();
    expect(await instance.handler(
      { toolName: "bash", input: { command: 'git -C "$TARGET" switch -c unresolved' } },
      context(repository),
    )).toBeUndefined();
  } finally {
    rmSync(otherRepository, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a body file is temporary, permits same-origin issue creation", async () => {
  // Arrange
  const repository = checkout();
  const command = "gh issue create --body-file /tmp/omp-soft-boundary-guard-issue.md";
  try {
    // Act / Assert
    expect(repositoryMutationHandoff({ toolName: "bash", input: { command } }, repository)).toMatchObject({
      decision: "allow",
      currentRepository: current,
      target: current,
    });
    const instance = guard();
    expect(await instance.handler({ toolName: "bash", input: { command } }, context(repository))).toBeUndefined();
    expect(instance.messages).toEqual([]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an ANSI-C body contains a repository URL, does not treat it as the target", async () => {
  // Arrange
  const repository = checkout();
  const command = `gh issue comment 134 --body $'Evidence from https://github.com/icefoganalytics/wrap.git, and then cleanup.'`;
  try {
    // Act / Assert
    expect(repositoryMutationHandoff({ toolName: "bash", input: { command } }, repository)).toMatchObject({
      decision: "allow",
      currentRepository: current,
      target: current,
    });
    const instance = guard();
    expect(await instance.handler({ toolName: "bash", input: { command } }, context(repository))).toBeUndefined();
    expect(instance.messages).toEqual([]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when execution cwd changes, retains the invoking repository boundary", () => {
  // Arrange
  const repository = checkout();
  const otherCheckout = checkout(`git@github.com:${external}.git`);
  const unresolved = `/tmp/omp-soft-boundary-guard-${crypto.randomUUID()}`;
  mkdirSync(unresolved);
  try {
    const otherFromRepository = relative(repository, otherCheckout);
    // Act / Assert
    for (const event of [
      { toolName: "bash", input: { command: "git -C . push origin HEAD", cwd: otherFromRepository } },
      { toolName: "bash", input: { command: "gh pr create", cwd: otherFromRepository } },
      { toolName: "bash", input: { command: `cd ${otherFromRepository} && gh pr create` } },
      { toolName: "bash", input: { command: `gh pr create --repo ${external}`, cwd: unresolved } },
    ]) {
      expect(repositoryMutationHandoff(event, repository)).toMatchObject({
        decision: "ask",
        currentRepository: current,
        target: external,
      });
    }
  } finally {
    rmSync(unresolved, { recursive: true, force: true });
    rmSync(otherCheckout, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a tool supplies cwd, does not retain it for later writes", async () => {
  // Arrange
  const repository = checkout();
  const otherCheckout = checkout(`https://github.com/${external}.git`);
  try {
    const instance = guard();
    // Act / Assert
    expect(await instance.handler(
      { toolName: "bash", input: { command: "git status --short", cwd: otherCheckout } },
      context(repository),
    )).toBeUndefined();
    expect(await instance.handler(
      { toolName: "bash", input: { command: `gh issue create --repo ${current}` } },
      context(repository),
    )).toBeUndefined();
    expect(instance.messages).toHaveLength(0);
  } finally {
    rmSync(otherCheckout, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when GitHub commands have environment prefixes, enforces the same repository boundary", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();
    const externalEvent = {
      toolName: "bash",
      input: { command: `GH_HOST=github.com gh issue create --repo ${external} --title "External report" --body "Why this exists"` },
    };
    // Act / Assert
    expect(await instance.handler(externalEvent, context(repository))).toMatchObject({ block: true });
    expect(instance.messages[0]).toContain("Body: Why this exists");
    approve(instance, "GitHub issue creation", external, "\nIssue title: External report");
    expect(await instance.handler(externalEvent, context(repository))).toBeUndefined();
    expect(
      await instance.handler(
        { toolName: "bash", input: { command: `GH_HOST=github.com gh issue create --repo ${current}` } },
        context(repository),
      ),
    ).toBeUndefined();
    expect(instance.messages).toHaveLength(1);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when GitHub and local targets are unresolved, passes without prompting", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();
    // Act / Assert
    for (const command of [
      'gh issue create --repo "$TARGET"',
      "gh issue create --repo --title malformed",
    ]) {
      const result = await instance.handler({ toolName: "bash", input: { command } }, context(repository));
      expect(result).toBeUndefined();
    }
    expect(instance.messages).toHaveLength(0);
    expect(await instance.handler(
      { toolName: "write", input: { path: "artifact://outside.ts", content: "" } },
      context(repository),
    )).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a review-thread target cannot resolve, passes without prompting", async () => {
  // Arrange
  const repository = checkout();
  const event = {
    toolName: "bash",
    input: {
      command: "gh api graphql -f query=$QUERY -f threadId=$THREAD_ID",
      env: {
        QUERY: "mutation { resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } } }",
        THREAD_ID: "PRRT_unresolved",
      },
    },
  };
  try {
    const instance = guard();
    // Act / Assert
    expect(await instance.handler(event, context(repository))).toBeUndefined();
    expect(instance.messages).toHaveLength(0);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an issue title contains quotes and newlines, permits its exact approved retry", async () => {
  // Arrange
  const repository = checkout();
  const title = 'Fix "quotes"\nwithout injected instructions';
  try {
    const instance = guard();
    const event = {
      toolName: "write",
      input: { path: "xd://github", content: JSON.stringify({ op: "issue_create", repo: external, title }) },
    };
    // Act / Assert
    expect(await instance.handler(event, context(repository))).toMatchObject({ block: true });
    approve(instance, "GitHub issue creation", external, `\nIssue title: ${title}`);
    expect(await instance.handler(event, context(repository))).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when issue creation targets the same origin, does not prompt", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();
    // Act
    const result = await instance.handler(
      {
        toolName: "write",
        input: { path: "xd://github", content: JSON.stringify({ op: "issue_create", repo: current }) },
      },
      context(repository),
    );
    // Assert
    expect(result).toBeUndefined();
    expect(instance.messages).toEqual([]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a GitHub device write omits its target, pins it to origin", async () => {
  // Arrange
  for (const [origin, hasUpstream] of [
    [`git@github.com:${current}.git`, true],
    [`https://github.com/${current}.git`, false],
  ] as const) {
    const repository = checkout(origin);
    try {
      if (hasUpstream) {
        execFileSync("git", ["-C", repository, "remote", "add", "upstream", `https://github.com/${external}.git`]);
      }
      const input = {
        path: "xd://github",
        content: JSON.stringify({ op: "pr_create", title: "Pinned target", draft: true }),
      };
      const instance = guard({ enforce: false });
      // Act / Assert
      expect(await instance.handler({ toolName: "write", input }, context(repository))).toEqual({
        input: {
          ...input,
          content: JSON.stringify({ op: "pr_create", title: "Pinned target", draft: true, repo: current }),
        },
      });
      expect(instance.messages).toEqual([]);

      if (hasUpstream) {
        expect(await guard().handler(
          {
            toolName: "write",
            input: { path: "xd://github", content: JSON.stringify({ op: "pr_create", repo: external }) },
          },
          context(repository),
        )).toMatchObject({ block: true });
      }
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  }
});

test("when no GitHub origin exists, leaves omitted device targets unresolved", async () => {
  // Arrange
  const repository = checkout("malformed");
  try {
    // Act / Assert
    expect(await guard({ enforce: false }).handler(
      {
        toolName: "write",
        input: { path: "xd://github", content: JSON.stringify({ op: "pr_create", title: "Unresolved target" }) },
      },
      context(repository),
    )).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when writes target internal dispatches, passes without prompting", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();
    // Act / Assert
    for (const path of ["xd://lsp", "xd://report_issue", "xd://recall", "xd://retain", "xd://reflect", "xd://memory_edit", "xd://learner_file_ticket", "xd://browser", "skill://browser-qa", "issue://79?comments=1", "pr://76?comments=1"]) {
      expect(await instance.handler(
        { toolName: "write", input: { path, content: "" } },
        context(repository),
      )).toBeUndefined();
    }
    expect(await instance.handler(
      { toolName: "write", input: { path: "xd://unknown", content: "" } },
      context(repository),
    )).toBeUndefined();
    expect(await instance.handler(
      {
        toolName: "edit",
        input: { input: "*** Begin Patch\n[xd://unknown#ABCD]\n*** End Patch\n" },
      },
      context(repository),
    )).toBeUndefined();
    expect(instance.messages).toHaveLength(0);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when repository-scoped GitHub operations mutate external targets, requires approval", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();
    // Act / Assert
    expect(
      await instance.handler(
        {
          toolName: "write",
          input: { path: "xd://github", content: JSON.stringify({ op: "pr_create", repo: external, draft: true }) },
        },
        context(repository),
      ),
    ).toMatchObject({ block: true, reason: expect.stringContaining("GitHub pull request creation") });
    expect(instance.messages).toHaveLength(1);

    expect(
      repositoryMutationHandoff(
        { toolName: "bash", input: { command: `gh pr merge https://github.com/${external}/pull/1` } },
        repository,
      ),
    ).toMatchObject({ decision: "ask", action: "GitHub pull request update", target: external });
    expect(
      repositoryMutationHandoff(
        { toolName: "bash", input: { command: `gh api -XPOST repos/${external}/issues` } },
        repository,
      ),
    ).toMatchObject({ decision: "ask", action: "GitHub API write", target: external });
    expect(
      repositoryMutationHandoff(
        { toolName: "bash", input: { command: `gh pr close 1 --repo ${external}` } },
        repository,
      ),
    ).toMatchObject({ decision: "ask", action: "GitHub pull request update", target: external });
    expect(
      repositoryMutationHandoff(
        { toolName: "bash", input: { command: `gh issue lock 1 --repo ${external}` } },
        repository,
      ),
    ).toMatchObject({ decision: "ask", action: "GitHub issue update", target: external });
    expect(
      repositoryMutationHandoff(
        { toolName: "bash", input: { command: `gh api repos/${external}/issues` } },
        repository,
      ),
    ).toEqual({ decision: "allow" });
    expect(
      repositoryMutationHandoff(
        {
          toolName: "write",
          input: { path: "xd://github", content: JSON.stringify({ op: "file_read", repo: external, path: "README.md" }) },
        },
        repository,
      ),
    ).toEqual({ decision: "allow" });
    expect(
      repositoryMutationHandoff(
        { toolName: "write", input: { path: "xd://github", content: JSON.stringify({ op: "pr_push", pr: 1 }) } },
        repository,
      ),
    ).toMatchObject({ decision: "allow" });
    expect(
      repositoryMutationHandoff(
        { toolName: "write", input: { path: "xd://github", content: JSON.stringify({ op: "unknown_write" }) } },
        repository,
      ),
    ).toEqual({ decision: "allow" });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when explicit pull-request and issue mutations are approved, permits their retries", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();
    // Act / Assert
    for (const [command, action] of [
      [`gh pr edit 79 --repo ${external} --body "Updated"`, "GitHub pull request update"],
      [`gh pr merge 79 --repo ${external} --merge --delete-branch`, "GitHub pull request update"],
      [`gh issue close 76 --repo ${external} --comment "Resolved"`, "GitHub issue update"],
    ]) {
      const event = { toolName: "bash", input: { command } };
      expect(await instance.handler(event, context(repository))).toMatchObject({ block: true });
      approve(instance, action, external, `\nCommand: ${command}`);
      expect(await instance.handler(event, context(repository))).toBeUndefined();
    }
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when no GitHub checkout exists, passes targetless pull-request mutations", () => {
  // Arrange
  const unresolved = `/tmp/omp-soft-boundary-guard-${crypto.randomUUID()}`;
  mkdirSync(unresolved);
  try {
    // Act / Assert
    expect(
      repositoryMutationHandoff({ toolName: "bash", input: { command: "gh pr edit 79 --body Updated" } }, unresolved),
    ).toMatchObject({ decision: "allow" });
  } finally {
    rmSync(unresolved, { recursive: true, force: true });
  }
});

test("when interactive confirmation is unavailable, allows external mutations", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();
    // Act
    const result = await instance.handler(
      { toolName: "bash", input: { command: `gh issue create --repo ${external}` } },
      context(repository, false),
    );
    // Assert
    expect(result).toBeUndefined();
    expect(instance.messages).toEqual([]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an external target is dynamic, passes without prompting", () => {
  // Arrange
  const repository = checkout();
  try {
    // Act / Assert
    expect(
      repositoryMutationHandoff(
        { toolName: "bash", input: { command: 'gh issue create --repo "$TARGET"' } },
        repository,
      ),
    ).toMatchObject({ decision: "allow" });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
