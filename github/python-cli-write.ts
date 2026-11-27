import type { SyntaxNode } from "@lezer/common";
import { parser } from "@lezer/python";

import type { ToolInput } from "../extension/contract.ts";
import { githubCliWrite } from "./cli-write.ts";
import type { GitHubWrite } from "./write.ts";

type PythonNode = SyntaxNode;
type SubprocessMethod = "run" | "check_output";

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

function issueCreationWithOpaquePayload(words: (string | undefined)[]): (string | undefined)[] | undefined {
  const cliWords: (string | undefined)[] = ["gh", "issue", "create"];
  for (let index = 3; index < words.length; index += 2) {
    const flag = words[index];
    if (!flag || index + 1 >= words.length) return;

    const value = words[index + 1];
    if (flag === "--title" || flag === "-t" || flag === "--body" || flag === "-b") {
      // Do not invent a title or body for the confirmation.
      if (value !== undefined) {
        cliWords.push(flag, value);
      }
    } else if (flag === "--repo" || flag === "-R" || (value !== undefined && (flag === "--label" || flag === "-l"))) {
      cliWords.push(flag, value);
    } else {
      return undefined;
    }
  }
  return cliWords;
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

function subprocessArgv(call: PythonNode, source: string): (string | undefined)[] | undefined {
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
