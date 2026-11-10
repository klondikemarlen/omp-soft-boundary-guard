import { mkdirSync, rmSync } from "node:fs";

import { expect, test } from "bun:test";

import { repositoryMutationHandoff } from "../../guard/handoff.ts";
import { nativeAskApproval } from "./native-ask-fixture.ts";
import { approve, checkout, context, external, guard } from "./test-support.ts";

test("when confirmation is pending, does not reissue it", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();
    const event = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title "Pending"` } };
    // Act / Assert
    await instance.handler(event, context(repository));
    const result = await instance.handler(event, context(repository));
    expect(result).toMatchObject({ reason: expect.stringContaining("confirmation is already pending") });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when another HTML form is approved, leaves the original confirmation pending", async () => {
  // Arrange
  const repository = checkout();
  const event = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title "Unrelated approval"` } };
  try {
    const instance = guard();
    await instance.handler(event, context(repository));
    // Act
    instance.answer(nativeAskApproval);
    const retry = await instance.handler(event, context(repository));
    // Assert
    expect(retry).toMatchObject({
      block: true,
      reason: expect.stringContaining("confirmation is already pending"),
    });
    expect(instance.messages).toHaveLength(1);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when the native form result approves issue creation, permits exactly one retry", async () => {
  // Arrange
  const repository = checkout();
  const event = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title "Approved locally"` } };
  try {
    const instance = guard();
    // Act / Assert
    expect(await instance.handler(event, context(repository))).toMatchObject({ block: true });
    const message = instance.messages[0]!;
    const start = message.indexOf("{");
    const end = message.indexOf("}. If approved", start) + 1;
    const ask = JSON.parse(message.slice(start, end)) as Record<string, unknown>;
    // Replay native result details against this request's generated HTML, not the capture's unrelated form.
    instance.answer({
      ...nativeAskApproval,
      input: ask,
    });

    expect(await instance.handler(event, context(repository))).toBeUndefined();
    expect(await instance.handler(event, context(repository))).toMatchObject({ block: true });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when retrying from a nested directory, preserves the approved checkout identity", async () => {
  // Arrange
  const repository = checkout();
  const nestedDirectory = `${repository}/nested`;
  const event = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title "Nested"` } };
  try {
    mkdirSync(nestedDirectory);
    const instance = guard();
    // Act / Assert
    expect(await instance.handler(event, context(repository))).toMatchObject({ block: true });
    approve(instance, "GitHub issue creation", external);

    expect(await instance.handler(event, context(nestedDirectory))).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an external GitHub gate already approved, permits its matching retry", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();
    const event = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title "Approved externally" --body "Original"` } };
    // Act / Assert
    await instance.handler(event, context(repository));
    instance.answer({
      toolName: "ask",
      input: {
        questions: [{
          id: "confirm_external_github_write",
          question: `Allow one GitHub issue creation to ${external}?\nIssue title: Approved externally\nBody: Original\nCommand: gh issue create --repo ${external} --title "Approved externally" --body "Original"`,
        }],
      },
      details: { selectedOptions: ["Approve"] },
      isError: false,
    });
    const retry = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title "Approved externally" --body "Original"` } };
    const result = await instance.handler(retry, context(repository));
    expect(result).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when external approval precedes the first retry, consumes it", async () => {
  // Arrange
  const repository = checkout(null);
  const command = `gh api --method PATCH repos/${external}/issues/6458 -f body="$ISSUE_BODY" --jq .html_url`;
  try {
    const instance = guard();
    // Act / Assert
    instance.answer({
      toolName: "ask",
      input: { questions: [{ id: "confirm_external_github_write", question: `Allow one GitHub API write to ${external}?\nCommand: ${command}` }] },
      details: { selectedOptions: ["Approve"] },
      isError: false,
    });
    const result = await instance.handler({ toolName: "bash", input: { command } }, context(repository));
    expect(result).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an API issue creation is equivalent, reuses external issue approval", async () => {
  // Arrange
  const repository = checkout();
  const command = `gh api repos/${external}/issues --method POST -f title="Approved" -f body="Body"`;
  try {
    const instance = guard();
    // Act / Assert
    instance.answer({
      toolName: "ask",
      input: {
        questions: [{ id: "confirm_external_github_write", question: `Allow one GitHub issue creation in ${external}?` }],
      },
      details: { selectedOptions: ["Approve"] },
      isError: false,
    });
    expect(await instance.handler({ toolName: "bash", input: { command } }, context(repository))).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an API operation updates an issue, does not reuse creation approval", async () => {
  // Arrange
  const repository = checkout();
  const updateCommand = `gh api repos/${external}/issues/12 --method PATCH -f body="Changed"`;
  const createCommand = `gh api repos/${external}/issues --method POST -f title="Created" -f body="Body"`;
  try {
    const instance = guard();
    // Act / Assert
    instance.answer({
      toolName: "ask",
      input: {
        questions: [{ id: "confirm_external_github_write", question: `Allow one GitHub issue creation in ${external}?` }],
      },
      details: { selectedOptions: ["Approve"] },
      isError: false,
    });
    expect(await instance.handler({ toolName: "bash", input: { command: updateCommand } }, context(repository))).toMatchObject({ block: true });
    expect(await instance.handler({ toolName: "bash", input: { command: createCommand } }, context(repository))).toBeUndefined();
    expect(await instance.handler({ toolName: "bash", input: { command: updateCommand } }, context(repository))).toMatchObject({
      reason: expect.stringContaining("OMP ask confirmation requested"),
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when API fields change, does not reuse detailed external approval", async () => {
  // Arrange
  const repository = checkout();
  const command = `gh api repos/${external}/issues --method POST -f title="Changed" -f body="Changed"`;
  try {
    const instance = guard();
    // Act / Assert
    instance.answer({
      toolName: "ask",
      input: {
        questions: [{
          id: "confirm_external_github_write",
          question: `Allow one GitHub issue creation in ${external}?\nIssue title: Original\nBody: Original`,
        }],
      },
      details: { selectedOptions: ["Approve"] },
      isError: false,
    });
    expect(await instance.handler({ toolName: "bash", input: { command } }, context(repository))).toMatchObject({ block: true });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when only intent changes, permits the approved write retry", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();
    const event = { toolName: "write", input: { i: "create issue", path: "xd://github", content: JSON.stringify({ op: "issue_create", repo: external, title: "Intent-independent issue" }) } };
    // Act / Assert
    await instance.handler(event, context(repository));
    approve(instance, "GitHub issue creation", external, "\nIssue title: Intent-independent issue");
    const retry = { toolName: "write", input: { ...event.input, i: "retry approved issue" } };
    const result = await instance.handler(retry, context(repository));
    expect(result).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when UI is unavailable, preserves approval for a later interactive retry", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();
    const event = { toolName: "write", input: { i: "create issue", path: "xd://github", content: JSON.stringify({ op: "issue_create", repo: external, title: "UI-bound issue" }) } };
    // Act / Assert
    await instance.handler(event, context(repository));
    approve(instance, "GitHub issue creation", external, "\nIssue title: UI-bound issue");
    await instance.handler(event, context(repository, false));
    await instance.handler(event, context(repository));
    const result = await instance.handler(event, context(repository));
    expect(result).toMatchObject({ block: true });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an approved payload changes, rejects the retry", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();
    const original = { toolName: "write", input: { i: "create issue", path: "xd://github", content: JSON.stringify({ op: "issue_create", repo: external, title: "Original issue" }) } };
    // Act / Assert
    await instance.handler(original, context(repository));
    approve(instance, "GitHub issue creation", external, "\nIssue title: Original issue");
    const changed = { toolName: "write", input: { ...original.input, i: "retry changed issue", content: JSON.stringify({ op: "issue_create", repo: external, title: "Changed issue" }) } };
    const result = await instance.handler(changed, context(repository));
    expect(result).toMatchObject({ reason: expect.stringContaining("does not match this exact retry") });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an approved destination changes, rejects the retry", async () => {
  // Arrange
  const repository = checkout();
  try {
    const instance = guard();
    const original = { toolName: "write", input: { i: "create issue", path: "xd://github", content: JSON.stringify({ op: "issue_create", repo: external, title: "Repository-bound issue" }) } };
    // Act / Assert
    await instance.handler(original, context(repository));
    approve(instance, "GitHub issue creation", external, "\nIssue title: Repository-bound issue");
    const changed = { toolName: "write", input: { ...original.input, i: "retry another repository", content: JSON.stringify({ op: "issue_create", repo: "elsewhere/other-example", title: "Repository-bound issue" }) } };
    const result = await instance.handler(changed, context(repository));
    expect(result).toMatchObject({ reason: expect.stringContaining("does not match this exact retry") });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
test("when body text names another target, confirms the API endpoint repository", async () => {
  // Arrange
  const repository = checkout();
  const target = "klondikemarlen/marlens-skills-rules-and-tools";
  const command = `gh api --method POST repos/${target}/issues -f title='Enforce PR Review Reactions Before Thread Resolution' -f body='Target repository: command/api' --jq '{number, html_url, title}'`;
  const event = { toolName: "bash", input: { command } };
  try {
    const instance = guard();
    // Act / Assert
    expect(await instance.handler(event, context(repository))).toMatchObject({ block: true });
    expect(instance.messages).toHaveLength(1);
    const message = instance.messages[0]!;
    const start = message.indexOf("{");
    const end = message.indexOf("}. If approved", start) + 1;
    const ask = JSON.parse(message.slice(start, end)) as { html: string };
    expect(ask.html).toContain(`\nTarget repository: ${target}`);
    expect(ask.html).not.toContain("\nTarget repository: command/api");
    approve(instance, "GitHub API write", target);
    expect(await instance.handler(event, context(repository))).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
const recoverableResults = [
  { name: "cancelled", details: { answers: [] }, isError: false },
  { name: "errored", details: nativeAskApproval.details, isError: true },
  { name: "timed out", details: { ...nativeAskApproval.details, timedOut: true }, isError: false },
  { name: "unsupported", details: { customInput: "Approve" }, isError: false },
];

for (const result of recoverableResults) {
  test(`when the confirmation result is ${result.name}, blocks and requests a fresh confirmation`, async () => {
    // Arrange
    const repository = checkout();
    const event = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title "Recovery"` } };
    try {
      const instance = guard();
      await instance.handler(event, context(repository));
      const message = instance.messages[0]!;
      const start = message.indexOf("{");
      const end = message.indexOf("}. If approved", start) + 1;
      const ask = JSON.parse(message.slice(start, end)) as Record<string, unknown>;
      // Act
      instance.answer({ toolName: "ask", input: ask, details: result.details, isError: result.isError });
      const retry = await instance.handler(event, context(repository));
      // Assert
      expect(retry).toMatchObject({ block: true, reason: expect.stringContaining("unsupported") });
      expect(instance.messages).toHaveLength(2);
      approve(instance, "GitHub issue creation", external);
      expect(await instance.handler(event, context(repository))).toBeUndefined();
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
}

test("when the confirmation is explicitly rejected, keeps the retry blocked", async () => {
  // Arrange
  const repository = checkout();
  const event = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title "Explicit rejection"` } };
  try {
    const instance = guard();
    expect(await instance.handler(event, context(repository))).toMatchObject({ block: true });
    const message = instance.messages[0]!;
    const start = message.indexOf("{");
    const end = message.indexOf("}. If approved", start) + 1;
    const ask = JSON.parse(message.slice(start, end)) as Record<string, unknown>;
    // Act
    instance.answer({ toolName: "ask", input: ask, details: { answers: [{ name: "confirm_repository_boundary_mutation", answer: "Reject" }] }, isError: false });

    const retry = await instance.handler(event, context(repository));
    // Assert
    expect(retry).toMatchObject({ reason: expect.stringContaining("previous confirmation was not approved") });
    expect(instance.messages).toHaveLength(1);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when external approval arrives after plugin reload, permits one matching write", async () => {
  // Arrange
  const repository = checkout();
  const event = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title "Reloaded"` } };
  try {
    const first = guard();
    // Act / Assert
    expect(await first.handler(event, context(repository))).toMatchObject({ block: true });
    const handoff = repositoryMutationHandoff(event, repository);
    if (handoff.decision !== "ask") throw new Error("missing confirmation handoff");
    const externalQuestion = handoff.question
      .split("\n")
      .filter((line) => !line.startsWith("Current repository:") && !line.startsWith("Target repository:"))
      .join("\n");

    const reloaded = guard();
    reloaded.answer({
      toolName: "ask",
      input: { questions: [{ id: "confirm_external_github_write", question: externalQuestion }] },
      details: { selectedOptions: ["Approve"] },
      isError: false,
    });
    expect(await reloaded.handler(event, context(repository))).toBeUndefined();
    expect(await reloaded.handler(event, context(repository))).toMatchObject({ block: true });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when the plugin reloads, discards its in-memory approval", async () => {
  // Arrange
  const repository = checkout();
  const event = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title "Not persisted"` } };
  try {
    const first = guard();
    // Act / Assert
    expect(await first.handler(event, context(repository))).toMatchObject({ block: true });
    approve(first, "GitHub issue creation", external);

    const reloaded = guard();
    expect(await reloaded.handler(event, context(repository))).toMatchObject({ block: true });
    expect(reloaded.messages).toHaveLength(1);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
