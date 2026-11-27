import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

import {
  createRepositoryBoundaryGuard,
  repositoryBoundaryGuard,
  type BoundaryGuardOptions,
  type ExtensionAPI,
  type ToolCallHandler,
} from "../../index.ts";
import type { AskPayload } from "../../guard/ask.ts";

export const current = "klondikemarlen/omp-soft-boundary-guard";
export const external = "elsewhere/example";
export const confirmationId = "confirm_repository_boundary_mutation";

export type Guard = {
  handler: ToolCallHandler;
  answer(event: { toolName: string; input: Record<string, unknown>; details: unknown; isError: boolean }): void;
  messages: string[];
  deliveries: Array<"steer" | "followUp">;
};

type GuardInstaller = (pi: ExtensionAPI) => void;

function captureGuard(install: GuardInstaller, sendUserMessage?: ExtensionAPI["sendUserMessage"]): Guard {
  let handler: ToolCallHandler | undefined;
  let resultHandler: Guard["answer"] | undefined;
  const messages: string[] = [];
  const deliveries: Guard["deliveries"] = [];
  install({
    on: ((event: string, registered: ToolCallHandler | Guard["answer"]) => {
      if (event === "tool_call") handler = registered as ToolCallHandler;
      else resultHandler = registered as Guard["answer"];
    }) as never,
    sendUserMessage: (message, options) => {
      messages.push(message);
      deliveries.push(options.deliverAs);
      sendUserMessage?.(message, options);
    },
  });
  return {
    handler: handler!,
    answer: (event) => resultHandler!(event),
    messages,
    deliveries,
  };
}

export function guard(options?: BoundaryGuardOptions): Guard {
  return captureGuard(createRepositoryBoundaryGuard({ enforce: true, ...options }));
}

export function installedGuard(sendUserMessage?: ExtensionAPI["sendUserMessage"]): Guard {
  return captureGuard(repositoryBoundaryGuard, sendUserMessage);
}

export function checkout(remote: string | null = `https://github.com/${current}.git`, root = "/tmp") {
  const directory = `${root}/omp-soft-boundary-guard-${crypto.randomUUID()}`;
  mkdirSync(directory, { recursive: true });
  execFileSync("git", ["-C", directory, "init", "--quiet"]);
  if (remote) execFileSync("git", ["-C", directory, "remote", "add", "origin", remote]);
  return directory;
}

export function checkoutOutsideTemporaryDirectory(remote: string | null = `https://github.com/${current}.git`) {
  return checkout(remote, process.cwd());
}

export function context(cwd: string, hasUI = true) {
  return { cwd, hasUI };
}

export function requestedAsk(message: string | undefined): AskPayload {
  if (!message) {
    throw new Error("missing confirmation request");
  }

  const start = message.indexOf("{");
  const end = message.lastIndexOf("}. If approved, retry exactly the blocked ") + 1;
  return JSON.parse(message.slice(start, end)) as AskPayload;
}

export function answerConfirmation(guard: Guard, answer: "Approve" | "Reject"): void {
  const input = requestedAsk(guard.messages.at(-1));
  const name = /<input\b[^>]*\bname="([^"]+)"/.exec(input.html)?.[1];
  if (!name) throw new Error("missing confirmation field");
  guard.answer({
    toolName: "ask",
    input,
    details: { answers: [{ name, answer }] },
    isError: false,
  });
}
