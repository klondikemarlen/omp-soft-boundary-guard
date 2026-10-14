import { rmSync } from "node:fs";

import { afterAll, expect, test } from "bun:test";

import { checkout, current } from "../extension/test-support.ts";
import { repositoryMutationHandoff } from "../../guard/handoff.ts";

const repository = checkout();

afterAll(() => rmSync(repository, { recursive: true, force: true }));

test("asks before a captured Python subprocess GitHub API write", () => {
  const code = `import subprocess
subprocess.run(["gh", "api", "--method", "POST", "repos/can1357/oh-my-pi/issues/6540/comments", "-F", "body=@-"], input=runtime_comment, check=True, capture_output=True, text=True)`;
  const handoff = repositoryMutationHandoff(
    { toolName: "eval", input: { language: "py", code } },
    repository,
  );

  expect(handoff).toMatchObject({
    decision: "ask",
    category: "github",
    action: "GitHub API write",
    target: "can1357/oh-my-pi",
    ask: {
      questions: [{ question: expect.stringContaining(`Code: ${code}`) }],
    },
  });
});

test("passes a captured Python read-only API request", () => {
  const code = `import subprocess
subprocess.run(["gh", "api", "repos/can1357/oh-my-pi/issues/6540/comments", "--method", "GET"])`;

  expect(repositoryMutationHandoff(
    { toolName: "eval", input: { language: "py", code } },
    repository,
  )).toMatchObject({ decision: "allow" });
});

test("passes a captured GitHub API write targeting the current repository", () => {
  const code = `import subprocess
subprocess.run(["gh", "api", "--method", "POST", "repos/klondikemarlen/omp-soft-boundary-guard/issues"])`;
  expect(repositoryMutationHandoff(
    { toolName: "eval", input: { language: "py", code } },
    repository,
  )).toMatchObject({
    decision: "allow",
    action: "GitHub API write",
    currentRepository: current,
    target: current,
  });
});

test("passes malformed Python instead of classifying a partial call", () => {
  const code = `import subprocess
subprocess.run(["gh", "api", "repos/can1357/oh-my-pi/issues/6540/comments", "--method", "POST"`;

  expect(repositoryMutationHandoff(
    { toolName: "eval", input: { language: "py", code } },
    repository,
  )).toMatchObject({ decision: "allow" });
});

test("passes a subprocess call with a dynamic API endpoint", () => {
  const code = `import subprocess
subprocess.run(["gh", "api", endpoint, "--method", "POST"])`;

  expect(repositoryMutationHandoff(
    { toolName: "eval", input: { language: "py", code } },
    repository,
  )).toMatchObject({ decision: "allow" });
});

test("does not split adjacent Python string literals into separate argv values", () => {
  const code = `import subprocess
subprocess.run(["gh" "api", "repos/can1357/oh-my-pi/issues", "--method", "POST"])`;

  expect(repositoryMutationHandoff(
    { toolName: "eval", input: { language: "py", code } },
    repository,
  )).toMatchObject({ decision: "allow" });
});

test("does not treat Python comments or string contents as subprocess calls", () => {
  const code = `# subprocess.run(["gh", "api", "repos/can1357/oh-my-pi/issues", "--method", "POST"])
example = "subprocess.run(['gh', 'api'])"`;

  expect(repositoryMutationHandoff(
    { toolName: "eval", input: { language: "py", code } },
    repository,
  )).toMatchObject({ decision: "allow" });
});

test("leaves multiple captured GitHub writes unresolved", () => {
  const code = `import subprocess
subprocess.run(["gh", "api", "--method", "POST", "repos/first/repository/issues"])
subprocess.run(["gh", "api", "--method", "POST", "repos/second/repository/issues"])`;

  expect(repositoryMutationHandoff(
    { toolName: "eval", input: { language: "py", code } },
    repository,
  )).toMatchObject({ decision: "allow", action: "GitHub write" });
});
