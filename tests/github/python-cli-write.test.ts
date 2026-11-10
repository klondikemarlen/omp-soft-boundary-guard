import { rmSync } from "node:fs";

import { afterAll, expect, test } from "bun:test";

import { checkout, current } from "../extension/test-support.ts";
import { repositoryMutationHandoff } from "../../guard/handoff.ts";

const repository = checkout();

afterAll(() => rmSync(repository, { recursive: true, force: true }));

test("when Python invokes an external GitHub write, asks before execution", () => {
  // Arrange
  const code = `import subprocess
subprocess.run(["gh", "api", "--method", "POST", "repos/can1357/oh-my-pi/issues/6540/comments", "-F", "body=@-"], input=runtime_comment, check=True, capture_output=True, text=True)`;
  // Act
  const handoff = repositoryMutationHandoff(
    { toolName: "eval", input: { language: "py", code } },
    repository,
  );

  // Assert
  expect(handoff).toMatchObject({
    decision: "ask",
    category: "github",
    action: "GitHub API write",
    target: "can1357/oh-my-pi",
    question: expect.stringContaining(`Code: ${code}`),
  });
});

test("when Python invokes a read-only API request, allows execution", () => {
  // Arrange
  const code = `import subprocess
subprocess.run(["gh", "api", "repos/can1357/oh-my-pi/issues/6540/comments", "--method", "GET"])`;

  // Act / Assert
  expect(repositoryMutationHandoff(
    { toolName: "eval", input: { language: "py", code } },
    repository,
  )).toMatchObject({ decision: "allow" });
});

test("when Python targets the current repository, allows the API write", () => {
  // Arrange
  const code = `import subprocess
subprocess.run(["gh", "api", "--method", "POST", "repos/klondikemarlen/omp-soft-boundary-guard/issues"])`;
  // Act / Assert
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

test("when Python is malformed, leaves the partial call unresolved", () => {
  // Arrange
  const code = `import subprocess
subprocess.run(["gh", "api", "repos/can1357/oh-my-pi/issues/6540/comments", "--method", "POST"`;

  // Act / Assert
  expect(repositoryMutationHandoff(
    { toolName: "eval", input: { language: "py", code } },
    repository,
  )).toMatchObject({ decision: "allow" });
});

test("when Python uses a dynamic endpoint, leaves the call unresolved", () => {
  // Arrange
  const code = `import subprocess
subprocess.run(["gh", "api", endpoint, "--method", "POST"])`;

  // Act / Assert
  expect(repositoryMutationHandoff(
    { toolName: "eval", input: { language: "py", code } },
    repository,
  )).toMatchObject({ decision: "allow" });
});

test("when Python has adjacent string literals, does not split argv values", () => {
  // Arrange
  const code = `import subprocess
subprocess.run(["gh" "api", "repos/can1357/oh-my-pi/issues", "--method", "POST"])`;

  // Act / Assert
  expect(repositoryMutationHandoff(
    { toolName: "eval", input: { language: "py", code } },
    repository,
  )).toMatchObject({ decision: "allow" });
});

test("when subprocess text is in comments or strings, does not classify it as a call", () => {
  // Arrange
  const code = `# subprocess.run(["gh", "api", "repos/can1357/oh-my-pi/issues", "--method", "POST"])
example = "subprocess.run(['gh', 'api'])"`;

  // Act / Assert
  expect(repositoryMutationHandoff(
    { toolName: "eval", input: { language: "py", code } },
    repository,
  )).toMatchObject({ decision: "allow" });
});

test("when Python invokes multiple GitHub writes, leaves the target unresolved", () => {
  // Arrange
  const code = `import subprocess
subprocess.run(["gh", "api", "--method", "POST", "repos/first/repository/issues"])
subprocess.run(["gh", "api", "--method", "POST", "repos/second/repository/issues"])`;

  // Act / Assert
  expect(repositoryMutationHandoff(
    { toolName: "eval", input: { language: "py", code } },
    repository,
  )).toMatchObject({ decision: "allow", action: "GitHub write" });
});
