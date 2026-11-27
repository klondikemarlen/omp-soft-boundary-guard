import { expect, test } from "bun:test";

import { isReadOnlyGitConfig } from "../../git/config-command.ts";

test("when a positional config value resembles a read or help flag, still identifies a write", () => {
  // Arrange: first operands and explicit separators both end legacy option parsing.
  const commands = [
    ["demo.name", "--get"],
    ["demo.name", "--help"],
    ["--", "demo.name", "--list"],
    ["set", "--", "demo.name", "--help"],
  ];

  // Act / Assert
  for (const args of commands) {
    expect(isReadOnlyGitConfig(args)).toBe(false);
  }
});

test("when a config option consumes a flag-shaped value, does not treat the value as an action", () => {
  // Arrange: cover separated and attached values for long and short options.
  const commands = [
    ["--file", "--get", "demo.name", "new"],
    ["--file=--get", "demo.name", "new"],
    ["-f", "--help", "demo.name", "new"],
    ["-f--list", "demo.name", "new"],
  ];

  // Act / Assert
  for (const args of commands) {
    expect(isReadOnlyGitConfig(args)).toBe(false);
  }
});

test("when Git config reads by flag, subcommand, or single key, preserves the read-only classification", () => {
  // Arrange: include action-like read operands and a default value.
  const commands = [
    ["--get", "demo.name", "--unset"],
    ["--get", "--default", "--unset", "demo.name"],
    ["--get-all", "--", "demo.name", "--add"],
    ["-zl"],
    ["get", "--", "demo.name"],
    ["list", "--local"],
    ["--local", "demo.name"],
    ["--help"],
  ];

  // Act / Assert
  for (const args of commands) {
    expect(isReadOnlyGitConfig(args)).toBe(true);
  }
});
