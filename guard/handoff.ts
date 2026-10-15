import type { ToolCallEvent } from "../extension/contract.ts";
import type { RepositoryMutationHandoff } from "./ask.ts";
import { releaseHandoff } from "./release-handoff.ts";
import { githubHandoff } from "./github-handoff.ts";
import { localHandoff } from "./local-handoff.ts";

export type { AskPayload, RepositoryMutationHandoff } from "./ask.ts";

export function repositoryMutationHandoff(event: ToolCallEvent, cwd: string): RepositoryMutationHandoff {
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
