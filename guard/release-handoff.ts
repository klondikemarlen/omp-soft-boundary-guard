import type { ToolCallEvent, ToolInput } from "../extension/contract.ts";
import { currentCheckoutRepository, currentCheckoutRoot } from "../git/current-checkout.ts";
import { releaseExecutionSegments } from "../shell/release-command.ts";
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

  const segments = releaseExecutionSegments(event.input, cwd);
  if (!segments.length) {
    return { decision: "allow" };
  }

  const currentRepository = currentCheckoutRepository(cwd);
  const isOwnedCheckout = currentRepository?.startsWith("klondikemarlen/") === true;
  const targets: (string | undefined)[] = [];

  for (const { cwd: segmentCwd, explicitRepository } of segments) {
    if (typeof explicitRepository === "string") {
      targets.push(explicitRepository);
      continue;
    }
    if (segmentCwd === undefined) {
      targets.push(undefined);
      continue;
    }

    let executionTarget: string | undefined;
    if (segmentCwd === cwd) {
      executionTarget = currentRepository ?? currentCheckoutRoot(segmentCwd);
    } else {
      executionTarget = currentCheckoutRepository(segmentCwd) ?? currentCheckoutRoot(segmentCwd);
    }

    if (explicitRepository === null && executionTarget !== undefined) {
      targets.push(`unresolved destination (execution checkout: ${executionTarget})`);
    } else {
      targets.push(executionTarget);
    }
  }

  if (isOwnedCheckout && targets.every((target) => target === currentRepository)) {
    return { decision: "allow", action: "release/deploy", target: currentRepository, currentRepository };
  }

  const hasOutsideTarget = targets.some((target) =>
    target !== undefined && (!isOwnedCheckout || target !== currentRepository)
  );
  if (!hasOutsideTarget) {
    return { decision: "allow" };
  }

  const destinations = targets.map((destination) => destination ?? "unresolved destination");
  const target = [...new Set(destinations)].join(", ");
  let description: string | undefined;
  if (targets.length > 1) {
    description = `Release destinations in command order: ${destinations.join("; ")}`;
  }

  // Approval binds every segment's destination in order, not just the display list.
  const context = JSON.stringify(targets);
  return askHandoff("release/deploy", target, event, context, "release", currentRepository, description);
}
