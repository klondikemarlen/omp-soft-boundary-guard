import { executableIndex } from "../shell/executable-index.ts";
import { gitCommandOutput } from "./command.ts";

const GLOBAL_FLAGS: Record<string, true> = {
  "--no-pager": true,
  "--paginate": true,
  "-P": true,
};

export type GitInvocation = {
  command: string;
  arguments: (string | undefined)[];
  options: string[];
};

export function gitInvocation(words: (string | undefined)[]): GitInvocation | undefined {
  let index = executableIndex(words);
  if (words[index] !== "git") {
    return undefined;
  }

  index += 1;
  const options: string[] = [];
  while (index < words.length) {
    const word = words[index];
    if (typeof word !== "string") {
      return undefined;
    }

    if (word === "-C" || word === "-c") {
      const value = words[index + 1];
      if (typeof value !== "string") {
        return undefined;
      }

      options.push(word, value);
      index += 2;
      continue;
    }

    if (Object.hasOwn(GLOBAL_FLAGS, word)) {
      index += 1;
      continue;
    }

    if (word.startsWith("-")) {
      return undefined;
    }

    return { command: word, arguments: words.slice(index + 1), options };
  }

  return undefined;
}

export function gitInvocationRoot(cwd: string, options: string[]): string | undefined {
  return gitCommandOutput(cwd, [...options, "rev-parse", "--show-toplevel"]);
}
