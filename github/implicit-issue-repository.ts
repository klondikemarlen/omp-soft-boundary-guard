import { gitCommandOutput } from "../git/command.ts";
import { executableIndex } from "../shell/executable-index.ts";
import { remoteRepository } from "./remote-repository.ts";

type IssueRepositoryOptions = {
  env?: NodeJS.ProcessEnv;
  shellWords?: readonly (string | undefined)[];
  nonInteractive?: boolean;
};

const PUBLIC_HOST = "github.com";
const REPOSITORY_SLUG = /^[a-z0-9-]+\/[a-z0-9._-]+$/i;

export function implicitIssueRepository(cwd: string, options: IssueRepositoryOptions = {}): string | undefined {
  const commandEnv = githubEnvironment(options.env ?? process.env, options.shellWords);
  if (!commandEnv) {
    return undefined;
  }

  if (commandEnv.GH_REPO) {
    return environmentRepository(commandEnv.GH_REPO, commandEnv.GH_HOST);
  }

  if (commandEnv.GH_HOST && commandEnv.GH_HOST.toLowerCase() !== PUBLIC_HOST) {
    return undefined;
  }

  const remotes = githubRemotes(cwd);
  if (!remotes?.size) {
    return undefined;
  }

  const configured = configuredRepositories(cwd, remotes);
  if (!configured) {
    return undefined;
  }
  if (configured.size > 0) {
    return onlyRepository(configured);
  }

  // gh issue create uses SmartBaseRepo. When prompting is possible it may look
  // up fork parents, even with only one local remote. Do not do that lookup.
  if (commandEnv.GH_PROMPT_DISABLED === undefined && (!options.nonInteractive || commandEnv.GH_FORCE_TTY)) {
    return undefined;
  }

  return nonInteractiveRepository(remotes);
}

function githubEnvironment(inherited: NodeJS.ProcessEnv, words: IssueRepositoryOptions["shellWords"]): NodeJS.ProcessEnv | undefined {
  if (!words?.length) {
    return inherited;
  }

  const index = executableIndex(words);
  if (words[index] === undefined) {
    return undefined;
  }
  if (index === 0) {
    return inherited;
  }

  const overrides: NodeJS.ProcessEnv = {};
  for (let position = 0; position < index; position += 1) {
    const assignment = words[position];
    if (assignment === undefined) {
      return undefined;
    }

    const equal = assignment.indexOf("=");
    const name = assignment.slice(0, equal);
    if (["GH_REPO", "GH_HOST", "GH_PROMPT_DISABLED", "GH_FORCE_TTY"].includes(name)) {
      overrides[name] = assignment.slice(equal + 1);
    } else if (/^(?:PATH$|HOME$|XDG_CONFIG_HOME$|GH_CONFIG_DIR$|GIT_)/.test(name)) {
      // The process inspecting the checkout does not run with these overrides.
      return undefined;
    }
  }
  return { ...inherited, ...overrides };
}

function environmentRepository(value: string, host: string | undefined): string | undefined {
  const match = value.match(/^(?:(github\.com)\/)?([a-z0-9-]+\/[a-z0-9._-]+)$/i);
  // A bare owner/repo otherwise uses the CLI's authenticated default host.
  if (!match || (match[1] ?? host)?.toLowerCase() !== PUBLIC_HOST) {
    return undefined;
  }

  return match[2].toLowerCase();
}

function githubRemotes(cwd: string): Map<string, string> | undefined {
  const output = gitCommandOutput(cwd, ["remote", "-v"]);
  if (!output) return;

  const remotes = new Map<string, string>();
  for (const row of output.split("\n")) {
    const match = row.match(/^(\S+)\t(.+) \((?:fetch|push)\)$/);
    if (!match) return;

    const [, name, url] = match;
    const repository = remoteRepository(url);
    if (!repository || !REPOSITORY_SLUG.test(repository)) return;

    // A split fetch/push remote does not identify one repository.
    if (remotes.has(name) && remotes.get(name) !== repository) return;

    remotes.set(name, repository);
  }
  return remotes;
}

function configuredRepositories(cwd: string, remotes: Map<string, string>): Set<string> | undefined {
  // Include a normal repository key so "no gh-resolved keys" has successful
  // output and remains distinguishable from a failed Git config read.
  const config = gitCommandOutput(cwd, [
    "config", "--null", "--get-regexp", "^(core\\.repositoryformatversion|remote\\..*\\.gh-resolved)$",
  ]);
  if (!config) {
    return undefined;
  }

  const targets = new Set<string>();
  for (const row of config.split("\0")) {
    const match = row.match(/^remote\.(.*)\.gh-resolved(?:\n([\s\S]*))?$/);
    if (!match) {
      continue;
    }

    const [, name, value] = match;
    if (!value) {
      continue;
    }
    if (name.includes(".")) {
      // gh v2.46 splits the config key at the first dot in the remote name.
      return undefined;
    }
    const repo = remotes.get(name);
    if (repo === undefined) {
      continue;
    }
    if (value === "base") {
      targets.add(repo);
    } else if (REPOSITORY_SLUG.test(value)) {
      targets.add(value.toLowerCase());
    } else {
      return undefined;
    }
  }
  return targets;
}

function nonInteractiveRepository(remotes: Map<string, string>): string | undefined {
  // context.remoteNameSortScore in gh: upstream, github, origin, then others.
  const priority = ["upstream", "github", "origin"];
  let highestRank = priority.length;
  const preferred = new Set<string>();
  for (const [name, repository] of remotes) {
    const index = priority.indexOf(name.toLowerCase());
    const rank = index < 0 ? priority.length : index;
    if (rank < highestRank) {
      highestRank = rank;
      preferred.clear();
    }
    if (rank === highestRank) {
      preferred.add(repository);
    }
  }
  return onlyRepository(preferred);
}

function onlyRepository(repositories: Set<string | undefined>): string | undefined {
  if (repositories.size === 1) {
    return repositories.values().next().value;
  }
  return undefined;
}
