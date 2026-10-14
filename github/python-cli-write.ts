import type { SyntaxNode } from "@lezer/common";
import { parser } from "@lezer/python";

import type { ToolInput } from "../extension/contract.ts";
import { githubCliWrite } from "./cli-write.ts";
import type { GitHubWrite } from "./write.ts";

type PythonNode = SyntaxNode;

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

function literalArgv(node: PythonNode, source: string): string[] | undefined {
  if (node.name !== "ArrayExpression") {
    return undefined;
  }

  const childrenInArray = children(node);
  if (childrenInArray[0]?.name !== "[" || childrenInArray.at(-1)?.name !== "]") {
    return undefined;
  }

  const words: string[] = [];
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

    const word = pythonString(child, source);
    if (word === undefined) {
      return undefined;
    }

    words.push(word);
    expectingValue = false;
  }

  return words.length ? words : undefined;
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

function subprocessArgv(call: PythonNode, source: string): string[] | undefined {
  const callee = call.getChild("MemberExpression");
  const calleeParts = callee ? children(callee) : [];
  if (
    calleeParts.length !== 3 ||
    calleeParts[0].name !== "VariableName" ||
    source.slice(calleeParts[0].from, calleeParts[0].to) !== "subprocess" ||
    calleeParts[1].name !== "." ||
    calleeParts[2].name !== "PropertyName" ||
    source.slice(calleeParts[2].from, calleeParts[2].to) !== "run"
  ) {
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
    if (keywordNames.has(keyword) || !allowedKeyword(keyword, value, source)) {
      return undefined;
    }

    keywordNames.add(keyword);
  }

  if (keywordParts.length % 3 !== 0) {
    return undefined;
  }

  return literalArgv(argvNode, source);
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
