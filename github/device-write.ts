import type { ToolInput } from "../extension/contract.ts";
import { normalizeRepository } from "./normalize-repository.ts";
import type { GitHubWrite } from "./write.ts";

type Operation = { action: string; title?: string; requiresTarget?: boolean };
const READ_OPERATIONS: Record<string, true> = {
  pr_checkout: true, repo_view: true, run_watch: true, search_code: true, search_commits: true,
  search_issues: true, search_prs: true, file_read: true, search_repos: true,
};
const WRITE_OPERATIONS: Record<string, Operation> = {
  issue_create: { action: "GitHub issue creation", title: "Issue title" },
  issue_comment: { action: "GitHub issue update" },
  pr_create: { action: "GitHub pull request creation", title: "Pull request title" },
  pr_comment: { action: "GitHub pull request update" },
  pr_push: { action: "GitHub pull request update", requiresTarget: true },
};

function repositoryReference(value: unknown): string | undefined {
  const normalized = normalizeRepository(value);
  if (normalized || typeof value !== "string") return normalized;

  const match = value.match(/github\.com[/:]([^/\s]+)\/([^/\s]+)/i);
  if (!match) return undefined;
  return normalizeRepository(`${match[1]}/${match[2]}`);
}

export function githubDeviceWrite(input: ToolInput): GitHubWrite | undefined {
  if (input.path !== "xd://github" || typeof input.content !== "string") return undefined;
  try {
    const request = JSON.parse(input.content) as Record<string, unknown>;
    if (typeof request.op !== "string" || !request.op) return undefined;
    if (READ_OPERATIONS[request.op]) return undefined;

    const operation = WRITE_OPERATIONS[request.op];
    if (!operation) return undefined;
    const repositoryTarget = repositoryReference(request.repo);
    const pullRequestTarget = repositoryReference(request.pr);
    const target = repositoryTarget ?? pullRequestTarget;
    const hasTarget = request.repo !== undefined || request.pr !== undefined;
    const targetIsRequired = operation.requiresTarget === true;
    const targetUnresolved = (hasTarget || targetIsRequired) && !target;
    const title = typeof request.title === "string" ? request.title : undefined;
    const description = operation.title && title !== undefined ? `${operation.title}: ${title}` : undefined;
    return {
      action: operation.action,
      target,
      targetUnresolved,
      description,
    };
  } catch {
    return undefined;
  }
}

export function pinGitHubDeviceRepository(input: ToolInput, repository: string): ToolInput | undefined {
  if (input.path !== "xd://github" || typeof input.content !== "string") return undefined;
  try {
    const request = JSON.parse(input.content) as Record<string, unknown>;
    if (typeof request.op !== "string" || !WRITE_OPERATIONS[request.op] || request.repo !== undefined) return undefined;
    return { ...input, content: JSON.stringify({ ...request, repo: repository }) };
  } catch {
    return undefined;
  }
}
