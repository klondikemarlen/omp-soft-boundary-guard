import { mkdirSync, rmSync } from "node:fs";

import { expect, test } from "bun:test";

import type { ToolCallEvent } from "../../extension/contract.ts";
import { nativeAskApproval } from "./native-ask-fixture.ts";
import { answerConfirmation, checkout, context, external, guard, requestedAsk, type Guard } from "./test-support.ts";

import { repositoryMutationHandoff } from "../../guard/handoff.ts";

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
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when another HTML form is approved, does not reissue the original prompt", async () => {
  // Arrange
  const repository = checkout();
  const instance = guard();
  const event = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title "Unrelated approval"` } };
  try {
    await instance.handler(event, context(repository));
    const originalPrompt = instance.messages[0];

    // Act
    instance.answer(nativeAskApproval);
    await instance.handler(event, context(repository));

    // Assert
    expect(instance.messages).toEqual([originalPrompt]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when the native form has not yet been approved, blocks issue creation", async () => {
  // Arrange
  const repository = checkout();
  const instance = guard();
  const event = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title "Approved locally"` } };
  try {
    // Act / Assert
    expect(await instance.handler(event, context(repository))).toMatchObject({
      block: true,
      reason: expect.stringContaining("OMP ask confirmation requested"),
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when the native form result approves issue creation, permits the matching retry", async () => {
  // Arrange
  const repository = checkout();
  const event = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title "Approved locally"` } };
  try {
    const instance = guard();
    await instance.handler(event, context(repository));
    // Replay the native result against the requested HTML, not the capture's unrelated form.
    const ask = requestedAsk(instance.messages[0]);
    instance.answer({ ...nativeAskApproval, input: ask });

    // Act / Assert
    expect(await instance.handler(event, context(repository))).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when the matching retry consumes native approval, blocks the next issue creation", async () => {
  // Arrange
  const repository = checkout();
  const instance = guard();
  const event = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title "Approved locally"` } };
  try {
    await instance.handler(event, context(repository));
    const ask = requestedAsk(instance.messages[0]);
    instance.answer({ ...nativeAskApproval, input: ask });
    await instance.handler(event, context(repository));

    // Act / Assert
    expect(await instance.handler(event, context(repository))).toMatchObject({
      block: true,
      reason: expect.stringContaining("OMP ask confirmation requested"),
    });
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
    await instance.handler(event, context(repository));
    answerConfirmation(instance, "Approve");

    // Act / Assert
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

test("when external approval precedes the first tool call, permits the matching API write", async () => {
  // Arrange
  const repository = checkout();
  const command = `gh api --method PATCH repos/${external}/issues/6458 -f body="$ISSUE_BODY" --jq .html_url`;
  try {
    const instance = guard();
    recordExternalApproval(instance, `Allow one GitHub API write to ${external}?\nCommand: ${command}`);

    // Act / Assert
    expect(await instance.handler({ toolName: "bash", input: { command } }, context(repository))).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when the first API write consumes early external approval, blocks the next write", async () => {
  // Arrange
  const repository = checkout();
  const command = `gh api --method PATCH repos/${external}/issues/6458 -f body="$ISSUE_BODY" --jq .html_url`;
  const event = { toolName: "bash", input: { command } };
  try {
    const instance = guard();
    recordExternalApproval(instance, `Allow one GitHub API write to ${external}?\nCommand: ${command}`);
    await instance.handler(event, context(repository));

    // Act / Assert
    expect(await instance.handler(event, context(repository))).toMatchObject({
      block: true,
      reason: expect.stringContaining("OMP ask confirmation requested"),
    });
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
  const update = { toolName: "bash", input: { command: `gh api repos/${external}/issues/12 --method PATCH -f body="Changed"` } };
  try {
    const instance = guard();
    recordExternalApproval(instance, `Allow one GitHub issue creation in ${external}?`);

    // Act / Assert
    expect(await instance.handler(update, context(repository))).toMatchObject({
      block: true,
      reason: expect.stringContaining("OMP ask confirmation requested"),
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a blocked API update does not match creation approval, still permits the approved creation", async () => {
  // Arrange
  const repository = checkout();
  const update = { toolName: "bash", input: { command: `gh api repos/${external}/issues/12 --method PATCH -f body="Changed"` } };
  const create = { toolName: "bash", input: { command: `gh api repos/${external}/issues --method POST -f title="Created" -f body="Body"` } };
  try {
    const instance = guard();
    recordExternalApproval(instance, `Allow one GitHub issue creation in ${external}?`);
    await instance.handler(update, context(repository));

    // Act / Assert
    expect(await instance.handler(create, context(repository))).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an approved creation clears a pending API update, requests fresh confirmation for the update", async () => {
  // Arrange
  const repository = checkout();
  const update = { toolName: "bash", input: { command: `gh api repos/${external}/issues/12 --method PATCH -f body="Changed"` } };
  const create = { toolName: "bash", input: { command: `gh api repos/${external}/issues --method POST -f title="Created" -f body="Body"` } };
  try {
    const instance = guard();
    recordExternalApproval(instance, `Allow one GitHub issue creation in ${external}?`);
    await instance.handler(update, context(repository));
    await instance.handler(create, context(repository));

    // Act / Assert
    expect(await instance.handler(update, context(repository))).toMatchObject({
      block: true,
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
    answerConfirmation(instance, "Approve");
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
    await instance.handler(event, context(repository));
    answerConfirmation(instance, "Approve");
    await instance.handler(event, context(repository, false));

    // Act / Assert
    expect(await instance.handler(event, context(repository))).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when an interactive retry consumes approval after a headless attempt, blocks the next interactive retry", async () => {
  // Arrange
  const repository = checkout();
  const instance = guard();
  const event = { toolName: "write", input: { i: "create issue", path: "xd://github", content: JSON.stringify({ op: "issue_create", repo: external, title: "UI-bound issue" }) } };
  try {
    await instance.handler(event, context(repository));
    answerConfirmation(instance, "Approve");
    await instance.handler(event, context(repository, false));
    await instance.handler(event, context(repository));

    // Act / Assert
    expect(await instance.handler(event, context(repository))).toMatchObject({
      block: true,
      reason: expect.stringContaining("OMP ask confirmation requested"),
    });
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
    answerConfirmation(instance, "Approve");
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
    answerConfirmation(instance, "Approve");
    const changed = { toolName: "write", input: { ...original.input, i: "retry another repository", content: JSON.stringify({ op: "issue_create", repo: "elsewhere/other-example", title: "Repository-bound issue" }) } };
    const result = await instance.handler(changed, context(repository));
    expect(result).toMatchObject({ reason: expect.stringContaining("does not match this exact retry") });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

const endpointRepository = "klondikemarlen/marlens-skills-rules-and-tools";
const issueWithRepositoryInBody = {
  toolName: "bash",
  input: {
    command: `gh api --method POST repos/${endpointRepository}/issues -f title='Enforce PR Review Reactions Before Thread Resolution' -f body='Target repository: command/api' --jq '{number, html_url, title}'`,
  },
};

test("when body text names another target, blocks the external API write pending confirmation", async () => {
  // Arrange
  const repository = checkout();
  const instance = guard();
  try {
    // Act / Assert
    expect(await instance.handler(issueWithRepositoryInBody, context(repository))).toMatchObject({
      block: true,
      reason: expect.stringContaining("OMP ask confirmation requested"),
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when body text names another target, confirms the API endpoint repository", async () => {
  // Arrange
  const repository = checkout();
  const instance = guard();
  try {
    // Act
    await instance.handler(issueWithRepositoryInBody, context(repository));
    const ask = requestedAsk(instance.messages[0]);

    // Assert
    expect(ask.html.match(/^Target repository: .+$/gm)).toEqual([`Target repository: ${endpointRepository}`]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when body text names another target, requests confirmation only once", async () => {
  // Arrange
  const repository = checkout();
  const instance = guard();
  try {
    // Act
    await instance.handler(issueWithRepositoryInBody, context(repository));

    // Assert
    expect(instance.deliveries).toEqual(["steer"]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when the endpoint repository is approved despite a different target in the body, permits the API write", async () => {
  // Arrange
  const repository = checkout();
  const instance = guard();
  try {
    await instance.handler(issueWithRepositoryInBody, context(repository));
    answerConfirmation(instance, "Approve");

    // Act / Assert
    expect(await instance.handler(issueWithRepositoryInBody, context(repository))).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

const recoverableIssue = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title "Recovery"` } };
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
    try {
      const instance = guard();
      await instance.handler(recoverableIssue, context(repository));
      const ask = requestedAsk(instance.messages[0]);
      instance.answer({ toolName: "ask", input: ask, details: result.details, isError: result.isError });

      // Act / Assert
      expect(await instance.handler(recoverableIssue, context(repository))).toMatchObject({
        block: true,
        reason: expect.stringContaining("timed out, or unsupported; no approval was recorded. A new confirmation is required. OMP ask confirmation requested."),
      });
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test(`when the confirmation result is ${result.name}, delivers one fresh prompt on retry`, async () => {
    // Arrange
    const repository = checkout();
    try {
      const instance = guard();
      await instance.handler(recoverableIssue, context(repository));
      const originalPrompt = instance.messages[0];
      const ask = requestedAsk(originalPrompt);
      instance.answer({ toolName: "ask", input: ask, details: result.details, isError: result.isError });

      // Act
      await instance.handler(recoverableIssue, context(repository));

      // Assert
      expect(instance.messages).toEqual([originalPrompt, originalPrompt]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test(`when a fresh prompt replaces a ${result.name} confirmation result, permits the retry after approval`, async () => {
    // Arrange
    const repository = checkout();
    try {
      const instance = guard();
      await instance.handler(recoverableIssue, context(repository));
      const ask = requestedAsk(instance.messages[0]);
      instance.answer({ toolName: "ask", input: ask, details: result.details, isError: result.isError });
      await instance.handler(recoverableIssue, context(repository));
      const freshAsk = requestedAsk(instance.messages[1]);
      instance.answer({ ...nativeAskApproval, input: freshAsk });

      // Act / Assert
      expect(await instance.handler(recoverableIssue, context(repository))).toBeUndefined();
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
    await instance.handler(event, context(repository));
    const ask = requestedAsk(instance.messages[0]);
    instance.answer({ toolName: "ask", input: ask, details: { answers: [{ name: "confirm_repository_boundary_mutation", answer: "Reject" }] }, isError: false });

    // Act / Assert
    expect(await instance.handler(event, context(repository))).toMatchObject({
      block: true,
      reason: expect.stringContaining("previous confirmation was not approved"),
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when the confirmation is explicitly rejected, does not issue a second prompt on retry", async () => {
  // Arrange
  const repository = checkout();
  const instance = guard();
  const event = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title "Explicit rejection"` } };
  try {
    await instance.handler(event, context(repository));
    const originalPrompt = instance.messages[0];
    const ask = requestedAsk(originalPrompt);
    instance.answer({ toolName: "ask", input: ask, details: { answers: [{ name: "confirm_repository_boundary_mutation", answer: "Reject" }] }, isError: false });

    // Act
    await instance.handler(event, context(repository));

    // Assert
    expect(instance.messages).toEqual([originalPrompt]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when external approval arrives after plugin reload, permits the matching write", async () => {
  // Arrange
  const repository = checkout();
  const event = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title "Reloaded"` } };
  try {
    const first = guard();
    await first.handler(event, context(repository));
    const question = externalQuestionFor(event, repository);
    const reloaded = guard();
    recordExternalApproval(reloaded, question);

    // Act / Assert
    expect(await reloaded.handler(event, context(repository))).toBeUndefined();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a matching write consumes post-reload external approval, blocks the next write", async () => {
  // Arrange
  const repository = checkout();
  const event = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title "Reloaded"` } };
  try {
    const first = guard();
    await first.handler(event, context(repository));
    const question = externalQuestionFor(event, repository);
    const reloaded = guard();
    recordExternalApproval(reloaded, question);
    await reloaded.handler(event, context(repository));

    // Act / Assert
    expect(await reloaded.handler(event, context(repository))).toMatchObject({
      block: true,
      reason: expect.stringContaining("OMP ask confirmation requested"),
    });
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
    await first.handler(event, context(repository));
    answerConfirmation(first, "Approve");

    const reloaded = guard();
    // Act / Assert
    expect(await reloaded.handler(event, context(repository))).toMatchObject({
      block: true,
      reason: expect.stringContaining("OMP ask confirmation requested"),
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("when a locally approved invocation is retried after reload, sends one new approval prompt", async () => {
  // Arrange
  const repository = checkout();
  const event = { toolName: "bash", input: { command: `gh issue create --repo ${external} --title "Not persisted"` } };
  try {
    const first = guard();
    await first.handler(event, context(repository));
    answerConfirmation(first, "Approve");
    const reloaded = guard();

    // Act
    await reloaded.handler(event, context(repository));

    // Assert
    expect(reloaded.messages).toEqual([
      expect.stringContaining(`Target repository: ${external}`),
    ]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

function recordExternalApproval(instance: Guard, question: string): void {
  instance.answer({
    toolName: "ask",
    input: { questions: [{ id: "confirm_external_github_write", question }] },
    details: { selectedOptions: ["Approve"] },
    isError: false,
  });
}

function externalQuestionFor(event: ToolCallEvent, repository: string): string {
  const handoff = repositoryMutationHandoff(event, repository);
  if (handoff.decision !== "ask") {
    throw new Error("missing confirmation handoff");
  }

  return handoff.question
    .split("\n")
    .filter((line) => !line.startsWith("Current repository:") && !line.startsWith("Target repository:"))
    .join("\n");
}
