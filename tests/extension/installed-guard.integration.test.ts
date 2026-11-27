import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { activateReviewedPolicy, createPolicyState, reviewPolicy } from "../../index.ts";
import {
  checkout,
  checkoutOutsideTemporaryDirectory,
  confirmationId,
  context,
  current,
  external,
  installedGuard,
  type Guard,
} from "./test-support.ts";

type AskPayload = { html: string };

function askPayload(instance: Guard): AskPayload {
  const message = instance.messages.at(-1);
  if (!message) {
    throw new Error("missing confirmation request");
  }

  const start = message.indexOf("{");
  const end = message.indexOf("}. If approved", start) + 1;
  return JSON.parse(message.slice(start, end)) as AskPayload;
}

function answer(instance: Guard, selection: "Approve" | "Reject"): void {
  instance.answer({
    toolName: "ask",
    input: askPayload(instance),
    details: {
      answers: [
        {
          name: confirmationId,
          answer: selection,
        },
      ],
    },
    isError: false,
  });
}

const reviewedPolicy = activateReviewedPolicy(reviewPolicy(createPolicyState({
  name: "same-boundary",
  positive: "current checkout",
  negative: "external repository",
}))).active!;

const upstream = "upstream-project/issue-tracker";
const repositoryLookup = {
  toolName: "bash",
  input: { command: "gh repo view --json nameWithOwner" },
};

function pythonIssue(body: string) {
  return {
    toolName: "bash",
    input: {
      command: `python3 - <<'PY'
import subprocess
title = "Review fixture"
body = "${body}"
subprocess.check_output(["gh", "issue", "create", "--repo", "${upstream}", "--title", title, "--label", "bug", "--body", body], text=True)
PY`,
    },
  };
}

describe("installed default GitHub enforcement", () => {
  let repository: string;

  beforeEach(() => {
    repository = checkout();
  });

  afterEach(() => {
    rmSync(repository, { recursive: true, force: true });
  });

  describe("checkout with a distinct upstream", () => {
    beforeEach(() => {
      execFileSync("git", ["-C", repository, "remote", "add", "upstream", `https://github.com/${upstream}.git`]);
    });

    test("when gh looks up the repository without writing, allows the lookup", async () => {
      // Arrange
      const instance = installedGuard();

      // Act / Assert
      expect(await instance.handler(repositoryLookup, context(repository))).toBeUndefined();
    });

    test("when a Python heredoc creates an upstream issue after a read-only lookup, blocks it for confirmation", async () => {
      // Arrange
      const instance = installedGuard();
      const event = pythonIssue("Original body");
      await instance.handler(repositoryLookup, context(repository));

      // Act / Assert
      expect(await instance.handler(event, context(repository))).toMatchObject({
        block: true,
        reason: expect.stringContaining(`Blocked GitHub issue creation targeting ${upstream}: confirmation is required.`),
      });
    });

    test("when a Python heredoc creates an upstream issue after a read-only lookup, shows origin and upstream separately in Ask", async () => {
      // Arrange
      const instance = installedGuard();
      const event = pythonIssue("Original body");
      await instance.handler(repositoryLookup, context(repository));

      // Act
      await instance.handler(event, context(repository));

      // Assert
      expect(askPayload(instance).html).toContain(`Current repository: ${current}\nTarget repository: ${upstream}`);
    });

    test("when the revised upstream Python issue is declined, keeps the exact retry blocked without requesting approval again", async () => {
      // Arrange
      const instance = installedGuard();
      const original = pythonIssue("Original body");
      const revised = pythonIssue("Changed body");
      await instance.handler(original, context(repository));
      answer(instance, "Approve");
      await instance.handler(revised, context(repository));
      answer(instance, "Reject");

      // Act / Assert
      expect(await instance.handler(revised, context(repository))).toMatchObject({
        block: true,
        reason: expect.stringContaining("The previous confirmation was not approved; no duplicate confirmation was requested."),
      });
    });

    test("when the upstream Python issue is approved, allows the exact heredoc retry", async () => {
      // Arrange
      const instance = installedGuard();
      const event = pythonIssue("Original body");
      await instance.handler(event, context(repository));
      answer(instance, "Approve");

      // Act / Assert
      expect(await instance.handler(event, context(repository))).toBeUndefined();
    });

    test("when the upstream Python issue uses its approval, blocks a second identical retry for fresh confirmation", async () => {
      // Arrange
      const instance = installedGuard();
      const event = pythonIssue("Original body");
      await instance.handler(event, context(repository));
      answer(instance, "Approve");
      await instance.handler(event, context(repository));

      // Act / Assert
      expect(await instance.handler(event, context(repository))).toMatchObject({
        block: true,
        reason: expect.stringContaining("OMP ask confirmation requested."),
      });
    });

    test("when an approved Python issue changes its body assignment, blocks it for fresh confirmation", async () => {
      // Arrange
      const instance = installedGuard();
      const original = pythonIssue("Original body");
      const revised = pythonIssue("Changed body");
      await instance.handler(original, context(repository));
      answer(instance, "Approve");

      // Act / Assert
      expect(await instance.handler(revised, context(repository))).toMatchObject({
        block: true,
        reason: expect.stringContaining("OMP ask confirmation requested."),
      });
    });

    test("when an approved Python issue changes its body assignment, requests approval showing the changed heredoc", async () => {
      // Arrange
      const instance = installedGuard();
      const original = pythonIssue("Original body");
      const changed = pythonIssue("Changed body");
      await instance.handler(original, context(repository));
      answer(instance, "Approve");

      // Act
      await instance.handler(changed, context(repository));

      // Assert
      expect(askPayload(instance).html).toContain(`Command: ${Bun.escapeHTML(changed.input.command)}`);
    });

    test("when gh issue create omits --repo and gh defaults to upstream, blocks the implicit external destination", async () => {
      // Arrange
      execFileSync("git", ["-C", repository, "config", "--local", "remote.upstream.gh-resolved", "base"]);
      const instance = installedGuard();
      const event = {
        toolName: "bash",
        input: { command: "GH_REPO= GH_HOST=github.com gh issue create --title 'Default destination' --body 'Issue details'" },
      };

      // Act / Assert
      expect(await instance.handler(event, context(repository))).toMatchObject({
        block: true,
        reason: expect.stringContaining(`Blocked GitHub issue creation targeting ${upstream}: confirmation is required.`),
      });
    });
  });

  describe("external GitHub API writes", () => {
    const issue = {
      toolName: "bash",
      input: { command: `gh api --method POST repos/${external}/issues -f title='External issue' -f body='Issue details'` },
    };

    test("when an external GitHub API write is requested, blocks it for confirmation", async () => {
      // Arrange
      const instance = installedGuard();

      // Act / Assert
      expect(await instance.handler(issue, context(repository))).toMatchObject({
        block: true,
        reason: expect.stringContaining("OMP ask confirmation requested."),
      });
    });

    test("when an external GitHub API write is approved, allows the exact retry", async () => {
      // Arrange
      const instance = installedGuard();
      await instance.handler(issue, context(repository));
      answer(instance, "Approve");

      // Act / Assert
      expect(await instance.handler(issue, context(repository))).toBeUndefined();
    });

    test("when an external GitHub API write uses its approval, requires fresh confirmation on a second identical retry", async () => {
      // Arrange
      const instance = installedGuard();
      await instance.handler(issue, context(repository));
      answer(instance, "Approve");
      await instance.handler(issue, context(repository));

      // Act / Assert
      expect(await instance.handler(issue, context(repository))).toMatchObject({
        block: true,
        reason: expect.stringContaining("OMP ask confirmation requested."),
      });
    });

    test("when an approved API write changes its payload, requests fresh confirmation", async () => {
      // Arrange
      const instance = installedGuard();
      const changed = {
        toolName: "bash",
        input: { command: `gh api --method POST repos/${external}/issues -f title='External issue' -f body='Changed body'` },
      };
      await instance.handler(issue, context(repository));
      answer(instance, "Approve");

      // Act / Assert
      expect(await instance.handler(changed, context(repository))).toMatchObject({
        block: true,
        reason: expect.stringContaining("OMP ask confirmation requested."),
      });
    });

    test("when an approved API write changes its destination, requests fresh confirmation for the new target", async () => {
      // Arrange
      const instance = installedGuard();
      const changed = {
        toolName: "bash",
        input: { command: "gh api --method POST repos/elsewhere/another-example/issues -f title='External issue' -f body='Issue details'" },
      };
      await instance.handler(issue, context(repository));
      answer(instance, "Approve");

      // Act / Assert
      expect(await instance.handler(changed, context(repository))).toMatchObject({
        block: true,
        reason: expect.stringMatching(/^Blocked GitHub API write targeting elsewhere\/another-example:.*OMP ask confirmation requested\.$/),
      });
    });
  });

  test("when a compound release command also creates an external issue, blocks the GitHub write", async () => {
    // Arrange
    const instance = installedGuard();
    const event = {
      toolName: "bash",
      input: { command: `npm run release -- --repo elsewhere/release && gh issue create --repo ${external} --title audit --body audit` },
    };

    // Act / Assert
    expect(await instance.handler(event, context(repository))).toMatchObject({
      block: true,
      reason: expect.stringContaining(`Blocked GitHub issue creation targeting ${external}: confirmation is required.`),
    });
  });

  test("when an external gh issue creation is declined, keeps the exact retry blocked", async () => {
    // Arrange
    const instance = installedGuard();
    const event = {
      toolName: "bash",
      input: { command: `gh issue create --repo ${external} --title 'Declined issue'` },
    };
    await instance.handler(event, context(repository));
    answer(instance, "Reject");

    // Act / Assert
    expect(await instance.handler(event, context(repository))).toMatchObject({
      block: true,
      reason: expect.stringContaining("The previous confirmation was not approved; no duplicate confirmation was requested."),
    });
  });

  describe("external xd GitHub publication", () => {
    const issue = {
      toolName: "write",
      input: {
        path: "xd://github",
        content: JSON.stringify({
          op: "issue_create",
          repo: external,
          title: "External device issue",
        }),
      },
    };

    test("when an external xd GitHub publication is requested, blocks it for confirmation", async () => {
      // Arrange
      const instance = installedGuard();

      // Act / Assert
      expect(await instance.handler(issue, context(repository))).toMatchObject({
        block: true,
        reason: expect.stringContaining("OMP ask confirmation requested."),
      });
    });

    test("when an external xd GitHub publication is approved, allows the exact retry", async () => {
      // Arrange
      const instance = installedGuard();
      await instance.handler(issue, context(repository));
      answer(instance, "Approve");

      // Act / Assert
      expect(await instance.handler(issue, context(repository))).toBeUndefined();
    });
  });

  const sameBoundaryIssue = {
    toolName: "bash",
    input: { command: `gh issue create --repo ${current} --title 'Internal issue'` },
  };

  test("when a GitHub write targets the same boundary, allows it", async () => {
    // Arrange
    const instance = installedGuard();

    // Act / Assert
    expect(await instance.handler(sameBoundaryIssue, context(repository))).toBeUndefined();
  });

  test("when a GitHub write targets the same boundary, sends no confirmation request", async () => {
    // Arrange
    const instance = installedGuard();

    // Act
    await instance.handler(sameBoundaryIssue, context(repository));

    // Assert
    expect(instance.messages).toEqual([]);
  });

  describe("same-boundary writes classified as outside by policy", () => {
    const boundaryClassifier = async () => ({
      classification: "outside" as const,
      risk: "high" as const,
      reason: "policy classification is advisory for installed GitHub enforcement",
    });

    test("when policy classifies a same-boundary GitHub write as outside, allows it", async () => {
      // Arrange
      const instance = installedGuard();
      const policyContext = {
        ...context(repository),
        boundaryPolicy: reviewedPolicy,
        boundaryClassifier,
      };

      // Act / Assert
      expect(await instance.handler(sameBoundaryIssue, policyContext)).toBeUndefined();
    });

    test("when policy classifies a same-boundary GitHub write as outside, warns that it will proceed", async () => {
      // Arrange
      const instance = installedGuard();
      const policyContext = {
        ...context(repository),
        boundaryPolicy: reviewedPolicy,
        boundaryClassifier,
      };
      const warn = spyOn(console, "warn").mockImplementation(() => {});

      try {
        // Act
        await instance.handler(sameBoundaryIssue, policyContext);

        // Assert
        expect(warn).toHaveBeenCalledWith(`Soft boundary warning: GitHub issue creation targets ${current}. The operation will proceed.`);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("external local writes", () => {
    let otherRepository: string;

    beforeEach(() => {
      otherRepository = checkoutOutsideTemporaryDirectory(null);
    });

    afterEach(() => {
      rmSync(otherRepository, { recursive: true, force: true });
    });

    test("when a file write targets another checkout, allows it", async () => {
      // Arrange
      const instance = installedGuard();
      const event = {
        toolName: "write",
        input: {
          path: `${otherRepository}/outside.ts`,
          content: "",
        },
      };

      // Act / Assert
      expect(await instance.handler(event, context(repository))).toBeUndefined();
    });

    test("when a file write targets another checkout, warns that it will proceed", async () => {
      // Arrange
      const instance = installedGuard();
      const path = `${otherRepository}/outside.ts`;
      const event = {
        toolName: "write",
        input: {
          path,
          content: "",
        },
      };
      const warn = spyOn(console, "warn").mockImplementation(() => {});

      try {
        // Act
        await instance.handler(event, context(repository));

        // Assert
        expect(warn).toHaveBeenCalledWith(`Soft boundary warning: file write targets ${path}. The operation will proceed.`);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("unavailable approval UI", () => {
    const issue = {
      toolName: "bash",
      input: { command: `gh issue create --repo ${external} --title 'No UI issue'` },
    };

    test("when UI is unavailable for an external issue, fails open", async () => {
      // Arrange
      const instance = installedGuard();

      // Act / Assert
      expect(await instance.handler(issue, context(repository, false))).toBeUndefined();
    });

    test("when UI is unavailable for an external issue, reports why confirmation was skipped", async () => {
      // Arrange
      const instance = installedGuard();
      const warn = spyOn(console, "warn").mockImplementation(() => {});

      try {
        // Act
        await instance.handler(issue, context(repository, false));

        // Assert
        expect(warn).toHaveBeenCalledWith(`Soft boundary fail-open: approval UI unavailable for GitHub issue creation targeting ${external}.`);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("malformed GitHub input", () => {
    const event = {
      toolName: "write",
      input: {
        path: "xd://github",
        content: "{ malformed",
      },
    };

    test("when GitHub input is malformed, passes it through", async () => {
      // Arrange
      const instance = installedGuard();

      // Act / Assert
      expect(await instance.handler(event, context(repository))).toBeUndefined();
    });

    test("when GitHub input is malformed, sends no confirmation request", async () => {
      // Arrange
      const instance = installedGuard();

      // Act
      await instance.handler(event, context(repository));

      // Assert
      expect(instance.messages).toEqual([]);
    });
  });

  describe("failed confirmation delivery", () => {
    const issue = {
      toolName: "bash",
      input: { command: `gh issue create --repo ${external} --title 'Delivery error issue'` },
    };

    test("when confirmation delivery throws, fails open", async () => {
      // Arrange
      const instance = installedGuard(() => {
        throw new Error("confirmation delivery unavailable");
      });

      // Act / Assert
      expect(await instance.handler(issue, context(repository))).toBeUndefined();
    });

    test("when confirmation delivery recovers, requests fresh confirmation on retry", async () => {
      // Arrange
      let deliveryUnavailable = true;
      const instance = installedGuard(() => {
        if (deliveryUnavailable) {
          throw new Error("confirmation delivery unavailable");
        }
      });
      await instance.handler(issue, context(repository));
      deliveryUnavailable = false;

      // Act / Assert
      expect(await instance.handler(issue, context(repository))).toMatchObject({
        block: true,
        reason: expect.stringContaining("OMP ask confirmation requested."),
      });
    });
  });
});
