import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  answerConfirmation,
  checkout,
  checkoutOutsideTemporaryDirectory,
  confirmationId,
  context,
  current,
  external,
  guard,
} from "./test-support.ts";

import { repositoryMutationHandoff } from "../../index.ts";

const repository = checkout();
const otherCheckout = checkout(`git@github.com:${external}.git`);

afterAll(() => {
  rmSync(otherCheckout, { recursive: true, force: true });
  rmSync(repository, { recursive: true, force: true });
});

const sameOriginWrites = [
  { command: `gh issue close 1 --repo ${current}`, action: "GitHub issue update" },
  { command: `gh issue create --repo ${current} --title "Same checkout"`, action: "GitHub issue creation" },
  { command: `gh pr create --repo ${current}`, action: "GitHub pull request creation" },
  { command: `gh pr comment 1 --repo ${current} --body "Same checkout"`, action: "GitHub pull request update" },
  { command: `gh pr merge 1 --repo ${current} --merge --delete-branch`, action: "GitHub pull request update" },
];

const externalComment = {
  toolName: "bash",
  input: { command: `gh pr comment 1 --repo ${external} --body "External"` },
};
const externalDraft = {
  toolName: "write",
  input: { path: "xd://github", content: JSON.stringify({ op: "pr_create", repo: external, draft: true }) },
};
const prefixedExternalIssue = {
  toolName: "bash",
  input: { command: `GH_HOST=github.com gh issue create --repo ${external} --title "External report" --body "Why this exists"` },
};

describe("linked worktree", () => {
  const primaryCheckout = checkout();
  const worktree = `/tmp/omp-soft-boundary-guard-${crypto.randomUUID()}`;

  beforeAll(() => {
    execFileSync("git", ["-C", primaryCheckout, "-c", "user.name=Guard", "-c", "user.email=guard@example.test", "commit", "--allow-empty", "-m", "initial"]);
    execFileSync("git", ["-C", primaryCheckout, "worktree", "add", worktree, "-b", "feature"]);
  });

  afterAll(() => {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(primaryCheckout, { recursive: true, force: true });
  });

  test.each(sameOriginWrites)("when $command runs from a linked worktree, classifies the shared origin as inside", ({ command, action }) => {
    // Arrange
    const event = { toolName: "bash", input: { command } };

    // Act
    const decision = repositoryMutationHandoff(event, worktree);

    // Assert
    expect(decision).toMatchObject({
      decision: "allow",
      action,
      currentRepository: current,
      target: current,
    });
  });

  test.each(sameOriginWrites)("when $command follows an unrelated cd from a linked worktree, still permits the same-origin write", async ({ command }) => {
    // Arrange
    const instance = guard();
    const otherFromWorktree = relative(worktree, otherCheckout);
    const inspection = { toolName: "bash", input: { command: `cd ${otherFromWorktree} && echo ready` } };
    const write = { toolName: "bash", input: { command } };

    // Act
    const inspectionDecision = await instance.handler(inspection, context(worktree));
    const writeDecision = await instance.handler(write, context(worktree));

    // Assert
    expect([inspectionDecision, writeDecision]).toEqual([undefined, undefined]);
  });

  test.each(sameOriginWrites)("when $command targets the linked worktree origin, does not request confirmation", async ({ command }) => {
    // Arrange
    const instance = guard();
    const event = { toolName: "bash", input: { command } };

    // Act
    await instance.handler(event, context(worktree));

    // Assert
    expect(instance.messages).toEqual([]);
  });
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

test("when a pull-request comment targets another repository, classifies it as an external GitHub update", () => {
  // Arrange: use the shared checkout and explicit external comment.

  // Act
  const decision = repositoryMutationHandoff(externalComment, repository);

  // Assert
  expect(decision).toMatchObject({
    decision: "ask",
    action: "GitHub pull request update",
    target: external,
  });
});

test("when a pull-request comment targets another repository, blocks it before execution", async () => {
  // Arrange
  const instance = guard();

  // Act
  const decision = await instance.handler(externalComment, context(repository));

  // Assert
  expect(decision).toMatchObject({ block: true });
});

test.each([
  { operation: "a cross-repository pull-request comment", event: externalComment, confirmationText: confirmationId },
  { operation: "a cross-repository device pull-request creation", event: externalDraft, confirmationText: confirmationId },
  { operation: "an external issue creation prefixed with GH_HOST", event: prefixedExternalIssue, confirmationText: "Body: Why this exists" },
])("when $operation is blocked, sends one confirmation request with its details", async ({ event, confirmationText }) => {
  // Arrange
  const instance = guard();

  // Act
  await instance.handler(event, context(repository));

  // Assert
  expect(instance.messages).toEqual([expect.stringContaining(confirmationText)]);
});

test("when advisory mode sees a cross-repository GitHub mutation, lets it proceed", async () => {
  // Arrange
  const instance = guard({ enforce: false });

  // Act
  const decision = await instance.handler(externalComment, context(repository));

  // Assert
  expect(decision).toBeUndefined();
});

test("when advisory mode sees a cross-repository GitHub mutation, does not request confirmation", async () => {
  // Arrange
  const instance = guard({ enforce: false });

  // Act
  await instance.handler(externalComment, context(repository));

  // Assert
  expect(instance.messages).toEqual([]);
});

test("when an advisory call reads a file, lets it proceed", async () => {
  // Arrange
  const instance = guard({ enforce: false });
  const event = { toolName: "read", input: { path: "README.md" } };

  // Act
  const decision = await instance.handler(event, context(repository));

  // Assert
  expect(decision).toBeUndefined();
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
    await guard({ enforce: false }).handler(
      { toolName: "read", input: { path: "README.md" } },
      context(repository),
    );

    // Assert
    expect(existsSync(probe)).toBeFalse();
  } finally {
    process.env.PATH = originalPath;
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a local write targets another checkout, classifies it as an external file write", () => {
  // Arrange
  const otherRepository = checkoutOutsideTemporaryDirectory(null);
  const event = { toolName: "write", input: { path: `${otherRepository}/outside.ts`, content: "" } };
  try {
    // Act
    const decision = repositoryMutationHandoff(event, repository);

    // Assert
    expect(decision).toMatchObject({ decision: "ask", action: "file write" });
  } finally {
    rmSync(otherRepository, { recursive: true, force: true });
  }
});

test("when advisory mode sees a local write to another checkout, lets it proceed", async () => {
  // Arrange
  const otherRepository = checkoutOutsideTemporaryDirectory(null);
  const event = { toolName: "write", input: { path: `${otherRepository}/outside.ts`, content: "" } };
  const instance = guard({ enforce: false });
  try {
    // Act
    const decision = await instance.handler(event, context(repository));

    // Assert
    expect(decision).toBeUndefined();
  } finally {
    rmSync(otherRepository, { recursive: true, force: true });
  }
});

test("when advisory mode sees a local write to another checkout, does not request confirmation", async () => {
  // Arrange
  const otherRepository = checkoutOutsideTemporaryDirectory(null);
  const event = { toolName: "write", input: { path: `${otherRepository}/outside.ts`, content: "" } };
  const instance = guard({ enforce: false });
  try {
    // Act
    await instance.handler(event, context(repository));

    // Assert
    expect(instance.messages).toEqual([]);
  } finally {
    rmSync(otherRepository, { recursive: true, force: true });
  }
});

test("when git switch targets another checkout through tool cwd, identifies the local checkout as the target", () => {
  // Arrange
  const otherRepository = checkoutOutsideTemporaryDirectory(`https://github.com/${external}.git`);
  const event = {
    toolName: "bash",
    input: { command: "GIT_CONFIG_COUNT=0 git -C . switch -c external-change", cwd: otherRepository },
  };
  try {
    // Act
    const decision = repositoryMutationHandoff(event, repository);

    // Assert
    expect(decision).toMatchObject({
      decision: "ask",
      action: "git mutation",
      target: otherRepository,
    });
  } finally {
    rmSync(otherRepository, { recursive: true, force: true });
  }
});

test("when a local Git mutation follows a remote issue approval, requires its own exact approval", async () => {
  // Arrange
  const otherRepository = checkoutOutsideTemporaryDirectory(`https://github.com/${external}.git`);
  const issue = {
    toolName: "write",
    input: { path: "xd://github", content: JSON.stringify({ op: "issue_create", repo: external, title: "External report" }) },
  };
  const localMutation = {
    toolName: "bash",
    input: { command: "GIT_CONFIG_COUNT=0 git -C . switch -c external-change", cwd: otherRepository },
  };
  const instance = guard();
  try {
    // Act
    const issueBeforeApproval = await instance.handler(issue, context(repository));
    answerConfirmation(instance, "Approve");
    const issueAfterApproval = await instance.handler(issue, context(repository));
    const gitBeforeApproval = await instance.handler(localMutation, context(repository));
    answerConfirmation(instance, "Approve");
    const gitAfterApproval = await instance.handler(localMutation, context(repository));

    // Assert
    expect([issueBeforeApproval, issueAfterApproval, gitBeforeApproval, gitAfterApproval]).toEqual([
      expect.objectContaining({ block: true }),
      undefined,
      expect.objectContaining({ block: true }),
      undefined,
    ]);
  } finally {
    rmSync(otherRepository, { recursive: true, force: true });
  }
});

test.each(["git status --short", "git branch --show-current"])(
  "when %s inspects another checkout, lets it proceed",
  async (command) => {
    // Arrange
    const instance = guard();
    const event = { toolName: "bash", input: { command, cwd: otherCheckout } };

    // Act
    const decision = await instance.handler(event, context(repository));

    // Assert
    expect(decision).toBeUndefined();
  },
);

test("when git switch mutates the invoking checkout, lets it proceed", async () => {
  // Arrange
  const instance = guard();
  const event = { toolName: "bash", input: { command: "git switch -c same-checkout" } };

  // Act
  const decision = await instance.handler(event, context(repository));

  // Assert
  expect(decision).toBeUndefined();
});

test("when git switch has a dynamic checkout target, lets it proceed without resolving the target", async () => {
  // Arrange
  const instance = guard();
  const event = { toolName: "bash", input: { command: 'git -C "$TARGET" switch -c unresolved' } };

  // Act
  const decision = await instance.handler(event, context(repository));

  // Assert
  expect(decision).toBeUndefined();
});

const issueBodyInputs = [
  {
    body: "a temporary issue body file is used",
    command: "gh issue create --body-file /tmp/omp-soft-boundary-guard-issue.md",
  },
  {
    body: "an ANSI-C issue body contains a different repository URL",
    command: "gh issue comment 134 --body $'Evidence from https://github.com/icefoganalytics/wrap.git, and then cleanup.'",
  },
];

test.each(issueBodyInputs)("when $body, classifies the current repository as the issue target", ({ command }) => {
  // Arrange
  const event = { toolName: "bash", input: { command } };

  // Act
  const decision = repositoryMutationHandoff(event, repository);

  // Assert
  expect(decision).toMatchObject({ decision: "allow", currentRepository: current, target: current });
});

const sameOriginInputs = [
  ...issueBodyInputs.map(({ body, command }) => ({ input: body, event: { toolName: "bash", input: { command } } })),
  {
    input: "GH_HOST prefixes an issue creation for the current repository",
    event: { toolName: "bash", input: { command: `GH_HOST=github.com gh issue create --repo ${current}` } },
  },
  {
    input: "a GitHub device issue creation explicitly targets the current repository",
    event: {
      toolName: "write",
      input: { path: "xd://github", content: JSON.stringify({ op: "issue_create", repo: current }) },
    },
  },
];

test.each(sameOriginInputs)("when $input, allows the same-origin issue mutation", async ({ event }) => {
  // Arrange
  const instance = guard();

  // Act
  const decision = await instance.handler(event, context(repository));

  // Assert
  expect(decision).toBeUndefined();
});

test.each(sameOriginInputs)("when $input, does not request confirmation for the same-origin issue mutation", async ({ event }) => {
  // Arrange
  const instance = guard();

  // Act
  await instance.handler(event, context(repository));

  // Assert
  expect(instance.messages).toEqual([]);
});

const otherFromRepository = relative(repository, otherCheckout);

test.each([
  { change: "a Git push starts in a relative tool cwd", command: "git -C . push origin HEAD", cwd: otherFromRepository },
  { change: "a pull-request creation starts in a relative tool cwd", command: "gh pr create", cwd: otherFromRepository },
  { change: "a pull-request creation follows a shell cd", command: `cd ${otherFromRepository} && gh pr create` },
])("when $change in another checkout, retains the invoking repository boundary", ({ command, cwd }) => {
  // Arrange
  const event = { toolName: "bash", input: { command, cwd } };

  // Act
  const decision = repositoryMutationHandoff(event, repository);

  // Assert
  expect(decision).toMatchObject({ decision: "ask", currentRepository: current, target: external });
});

test("when tool cwd has no Git metadata, uses the invoking boundary for an explicitly targeted write", () => {
  // Arrange
  const unresolved = `/tmp/omp-soft-boundary-guard-${crypto.randomUUID()}`;
  const event = { toolName: "bash", input: { command: `gh pr create --repo ${external}`, cwd: unresolved } };
  mkdirSync(unresolved);
  try {
    // Act
    const decision = repositoryMutationHandoff(event, repository);

    // Assert
    expect(decision).toMatchObject({ decision: "ask", currentRepository: current, target: external });
  } finally {
    rmSync(unresolved, { recursive: true, force: true });
  }
});

test("when an inspection supplies another checkout as tool cwd, does not reuse it for the next write", async () => {
  // Arrange
  const instance = guard();
  const inspection = { toolName: "bash", input: { command: "git status --short", cwd: otherCheckout } };
  const write = { toolName: "bash", input: { command: `gh issue create --repo ${current}` } };

  // Act
  await instance.handler(inspection, context(repository));
  const decision = await instance.handler(write, context(repository));

  // Assert
  expect(decision).toBeUndefined();
});

test("when an external issue creation is prefixed with GH_HOST, blocks it until exact approval is granted", async () => {
  // Arrange
  const instance = guard();

  // Act
  const beforeApproval = await instance.handler(prefixedExternalIssue, context(repository));
  answerConfirmation(instance, "Approve");
  const retry = await instance.handler(prefixedExternalIssue, context(repository));

  // Assert
  expect([beforeApproval, retry]).toEqual([expect.objectContaining({ block: true }), undefined]);
});

const unresolvedGitHubTargets = [
  {
    target: "the GitHub issue target is dynamic",
    event: { toolName: "bash", input: { command: 'gh issue create --repo "$TARGET"' } },
  },
  {
    target: "the GitHub issue target flag is missing its value",
    event: { toolName: "bash", input: { command: "gh issue create --repo --title malformed" } },
  },
  {
    target: "the GraphQL review-thread target cannot resolve",
    event: {
      toolName: "bash",
      input: {
        command: "gh api graphql -f query=$QUERY -f threadId=$THREAD_ID",
        env: {
          QUERY: "mutation { resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } } }",
          THREAD_ID: "PRRT_unresolved",
        },
      },
    },
  },
];

test.each(unresolvedGitHubTargets)("when $target, lets the call proceed", async ({ event }) => {
  // Arrange
  const instance = guard();

  // Act
  const decision = await instance.handler(event, context(repository));

  // Assert
  expect(decision).toBeUndefined();
});

test.each(unresolvedGitHubTargets)("when $target, does not request confirmation", async ({ event }) => {
  // Arrange
  const instance = guard();

  // Act
  await instance.handler(event, context(repository));

  // Assert
  expect(instance.messages).toEqual([]);
});

test("when a local write uses an unresolved artifact URI, lets the call proceed", async () => {
  // Arrange
  const instance = guard();
  const event = { toolName: "write", input: { path: "artifact://outside.ts", content: "" } };

  // Act
  const decision = await instance.handler(event, context(repository));

  // Assert
  expect(decision).toBeUndefined();
});

test("when an issue title contains quotes and newlines, allows its exact retry only after approval", async () => {
  // Arrange
  const instance = guard();
  const title = 'Fix "quotes"\nwithout injected instructions';
  const event = {
    toolName: "write",
    input: { path: "xd://github", content: JSON.stringify({ op: "issue_create", repo: external, title }) },
  };

  // Act
  const beforeApproval = await instance.handler(event, context(repository));
  answerConfirmation(instance, "Approve");
  const retry = await instance.handler(event, context(repository));

  // Assert
  expect([beforeApproval, retry]).toEqual([expect.objectContaining({ block: true }), undefined]);
});

describe("GitHub device target pinning", () => {
  const sshCheckout = checkout(`git@github.com:${current}.git`);
  const originCheckouts = [
    { origin: "SSH origin and a different upstream", cwd: sshCheckout },
    { origin: "HTTPS origin", cwd: repository },
  ];
  const input = {
    path: "xd://github",
    content: JSON.stringify({ op: "pr_create", title: "Pinned target", draft: true }),
  };

  beforeAll(() => {
    execFileSync("git", ["-C", sshCheckout, "remote", "add", "upstream", `https://github.com/${external}.git`]);
  });

  afterAll(() => {
    rmSync(sshCheckout, { recursive: true, force: true });
  });

  test.each(originCheckouts)("when a device write omits its target in a checkout with $origin, pins it to origin", async ({ cwd }) => {
    // Arrange
    const instance = guard({ enforce: false });

    // Act
    const decision = await instance.handler({ toolName: "write", input }, context(cwd));

    // Assert
    expect(decision).toEqual({
      input: {
        ...input,
        content: JSON.stringify({ op: "pr_create", title: "Pinned target", draft: true, repo: current }),
      },
    });
  });

  test.each(originCheckouts)("when target pinning uses a checkout with $origin, does not request confirmation", async ({ cwd }) => {
    // Arrange
    const instance = guard({ enforce: false });

    // Act
    await instance.handler({ toolName: "write", input }, context(cwd));

    // Assert
    expect(instance.messages).toEqual([]);
  });

  test("when a device write explicitly targets upstream instead of origin, requires approval", async () => {
    // Arrange
    const instance = guard();
    const event = {
      toolName: "write",
      input: { path: "xd://github", content: JSON.stringify({ op: "pr_create", repo: external }) },
    };

    // Act
    const decision = await instance.handler(event, context(sshCheckout));

    // Assert
    expect(decision).toMatchObject({ block: true });
  });
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

const internalDispatchWrites = [
  "xd://lsp",
  "xd://report_issue",
  "xd://recall",
  "xd://retain",
  "xd://reflect",
  "xd://memory_edit",
  "xd://learner_file_ticket",
  "xd://browser",
  "skill://browser-qa",
  "issue://79?comments=1",
  "pr://76?comments=1",
  "xd://unknown",
].map((path) => ({ destination: path, event: { toolName: "write", input: { path, content: "" } } }));

const dispatchEvents = [
  ...internalDispatchWrites,
  {
    destination: "an edit of xd://unknown",
    event: { toolName: "edit", input: { input: "*** Begin Patch\n[xd://unknown#ABCD]\n*** End Patch\n" } },
  },
];

test.each(dispatchEvents)("when a filesystem tool targets $destination, lets the dispatch proceed", async ({ event }) => {
  // Arrange
  const instance = guard();

  // Act
  const decision = await instance.handler(event, context(repository));

  // Assert
  expect(decision).toBeUndefined();
});

test.each(dispatchEvents)("when a filesystem tool targets $destination, does not request approval", async ({ event }) => {
  // Arrange
  const instance = guard();

  // Act
  await instance.handler(event, context(repository));

  // Assert
  expect(instance.messages).toEqual([]);
});

test("when GitHub device pull-request creation targets another repository, blocks it with the action in the reason", async () => {
  // Arrange
  const instance = guard();

  // Act
  const decision = await instance.handler(externalDraft, context(repository));

  // Assert
  expect(decision).toMatchObject({
    block: true,
    reason: expect.stringContaining("GitHub pull request creation"),
  });
});

test.each([
  { command: `gh pr merge https://github.com/${external}/pull/1`, action: "GitHub pull request update" },
  { command: `gh api -XPOST repos/${external}/issues`, action: "GitHub API write" },
  { command: `gh pr close 1 --repo ${external}`, action: "GitHub pull request update" },
  { command: `gh issue lock 1 --repo ${external}`, action: "GitHub issue update" },
])("when $command mutates another repository, classifies it for approval", ({ command, action }) => {
  // Arrange
  const event = { toolName: "bash", input: { command } };

  // Act
  const decision = repositoryMutationHandoff(event, repository);

  // Assert
  expect(decision).toMatchObject({ decision: "ask", action, target: external });
});

test("when a GitHub API request reads external issues, allows it without a mutation handoff", () => {
  // Arrange
  const event = { toolName: "bash", input: { command: `gh api repos/${external}/issues` } };

  // Act
  const decision = repositoryMutationHandoff(event, repository);

  // Assert
  expect(decision).toEqual({ decision: "allow" });
});

test("when the GitHub device reads an external file, allows it without a mutation handoff", () => {
  // Arrange
  const event = {
    toolName: "write",
    input: { path: "xd://github", content: JSON.stringify({ op: "file_read", repo: external, path: "README.md" }) },
  };

  // Act
  const decision = repositoryMutationHandoff(event, repository);

  // Assert
  expect(decision).toEqual({ decision: "allow" });
});

test("when the GitHub device push omits its repository, lets the call proceed", () => {
  // Arrange
  const event = {
    toolName: "write",
    input: { path: "xd://github", content: JSON.stringify({ op: "pr_push", pr: 1 }) },
  };

  // Act
  const decision = repositoryMutationHandoff(event, repository);

  // Assert
  expect(decision).toMatchObject({ decision: "allow" });
});

test("when a GitHub device operation is unsupported, allows it without a mutation handoff", () => {
  // Arrange
  const event = { toolName: "write", input: { path: "xd://github", content: JSON.stringify({ op: "unknown_write" }) } };

  // Act
  const decision = repositoryMutationHandoff(event, repository);

  // Assert
  expect(decision).toEqual({ decision: "allow" });
});

test.each([
  `gh pr edit 79 --repo ${external} --body "Updated"`,
  `gh pr merge 79 --repo ${external} --merge --delete-branch`,
  `gh issue close 76 --repo ${external} --comment "Resolved"`,
])("when %s is approved, allows the exact retry after blocking the original attempt", async (command) => {
  // Arrange
  const instance = guard();
  const event = { toolName: "bash", input: { command } };

  // Act
  const beforeApproval = await instance.handler(event, context(repository));
  answerConfirmation(instance, "Approve");
  const retry = await instance.handler(event, context(repository));

  // Assert
  expect([beforeApproval, retry]).toEqual([expect.objectContaining({ block: true }), undefined]);
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

test("when interactive confirmation is unavailable for an external mutation, lets it proceed", async () => {
  // Arrange
  const instance = guard();
  const event = { toolName: "bash", input: { command: `gh issue create --repo ${external}` } };

  // Act
  const decision = await instance.handler(event, context(repository, false));

  // Assert
  expect(decision).toBeUndefined();
});

test("when interactive confirmation is unavailable for an external mutation, does not send an Ask request", async () => {
  // Arrange
  const instance = guard();
  const event = { toolName: "bash", input: { command: `gh issue create --repo ${external}` } };

  // Act
  await instance.handler(event, context(repository, false));

  // Assert
  expect(instance.messages).toEqual([]);
});

test("when the GitHub target is dynamic, projects an allow decision", () => {
  // Arrange
  const event = { toolName: "bash", input: { command: 'gh issue create --repo "$TARGET"' } };

  // Act
  const decision = repositoryMutationHandoff(event, repository);

  // Assert
  expect(decision).toMatchObject({ decision: "allow" });
});
