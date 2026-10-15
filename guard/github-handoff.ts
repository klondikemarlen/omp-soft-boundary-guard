import type { ToolCallEvent } from "../extension/contract.ts";
import { currentCheckoutRepository, currentCheckoutRoot } from "../git/current-checkout.ts";
import { defaultPushRemote } from "../git/default-push-remote.ts";
import { pushRepository } from "../git/push-repository.ts";
import { gitPushWrite } from "../git/push-write.ts";
import { pinGitHubDeviceRepository } from "../github/device-write.ts";
import { pythonGitHubCliWrites } from "../github/python-cli-write.ts";
import { remoteRepository } from "../github/remote-repository.ts";
import { recognizedGitHubWrite } from "../github/recognized-write.ts";
import type { GitHubWrite } from "../github/write.ts";
import { shellExecutionSegments, toolDirectory } from "../shell/directory.ts";
import { askHandoff, type RepositoryMutationHandoff } from "./ask.ts";
import { guardDecision } from "./decision.ts";

type LocatedGitHubWrite = {
  write: GitHubWrite;
  cwd?: string;
};

function writeFor(event: ToolCallEvent, sessionCwd: string): LocatedGitHubWrite | undefined {
  if (event.toolName === "write") {
    const write = recognizedGitHubWrite(event.input);
    return write ? { write, cwd: toolDirectory(event.input, sessionCwd) ?? sessionCwd } : undefined;
  }

  if (event.toolName === "eval") {
    const code = event.input.code;
    if (event.input.language !== "py" || typeof code !== "string") {
      return undefined;
    }

    const write = pythonGitHubCliWrites(event.input, code);
    return write ? { write, cwd: toolDirectory(event.input, sessionCwd) ?? sessionCwd } : undefined;
  }

  if (event.toolName !== "bash" || typeof event.input.command !== "string") {
    return undefined;
  }

  let locatedWrite: LocatedGitHubWrite | undefined;
  for (const segment of shellExecutionSegments(event.input, sessionCwd)) {
    const write = gitPushWrite(segment.words) ?? recognizedGitHubWrite(event.input, segment.words);
    if (!write) {
      continue;
    }

    if (locatedWrite) {
      return { write: { action: "GitHub write", targetUnresolved: true } };
    }

    locatedWrite = { write, cwd: segment.cwd };
  }
  return locatedWrite;
}

export function githubHandoff(event: ToolCallEvent, cwd: string): RepositoryMutationHandoff {
  const located = writeFor(event, cwd);
  if (!located) {
    return { decision: "allow" };
  }

  const { write } = located;
  const commandCwd = located.cwd;
  if (commandCwd === undefined) {
    write.targetUnresolved = true;
  }

  if (write.action === "git push" && !write.targetUnresolved && commandCwd !== undefined) {
    const remote = write.remote ?? defaultPushRemote(commandCwd, write.gitOptions);
    write.target = remoteRepository(remote) ?? pushRepository(commandCwd, remote, write.gitOptions);
    write.targetUnresolved = !write.target;
  }

  if (write.action !== "git push" && !write.target && !write.targetUnresolved && commandCwd !== undefined) {
    write.target = currentCheckoutRepository(commandCwd);
  }

  const currentRepository = currentCheckoutRepository(cwd);
  const revisedInput = write.target ? pinGitHubDeviceRepository(event.input, write.target) : undefined;
  const decision = guardDecision(write, currentRepository);
  if (decision.allow) {
    return { decision: "allow", action: write.action, currentRepository, target: write.target, input: revisedInput };
  }

  const handoff = askHandoff(
    decision.action,
    decision.target,
    event,
    currentRepository ?? currentCheckoutRoot(cwd) ?? cwd,
    write.action === "git push" ? "git" : "github",
    currentRepository,
    write.description,
  );
  return revisedInput ? { ...handoff, input: revisedInput } : handoff;
}
