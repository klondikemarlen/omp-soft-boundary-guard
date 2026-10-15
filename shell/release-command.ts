import { basename } from "node:path";

import { shellCommandSegments } from "./commands.ts";
import { shellExecutionSegments, type ShellExecutionSegment } from "./directory.ts";
import { executableIndex } from "./executable-index.ts";
import { normalizeRepository } from "../github/normalize-repository.ts";

const ACTIONS: Record<string, true> = { release: true, deploy: true, publish: true, promote: true };
const PACKAGE_PUBLISHERS: Record<string, true> = { npm: true, pnpm: true, yarn: true, bun: true };
const GH_RELEASE_ACTIONS: Record<string, true> = { create: true, edit: true, delete: true, upload: true, publish: true };
const SHELLS: Record<string, true> = { bash: true, sh: true, zsh: true, dash: true, fish: true };

const MAX_NESTED_SHELL_DEPTH = 2;

function isReleaseWrapper(executable: string): boolean {
  const normalized = executable.replaceAll("\\", "/");
  return /(?:^|\/)(?:bin\/(?:dev|release|deploy)|scripts\/(?:release|deploy)(?:\.[A-Za-z0-9_-]+)?)$/.test(normalized);
}

function isReleaseCommandWords(words: (string | undefined)[], depth: number): boolean {
  if (depth > MAX_NESTED_SHELL_DEPTH) {
    return false;
  }

  const index = executableIndex(words);
  const executable = words[index];
  if (typeof executable !== "string") {
    return false;
  }

  const args = words.slice(index + 1).filter((word): word is string => typeof word === "string");
  const name = basename(executable);
  const commandIndex = args.indexOf("-c");
  if (
    SHELLS[name] === true &&
    commandIndex >= 0 &&
    args[commandIndex + 1] &&
    shellCommandSegments(args[commandIndex + 1]).some(({ words: nestedWords }) => isReleaseCommandWords(nestedWords, depth + 1))
  ) {
    return true;
  }

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

export function releaseCommand(command: string): string | undefined {
  return shellCommandSegments(command).some(({ words }) => isReleaseCommandWords(words, 0)) ? command : undefined;
}

export function releaseExecutionSegments(
  segments: ShellExecutionSegment[],
  depth = 0,
): ShellExecutionSegment[] {
  const releases: ShellExecutionSegment[] = [];
  for (const segment of segments) {
    const index = executableIndex(segment.words);
    const executable = segment.words[index];
    const args = segment.words.slice(index + 1);
    const commandIndex = args.indexOf("-c");
    if (typeof executable === "string" && SHELLS[basename(executable)] === true && commandIndex >= 0) {
      const command = args[commandIndex + 1];
      if (depth < MAX_NESTED_SHELL_DEPTH && typeof command === "string" && segment.cwd !== undefined) {
        const nestedSegments = shellExecutionSegments({ command }, segment.cwd);
        releases.push(...releaseExecutionSegments(nestedSegments, depth + 1));
      } else if (isReleaseCommandWords(segment.words, depth)) {
        releases.push({ ...segment, cwd: undefined });
      }

      continue;
    }

    if (isReleaseCommandWords(segment.words, depth)) {
      releases.push(segment);
    }
  }

  return releases;
}

export type ReleaseTargetResolution = {
  repository?: string;
  unresolved: boolean;
};

function explicitReleaseTarget(command: string, depth = 0): string | null | undefined {
  let target: string | undefined;
  for (const { words } of shellCommandSegments(command)) {
    const index = executableIndex(words);
    const executable = words[index];
    const args = words.slice(index + 1).filter((word): word is string => typeof word === "string");
    const commandIndex = args.indexOf("-c");
    if (
      depth < MAX_NESTED_SHELL_DEPTH &&
      typeof executable === "string" &&
      SHELLS[basename(executable)] === true &&
      commandIndex >= 0
    ) {
      const nestedTarget = args[commandIndex + 1]
        ? explicitReleaseTarget(args[commandIndex + 1], depth + 1)
        : null;
      if (nestedTarget === null || (target && nestedTarget && target !== nestedTarget)) {
        return null;
      }
      target ??= nestedTarget;
      continue;
    }

    if (!isReleaseCommandWords(words, depth)) {
      continue;
    }

    for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
      const word = words[wordIndex];
      const repositoryFlag = word === "--repo" || word === "-R" ||
        (typeof word === "string" && (word.startsWith("--repo=") || word.startsWith("-R=")));
      if (!repositoryFlag) {
        continue;
      }

      const value = word === "--repo" || word === "-R"
        ? words[wordIndex + 1]
        : word.slice(word.indexOf("=") + 1);
      const repository = typeof value === "string" && normalizeRepository(value);
      if (!repository || (target && target !== repository)) {
        return null;
      }

      target = repository;
    }
  }
  return target;
}

export function releaseTarget(command: string): ReleaseTargetResolution {
  const repository = explicitReleaseTarget(command);
  return repository === null
    ? { unresolved: true }
    : repository
    ? { repository, unresolved: false }
    : { unresolved: false };
}
