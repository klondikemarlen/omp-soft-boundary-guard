import type { GitHubWrite } from "../github/write.ts";
import { gitInvocation } from "./invocation.ts";

const PUSH_FLAGS: Record<string, true> = {
  "-d": true,
  "-f": true,
  "-q": true,
  "-u": true,
  "-v": true,
  "--all": true,
  "--atomic": true,
  "--delete": true,
  "--dry-run": true,
  "--follow-tags": true,
  "--force": true,
  "--force-if-includes": true,
  "--force-with-lease": true,
  "--mirror": true,
  "--no-thin": true,
  "--no-verify": true,
  "--porcelain": true,
  "--prune": true,
  "--quiet": true,
  "--set-upstream": true,
  "--tags": true,
  "--thin": true,
  "--verbose": true,
};
const NON_MUTATING_FLAGS: Record<string, true> = { "-h": true, "-n": true, "--help": true, "--version": true };

export function gitPushWrite(words: (string | undefined)[]): GitHubWrite | undefined {
  const invocation = gitInvocation(words);
  if (!invocation || invocation.command !== "push") {
    return undefined;
  }

  const { arguments: pushArguments, options } = invocation;
  if (
    pushArguments.some(
      (word) => word === "--dry-run" || (typeof word === "string" && Object.hasOwn(NON_MUTATING_FLAGS, word)),
    )
  ) {
    return undefined;
  }

  for (const word of pushArguments) {
    if (typeof word !== "string" || (word.startsWith("-") && !PUSH_FLAGS[word])) {
      return { action: "git push", targetUnresolved: true, gitOptions: options };
    }

    if (!word.startsWith("-")) {
      return { action: "git push", remote: word, gitOptions: options };
    }
  }

  return { action: "git push", gitOptions: options };
}
