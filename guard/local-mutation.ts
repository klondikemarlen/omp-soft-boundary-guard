import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ToolCallEvent } from "../extension/contract.ts";
import { currentCheckoutBoundary } from "../git/current-checkout.ts";
import { gitInvocation, gitInvocationRoot, type GitInvocation } from "../git/invocation.ts";
import { shellExecutionSegments, toolDirectory } from "../shell/directory.ts";

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export type LocalMutation = {
  action: string;
  boundary: string;
  targets: string[];
};

function canonicalTarget(path: string, cwd: string): string | undefined {
  let candidate = resolve(cwd, path);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const parts = candidate.split(sep).filter(Boolean);
    let current: string = sep;
    let restarted = false;
    let missingIndex = parts.length;

    for (let index = 0; index < parts.length; index += 1) {
      const next = resolve(current, parts[index]);
      let stat;
      try {
        stat = lstatSync(next);
      } catch {
        missingIndex = index;
        break;
      }

      if (stat.isSymbolicLink()) {
        let link: string;
        try {
          link = readlinkSync(next);
        } catch {
          return undefined;
        }
        candidate = resolve(isAbsolute(link) ? link : dirname(next), link, ...parts.slice(index + 1));
        restarted = true;
        break;
      }
      current = next;
    }

    if (restarted) continue;
    try {
      return resolve(realpathSync(current), ...parts.slice(missingIndex));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

const TEMPORARY_DIRECTORY = canonicalTarget(tmpdir(), sep);

function isTemporaryTarget(target: string): boolean {
  return TEMPORARY_DIRECTORY !== undefined &&
    (target === TEMPORARY_DIRECTORY || target.startsWith(`${TEMPORARY_DIRECTORY}${sep}`));
}

const REGISTERED_INTERNAL_TARGETS: Record<string, true> = {
  "xd://github": true,
  "xd://browser": true,
  "xd://lsp": true,
  "xd://report_issue": true,
  "xd://recall": true,
  "xd://retain": true,
  "xd://reflect": true,
  "xd://memory_edit": true,
  "xd://learner_file_ticket": true,
};

function isRegisteredInternalTarget(path: string): boolean {
  return Object.hasOwn(REGISTERED_INTERNAL_TARGETS, path) || path.startsWith("skill://");
}

const URI_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const FILE_URI = /^file:/i;

function localTarget(path: string): string | undefined {
  if (!URI_SCHEME.test(path) && !FILE_URI.test(path)) return path;
  if (!FILE_URI.test(path)) return undefined;
  try {
    return fileURLToPath(path);
  } catch {
    return undefined;
  }
}

function containingBoundary(path: string): string | undefined {
  let directory = dirname(path);
  while (!pathExists(directory)) {
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  while (pathExists(directory)) {
    try {
      if (!lstatSync(directory).isSymbolicLink()) return currentCheckoutBoundary(directory);
    } catch {
      return undefined;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

function editPaths(input: Record<string, unknown>): string[] | undefined {
  if (typeof input.input !== "string") return undefined;

  const sections = [...input.input.matchAll(/^\[([^#\r\n]+)#[0-9A-F]{4}\]\r?$/gm)];
  if (!sections.length) return undefined;

  const paths: string[] = [];
  for (const [index, section] of sections.entries()) {
    paths.push(section[1]);
    const end = sections[index + 1]?.index ?? input.input.length;
    const body = input.input.slice(section.index! + section[0].length, end);
    for (const move of body.matchAll(/^MV\s+(.+?)\s*$/gm)) paths.push(move[1]);
  }
  return paths;
}

const GIT_MUTATION_COMMANDS: Record<string, true> = {
  add: true,
  am: true,
  apply: true,
  bisect: true,
  "cherry-pick": true,
  clean: true,
  commit: true,
  config: true,
  fetch: true,
  gc: true,
  init: true,
  maintenance: true,
  merge: true,
  mv: true,
  pull: true,
  rebase: true,
  reflog: true,
  remote: true,
  repack: true,
  replace: true,
  reset: true,
  restore: true,
  revert: true,
  rm: true,
  "sparse-checkout": true,
  stash: true,
  submodule: true,
  switch: true,
  worktree: true,
};

const GIT_BRANCH_AND_TAG_INSPECTION_OPTIONS: Record<string, true> = {
  "-a": true,
  "-h": true,
  "-l": true,
  "-n": true,
  "-r": true,
  "--all": true,
  "--help": true,
  "--list": true,
  "--remotes": true,
  "--show-current": true,
};

const GIT_CONFIG_READ_ONLY_OPTIONS: Record<string, true> = {
  "--get": true,
  "--get-all": true,
  "--get-color": true,
  "--get-colorbool": true,
  "--get-regexp": true,
  "--get-urlmatch": true,
  "--list": true,
  "-l": true,
};

const GIT_CONFIG_MUTATION_OPTIONS: Record<string, true> = {
  "--add": true,
  "--edit": true,
  "--remove-section": true,
  "--rename-section": true,
  "--replace-all": true,
  "--unset": true,
  "--unset-all": true,
};

const GIT_STASH_SHOW_OPTIONS: Record<string, true> = {
  "--include-untracked": true,
  "--name-only": true,
  "--name-status": true,
  "--numstat": true,
  "--only-untracked": true,
  "--patch": true,
  "--raw": true,
  "--shortstat": true,
  "--stat": true,
  "--summary": true,
  "-p": true,
};

function firstGitSubcommand(commandArguments: (string | undefined)[]): string | undefined {
  for (const argument of commandArguments) {
    if (typeof argument !== "string") {
      return undefined;
    }

    if (!argument.startsWith("-")) {
      return argument;
    }
  }

  return undefined;
}

function isReadOnlyGitCommand(command: string, commandArguments: (string | undefined)[]): boolean {
  const argumentEnd = commandArguments.indexOf("--");
  const options = argumentEnd < 0 ? commandArguments : commandArguments.slice(0, argumentEnd);
  if (options.some((argument) => argument === "-h" || argument === "--help")) {
    return true;
  }

  if (command === "remote") {
    const subcommand = firstGitSubcommand(commandArguments);
    return subcommand === undefined || subcommand === "show" || subcommand === "get-url";
  }

  if (command === "config") {
    if (
      commandArguments.some(
        (argument) => typeof argument === "string" && Object.hasOwn(GIT_CONFIG_MUTATION_OPTIONS, argument),
      )
    ) {
      return false;
    }

    return commandArguments.some(
      (argument) => typeof argument === "string" && Object.hasOwn(GIT_CONFIG_READ_ONLY_OPTIONS, argument),
    );
  }

  if (command === "stash") {
    const subcommand = firstGitSubcommand(commandArguments);
    if (subcommand === "list") {
      return commandArguments.length === 1;
    }

    if (subcommand !== "show") {
      return false;
    }

    let stashReferences = 0;
    for (const argument of commandArguments.slice(commandArguments.indexOf(subcommand) + 1)) {
      if (typeof argument !== "string") {
        return false;
      }

      if (
        Object.hasOwn(GIT_STASH_SHOW_OPTIONS, argument) ||
        argument.startsWith("--format=") ||
        argument.startsWith("--pretty=")
      ) {
        continue;
      }

      if (argument.startsWith("-")) {
        return false;
      }

      stashReferences += 1;
      if (stashReferences > 1) {
        return false;
      }
    }

    return true;
  }

  if (command === "worktree") {
    return firstGitSubcommand(commandArguments) === "list";
  }

  return false;
}

function branchOrTagMutates(commandArguments: (string | undefined)[]): boolean {
  for (const argument of commandArguments) {
    if (typeof argument !== "string") {
      return false;
    }

    if (!Object.hasOwn(GIT_BRANCH_AND_TAG_INSPECTION_OPTIONS, argument)) {
      return true;
    }
  }

  return false;
}

function isMutatingGitInvocation(invocation: GitInvocation): boolean {
  if (invocation.arguments.some((argument) => typeof argument !== "string")) {
    return false;
  }

  if (isReadOnlyGitCommand(invocation.command, invocation.arguments)) {
    return false;
  }

  if (invocation.command === "checkout" || GIT_MUTATION_COMMANDS[invocation.command] === true) {
    return true;
  }

  return (invocation.command === "branch" || invocation.command === "tag") &&
    branchOrTagMutates(invocation.arguments);
}

function gitLocalMutation(event: ToolCallEvent, sessionCwd: string): LocalMutation | undefined {
  if (event.toolName !== "bash" || typeof event.input.command !== "string") {
    return undefined;
  }

  const boundary = currentCheckoutBoundary(sessionCwd);
  if (!boundary) {
    return undefined;
  }

  for (const segment of shellExecutionSegments(event.input, sessionCwd)) {
    const invocation = gitInvocation(segment.words);
    if (!invocation || !isMutatingGitInvocation(invocation)) {
      continue;
    }

    if (!segment.cwd) {
      return undefined;
    }

    const root = gitInvocationRoot(segment.cwd, invocation.options);
    if (!root) {
      return undefined;
    }

    const targetBoundary = currentCheckoutBoundary(root);
    if (!targetBoundary) {
      return undefined;
    }

    if (targetBoundary !== boundary) {
      return { action: "git mutation", boundary, targets: [root] };
    }
  }

  return undefined;
}

function localPathMutation(event: ToolCallEvent, sessionCwd: string): LocalMutation | undefined {
  const mutation = mutationPaths(event);
  if (!mutation) return undefined;

  const boundary = currentCheckoutBoundary(sessionCwd);
  if (!boundary || !mutation.paths.length) return undefined;

  const cwd = toolDirectory(event.input, sessionCwd) ?? sessionCwd;
  const targets: string[] = [];
  for (const path of mutation.paths) {
    const target = canonicalTarget(path, cwd);
    if (!target) return undefined;
    targets.push(target);
  }

  const externalTargets = [
    ...new Set(
      targets.filter((target) => {
        if (isTemporaryTarget(target)) return false;
        const targetBoundary = containingBoundary(target);
        if (!targetBoundary) return false;
        return targetBoundary !== boundary;
      }),
    ),
  ];

  return externalTargets.length ? { action: mutation.action, boundary, targets: externalTargets } : undefined;
}

function mutationPaths(event: ToolCallEvent): { action: string; paths: string[] } | undefined {
  if (event.toolName === "write") {
    if (typeof event.input.path !== "string") return { action: "file write", paths: [] };
    if (isRegisteredInternalTarget(event.input.path)) return undefined;
    const path = localTarget(event.input.path);
    return path ? { action: "file write", paths: [path] } : { action: "file write", paths: [] };
  }

  if (event.toolName !== "edit") return undefined;
  const paths = editPaths(event.input);
  if (!paths) return { action: "file edit", paths: [] };
  const localPaths: string[] = [];
  for (const path of paths) {
    if (isRegisteredInternalTarget(path)) continue;
    const localPath = localTarget(path);
    if (!localPath) return { action: "file edit", paths: [] };
    localPaths.push(localPath);
  }
  return localPaths.length ? { action: "file edit", paths: localPaths } : undefined;
}

export function localMutation(event: ToolCallEvent, sessionCwd: string): LocalMutation | undefined {
  return gitLocalMutation(event, sessionCwd) ?? localPathMutation(event, sessionCwd);
}
