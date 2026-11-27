import type { ToolCallEvent } from "../extension/contract.ts";
import type { RepositoryMutationHandoff } from "./ask.ts";
import { releaseHandoff } from "./release-handoff.ts";
import { githubHandoff } from "./github-handoff.ts";
import { localHandoff } from "./local-handoff.ts";
import { pythonHeredocSource } from "../shell/python-heredoc.ts";

export type { AskPayload, RepositoryMutationHandoff } from "./ask.ts";

export function repositoryMutationHandoff(event: ToolCallEvent, cwd: string): RepositoryMutationHandoff {
  if (event.toolName === "eval" && event.input.language === "py" && typeof event.input.code === "string") {
    return githubHandoff(event, cwd, event.input.code);
  }

  if (event.toolName === "bash" && typeof event.input.command === "string") {
    const source = pythonHeredocSource(event.input.command);
    if (source !== undefined) {
      // The heredoc body is Python input, not additional shell command segments.
      return githubHandoff(event, cwd, source);
    }
  }

  const release = releaseHandoff(event, cwd);
  const github = githubHandoff(event, cwd);
  if (github.decision === "ask") {
    return github;
  }

  const local = localHandoff(event, cwd);
  if (local) {
    return local;
  }

  if (release.decision === "ask" || release.action) {
    return release;
  }

  return github;
}
