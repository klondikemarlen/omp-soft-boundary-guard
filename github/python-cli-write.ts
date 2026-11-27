import type { SyntaxNode } from "@lezer/common";
import { parser } from "@lezer/python";

import type { ToolInput } from "../extension/contract.ts";
import { githubCliWrite } from "./cli-write.ts";
import type { GitHubWrite } from "./write.ts";

type PythonNode = SyntaxNode;
type SubprocessMethod = "run" | "check_output";

const ISSUE_VALUE_OPTIONS: Record<string, "payload" | "literal"> = {
  "--title": "payload",
  "-t": "payload",
  "--body": "payload",
  "-b": "payload",
  "--assignee": "literal",
  "-a": "literal",
  "--body-file": "literal",
  "-F": "literal",
  "--label": "literal",
  "-l": "literal",
  "--milestone": "literal",
  "-m": "literal",
  "--project": "literal",
  "--repo": "literal",
  "-R": "literal",
};

function children(node: PythonNode): PythonNode[] {
  const result: PythonNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    result.push(child);
  }

  return result;
}

function hasSyntaxError(node: PythonNode): boolean {
  if (node.name === "⚠") {
    return true;
  }

  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (hasSyntaxError(child)) {
      return true;
    }
  }

  return false;
}

function pythonString(node: PythonNode, source: string): string | undefined {
  if (node.name !== "String") {
    return undefined;
  }

  const literal = source.slice(node.from, node.to);
  const quote = literal[0];
  if (
    (quote !== "'" && quote !== '"') ||
    literal.at(-1) !== quote ||
    literal.length < 2
  ) {
    return undefined;
  }

  const value = literal.slice(1, -1);
  if (value.includes("\\") || value.includes(quote) || /[\r\n]/.test(value)) {
    return undefined;
  }

  return value;
}

function argvWords(node: PythonNode, source: string): (string | undefined)[] | undefined {
  if (node.name !== "ArrayExpression") {
    return undefined;
  }

  const childrenInArray = children(node);
  if (childrenInArray[0]?.name !== "[" || childrenInArray.at(-1)?.name !== "]") {
    return undefined;
  }

  const words: (string | undefined)[] = [];
  let expectingValue = true;
  for (const child of childrenInArray.slice(1, -1)) {
    if (child.name === ",") {
      if (expectingValue) {
        return undefined;
      }

      expectingValue = true;
      continue;
    }

    if (!expectingValue) {
      return undefined;
    }

    if (child.name === "VariableName") {
      words.push(undefined);
    } else {
      const word = pythonString(child, source);
      if (word === undefined) {
        return undefined;
      }

      words.push(word);
    }
    expectingValue = false;
  }

  return words.length ? words : undefined;
}

function issueCreationWithOpaquePayload(words: (string | undefined)[]): string[] | undefined {
  const literalWords = ["gh", "issue", "create"];
  for (let index = 3; index < words.length; index += 1) {
    const option = words[index];
    if (option === undefined) {
      return undefined;
    }

    const equals = option.indexOf("=");
    let optionName = option;
    if (equals !== -1) {
      optionName = option.slice(0, equals);
    }

    const valueKind = ISSUE_VALUE_OPTIONS[optionName];
    if (valueKind !== "payload" && valueKind !== "literal") {
      return undefined;
    }

    if (equals !== -1) {
      literalWords.push(option);
      continue;
    }

    if (index + 1 >= words.length) {
      return undefined;
    }

    const value = words[index + 1];
    index += 1;
    if (value !== undefined) {
      literalWords.push(option, value);
      continue;
    }

    if (valueKind !== "payload") {
      return undefined;
    }

    // Omit the data-only pair so the variable cannot affect repository or description inference.
  }

  return literalWords;
}

function allowedKeyword(name: string, value: PythonNode, source: string): boolean {
  if (name === "input") {
    return value.name === "VariableName";
  }

  if (!["check", "capture_output", "text"].includes(name)) {
    return false;
  }

  return value.name === "Boolean" && ["True", "False"].includes(source.slice(value.from, value.to));
}

function subprocessMethod(call: PythonNode, source: string): SubprocessMethod | undefined {
  const callee = call.getChild("MemberExpression");
  const calleeParts = callee ? children(callee) : [];
  if (
    calleeParts.length !== 3 ||
    calleeParts[0].name !== "VariableName" ||
    source.slice(calleeParts[0].from, calleeParts[0].to) !== "subprocess" ||
    calleeParts[1].name !== "." ||
    calleeParts[2].name !== "PropertyName"
  ) {
    return undefined;
  }

  const method = source.slice(calleeParts[2].from, calleeParts[2].to);
  if (method === "run" || method === "check_output") {
    return method;
  }

  return undefined;
}

function subprocessArgv(call: PythonNode, source: string): string[] | undefined {
  const method = subprocessMethod(call, source);
  if (!method) {
    return undefined;
  }

  const argumentList = call.getChild("ArgList");
  if (!argumentList) {
    return undefined;
  }

  const argumentsWithoutPunctuation = children(argumentList)
    .filter((child) => !["(", ")", ","].includes(child.name));
  const [argvNode, ...keywordParts] = argumentsWithoutPunctuation;
  if (!argvNode) {
    return undefined;
  }

  const keywordNames = new Set<string>();
  for (let index = 0; index < keywordParts.length; index += 3) {
    const [name, assignment, value] = keywordParts.slice(index, index + 3);
    if (!name || name.name !== "VariableName" || assignment?.name !== "AssignOp" || !value) {
      return undefined;
    }

    const keyword = source.slice(name.from, name.to);
    if (keywordNames.has(keyword)) {
      return undefined;
    }

    if (method === "check_output") {
      if (keyword !== "text" || value.name !== "Boolean" || source.slice(value.from, value.to) !== "True") {
        return undefined;
      }
    } else if (!allowedKeyword(keyword, value, source)) {
      return undefined;
    }

    keywordNames.add(keyword);
  }

  if (method === "check_output" && !keywordNames.has("text")) {
    return undefined;
  }

  const words = argvWords(argvNode, source);
  if (!words) {
    return undefined;
  }

  const isIssueCreation = words[0] === "gh" && words[1] === "issue" && words[2] === "create";
  if (method === "check_output" && !isIssueCreation) {
    return undefined;
  }

  if (words.every((word): word is string => word !== undefined)) {
    return words;
  }

  if (!isIssueCreation) {
    return undefined;
  }

  return issueCreationWithOpaquePayload(words);
}

export function pythonGitHubCliWrites(input: ToolInput, source: string): GitHubWrite | undefined {
  if (!source.includes("subprocess")) {
    return undefined;
  }

  try {
    const tree = parser.parse(source);
    if (hasSyntaxError(tree.topNode)) {
      return undefined;
    }

    const writes: GitHubWrite[] = [];

    function visit(node: PythonNode): void {
      if (node.name === "CallExpression") {
        const words = subprocessArgv(node, source);
        const write = words ? githubCliWrite(input, words) : undefined;
        if (write) {
          writes.push(write);
        }
      }

      for (let child = node.firstChild; child; child = child.nextSibling) {
        visit(child);
      }
    }

    visit(tree.topNode);

    if (writes.length === 1) {
      return writes[0];
    }

    return writes.length > 1 ? { action: "GitHub write", targetUnresolved: true } : undefined;
  } catch {
    return undefined;
  }
}
