import { homedir } from "node:os";
import { resolve } from "node:path";

import type { ToolInput } from "../extension/contract.ts";
import { shellCommandSegments, type ShellCommandSegment } from "./commands.ts";
import { executableIndex } from "./executable-index.ts";

export type ShellExecutionSegment = ShellCommandSegment & {
  cwd: string | undefined;
};

function unquoteDirectory(directory: string): string | undefined {
  return /[$`(){}*?\[\]]/.test(directory) ? undefined : directory;
}

function explicitDirectory(input: ToolInput, sessionCwd: string): string | undefined {
  if (typeof input.cwd !== "string" || !input.cwd.trim()) {
    return undefined;
  }

  const directory = input.cwd.trim();
  const expanded = directory === "~" || directory.startsWith("~/") ? `${homedir()}${directory.slice(1)}` : directory;
  return resolve(sessionCwd, expanded);
}

function changedDirectory(words: (string | undefined)[], cwd: string): string | undefined {
  const index = executableIndex(words);
  if (words[index] !== "cd") {
    return cwd;
  }

  const directoryIndex = words[index + 1] === "--" ? index + 2 : index + 1;
  const directory = words[directoryIndex];
  if (typeof directory !== "string" || words[directoryIndex + 1] !== undefined) {
    return undefined;
  }

  const parsed = unquoteDirectory(directory);
  if (!parsed) {
    return undefined;
  }

  const expanded = parsed === "~" || parsed.startsWith("~/") ? `${homedir()}${parsed.slice(1)}` : parsed;
  return resolve(cwd, expanded);
}

export function shellExecutionSegments(input: ToolInput, sessionCwd: string): ShellExecutionSegment[] {
  if (typeof input.command !== "string") {
    return [];
  }

  let cwd: string | undefined = explicitDirectory(input, sessionCwd) ?? sessionCwd;
  const segments: ShellExecutionSegment[] = [];

  for (const segment of shellCommandSegments(input.command)) {
    segments.push({ ...segment, cwd });
    if (cwd !== undefined) {
      cwd = changedDirectory(segment.words, cwd);
    }

    if (segment.nextOperator && !["&&", ";"].includes(segment.nextOperator)) {
      cwd = undefined;
    }
  }

  return segments;
}

export function toolDirectory(input: ToolInput, sessionCwd: string): string | undefined {
  return explicitDirectory(input, sessionCwd);
}
