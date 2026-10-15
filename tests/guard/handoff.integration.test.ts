import { rmSync } from "node:fs";

import { expect, test } from "bun:test";

import { repositoryMutationHandoff } from "../../guard/handoff.ts";
import { checkout } from "../extension/test-support.ts";

test("when a release command mutates another local Git repository, the handoff is not hidden", () => {
  // Arrange: create the owned and external checkout fixtures.
  const repository = checkout();
  const outside = checkout("https://github.com/elsewhere/example.git");

  try {

    // Act / Assert
    expect(repositoryMutationHandoff({
      toolName: "bash",
      input: { command: `npm run release && git -C ${outside} switch -c audit-branch` },
    }, repository)).toMatchObject({
      decision: "ask",
      category: "local",
      action: "git mutation",
      target: outside,
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
