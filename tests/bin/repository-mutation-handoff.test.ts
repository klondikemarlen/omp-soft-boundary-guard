import { execFileSync } from "node:child_process";
import { expect, test } from "bun:test";

const current = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" })
  .trim()
  .replace(/^.*github\.com[/:]/i, "")
  .replace(/\.git$/, "")
  .toLowerCase();
const external = "elsewhere/example";

function handoff(command: string) {
  const result = Bun.spawnSync({
    cmd: ["bun", "bin/repository-mutation-handoff.ts"],
    stdin: new TextEncoder().encode(JSON.stringify({ event: { toolName: "bash", input: { command } } })),
    stdout: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

test("when a command mutates another repository, prints its approval decision", () => {
  // Arrange: use the current checkout and an explicit external target.
  // Act / Assert
  expect(handoff("git push origin HEAD")).toMatchObject({ decision: "allow", target: current });
  expect(handoff(`git push https://github.com/${external}.git HEAD`)).toMatchObject({
    decision: "ask",
    target: external,
    questionId: "confirm_repository_boundary_mutation",
    ask: { html: expect.any(String) },
  });
  expect(handoff('gh issue create --repo "$TARGET"')).toMatchObject({ decision: "allow" });
  expect(handoff("git status --short")).toMatchObject({ decision: "allow" });
});
