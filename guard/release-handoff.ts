import type { ToolCallEvent, ToolInput } from "../extension/contract.ts";
import { currentCheckoutRepository, currentCheckoutRoot } from "../git/current-checkout.ts";
import { shellExecutionSegments } from "../shell/directory.ts";
import { releaseExecutionSegments, releaseTarget } from "../shell/release-command.ts";
import { askHandoff, type RepositoryMutationHandoff } from "./ask.ts";

const INTERNAL_RELEASE_INPUTS = new WeakMap<ToolInput, string>();

export function authorizeInternalRelease(event: ToolCallEvent): ToolCallEvent {
  if (typeof event.input.command !== "string") throw new Error("internal release capability requires a command");
  INTERNAL_RELEASE_INPUTS.set(event.input, event.input.command);
  return event;
}

function takeInternalRelease(event: ToolCallEvent): boolean {
  const command = INTERNAL_RELEASE_INPUTS.get(event.input);
  INTERNAL_RELEASE_INPUTS.delete(event.input);
  return command === event.input.command;
}

export function releaseHandoff(event: ToolCallEvent, cwd: string): RepositoryMutationHandoff {
  if (event.toolName !== "bash" || typeof event.input.command !== "string") {
    return { decision: "allow" };
  }

  if (takeInternalRelease(event)) {
    return { decision: "allow" };
  }

  const segments = releaseExecutionSegments(shellExecutionSegments(event.input, cwd));
  if (!segments.length) {
    return { decision: "allow" };
  }

  let executionTarget: string | undefined;
  let releaseContextResolved = true;
  for (const segment of segments) {
    if (!segment.cwd) {
      releaseContextResolved = false;
      break;
    }

    const segmentTarget = currentCheckoutRepository(segment.cwd) ?? currentCheckoutRoot(segment.cwd);
    if (!segmentTarget || (executionTarget && executionTarget !== segmentTarget)) {
      releaseContextResolved = false;
      break;
    }

    executionTarget = segmentTarget;
  }

  const { repository: explicitTarget, unresolved } = releaseTarget(event.input.command);

  if (explicitTarget === undefined && (!releaseContextResolved || !executionTarget)) {
    return { decision: "allow" };
  }

  const currentRepository = currentCheckoutRepository(cwd);

  const target = explicitTarget ?? executionTarget;
  if (!target) {
    return { decision: "allow" };
  }

  if (
    currentRepository?.startsWith("klondikemarlen/") &&
    !unresolved &&
    target === currentRepository
  ) {
    return { decision: "allow", action: "release/deploy", target: currentRepository, currentRepository };
  }

  return askHandoff("release/deploy", target, event, target, "release", currentRepository);
}
