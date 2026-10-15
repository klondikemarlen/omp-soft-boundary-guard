import { rmSync } from "node:fs";

import { expect, test } from "bun:test";

import { repositoryMutationHandoff } from "../../guard/handoff.ts";
import { checkout } from "../extension/test-support.ts";

test("does not hide an external local Git mutation behind an owned release", () => {
  const repository = checkout();
  const outside = checkout("https://github.com/elsewhere/example.git");
  try {
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
