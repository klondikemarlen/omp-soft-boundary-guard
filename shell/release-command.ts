import { basename } from "node:path";

import { shellCommandSegments, type ShellCommandSegment } from "./commands.ts";
import { shellExecutionSegments } from "./directory.ts";
import { executableIndex } from "./executable-index.ts";
import { normalizeRepository } from "../github/normalize-repository.ts";
import type { ToolInput } from "../extension/contract.ts";

const ACTIONS: Record<string, true> = { release: true, deploy: true, publish: true, promote: true };
const PACKAGE_PUBLISHERS: Record<string, true> = { npm: true, pnpm: true, yarn: true, bun: true };
const GH_RELEASE_ACTIONS: Record<string, true> = { create: true, edit: true, delete: true, upload: true, publish: true };
const SHELLS: Record<string, true> = { bash: true, sh: true, zsh: true, dash: true, fish: true };

const MAX_NESTED_SHELL_DEPTH = 2;

function isReleaseWrapper(executable: string): boolean {
  const normalized = executable.replaceAll("\\", "/");
  return /(?:^|\/)(?:bin\/(?:dev|release|deploy)|scripts\/(?:release|deploy)(?:\.[A-Za-z0-9_-]+)?)$/.test(normalized);
}

type ReleaseExecutionSegment = {
  cwd: string | undefined;
  // undefined uses the checkout; null means an explicit repository could not be resolved.
  explicitRepository: string | null | undefined;
};

export function releaseExecutionSegments(input: ToolInput, cwd: string): ReleaseExecutionSegment[] {
  const releases: ReleaseExecutionSegment[] = [];
  collectReleaseSegments(shellExecutionSegments(input, cwd), releases, 0);
  return releases;
}

function collectReleaseSegments(
  segments: (ShellCommandSegment & { cwd?: string | undefined })[],
  releases: ReleaseExecutionSegment[],
  depth: number,
): void {
  for (const { words, cwd } of segments) {
    const index = executableIndex(words);
    const executable = words[index];
    if (typeof executable !== "string") {
      continue;
    }

    const name = basename(executable);
    if (SHELLS[name] === true && depth < MAX_NESTED_SHELL_DEPTH) {
      const commandIndex = words.indexOf("-c", index + 1);
      const command = words[commandIndex + 1];
      if (commandIndex >= 0 && typeof command === "string") {
        // An unknown checkout does not prevent resolving a literal repository inside the shell.
        let nestedSegments: (ShellCommandSegment & { cwd?: string | undefined })[];
        if (cwd === undefined) {
          nestedSegments = shellCommandSegments(command);
        } else {
          nestedSegments = shellExecutionSegments({ command }, cwd);
        }
        collectReleaseSegments(nestedSegments, releases, depth + 1);
      }

      continue;
    }

    const args = words.slice(index + 1).filter((word): word is string => typeof word === "string");
    if (isReleaseCommand(executable, name, args)) {
      const explicitRepository = explicitReleaseRepository(words, index + 1);
      releases.push({ cwd, explicitRepository });
    }
  }
}

function isReleaseCommand(executable: string, name: string, args: string[]): boolean {
  if (ACTIONS[name] === true || (isReleaseWrapper(executable) && args.some((arg) => ACTIONS[arg] === true))) {
    return true;
  }

  if (
    PACKAGE_PUBLISHERS[name] === true &&
    (
      args[0] === "publish" ||
      (args[0] === "run" && ACTIONS[args[1] ?? ""] === true) ||
      ACTIONS[args[0] ?? ""] === true
    )
  ) {
    return true;
  }

  if ((name === "npx" || name === "make" || name === "just") && args.some((arg) => ACTIONS[arg] === true)) {
    return true;
  }

  return name === "gh" && args[0] === "release" && GH_RELEASE_ACTIONS[args[1] ?? ""] === true;
}

function explicitReleaseRepository(words: (string | undefined)[], firstArgument: number): string | null | undefined {
  let target: string | undefined;

  for (let index = firstArgument; index < words.length; index += 1) {
    const word = words[index];
    let value: string | undefined;
    if (word === "--repo" || word === "-R") {
      value = words[index + 1];
    } else if (word?.startsWith("--repo=") || word?.startsWith("-R=")) {
      value = word.slice(word.indexOf("=") + 1);
    } else {
      continue;
    }

    const repository = typeof value === "string" && normalizeRepository(value);
    if (!repository || (target && target !== repository)) {
      return null;
    }

    target = repository;
  }

  return target;
}
