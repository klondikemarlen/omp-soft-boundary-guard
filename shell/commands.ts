import { parse } from "shell-quote";

const COMMAND_BOUNDARIES: Record<string, true> = { "&&": true, "||": true, ";": true, "|": true, "|&": true, "&": true };
const REDIRECTIONS: Record<string, true> = { "<": true, ">": true, ">>": true, "<&": true, ">&": true, "<<<": true };

// Only split the heredoc form we can recognize without interpreting shell code.
const ISSUE_COMMENT_HEREDOC = /^([ \t]*gh[ \t]+issue[ \t]+comment[ \t][^\n]*)<<[ \t]*(['"])([A-Za-z_][A-Za-z0-9_]*)\2[ \t]*\n/;
const SIMPLE_SHELL_LINE = /^(?:[^'"`$\\#{}()<\r\n]|<(?!<)|'[^'\r\n]*'|"[^"`$\\\r\n]*")*$/;
const COMPOUND_COMMAND_WORDS = new Set([
  "if", "then", "elif", "else", "fi",
  "for", "select", "while", "until", "do", "done",
  "case", "esac", "function", "coproc", "time", "!", "[[",
]);

export type ShellCommandSegment = {
  words: (string | undefined)[];
  nextOperator?: string;
  cwdUncertain?: true;
};

export function shellCommandSegments(command: string): ShellCommandSegment[] {
  try {
    return issueCommentSegments(command) ?? tokenizedSegments(command);
  } catch {
    return [];
  }
}

function issueCommentSegments(command: string): ShellCommandSegment[] | undefined {
  const opening = ISSUE_COMMENT_HEREDOC.exec(command);
  if (!opening) {
    return undefined;
  }

  const [, commentCommand, , delimiter] = opening;
  if (!SIMPLE_SHELL_LINE.test(commentCommand) || commentCommand.endsWith("<")) {
    return undefined;
  }

  const segments = tokenizedSegments(commentCommand);
  const [comment] = segments;
  if (segments.length !== 1 || comment.nextOperator) {
    return undefined;
  }

  const readsStdin = comment.words.some((word, index) =>
    word === "--body-file=-" || (word === "--body-file" && comment.words[index + 1] === "-"),
  );
  if (!readsStdin) {
    return undefined;
  }

  // Match a complete delimiter line, including the opener's newline for an empty body.
  const closing = new RegExp(`\\n${delimiter}(?:\\n|$)`, "g");
  closing.lastIndex = opening[0].length - 1;
  const boundary = closing.exec(command);
  if (!boundary) {
    return undefined;
  }

  const trailingLines = command.slice(closing.lastIndex).split("\n");

  for (let index = 0; index < trailingLines.length; index += 1) {
    const line = trailingLines[index];
    if (/^[ \t]*(?:#.*)?$/.test(line)) {
      continue;
    }

    // Use the ordinary tokenizer on the remaining suffix when line breaks
    // cannot safely be treated as boundaries. Never feed it the comment body.
    const isSimpleLine = SIMPLE_SHELL_LINE.test(line);
    let source = line;
    if (!isSimpleLine) {
      source = trailingLines.slice(index).join("\n");
    }

    let lineSegments: ShellCommandSegment[];
    try {
      lineSegments = tokenizedSegments(source);
    } catch {
      break;
    }

    let uncertainSegment: ShellCommandSegment | undefined;
    if (isSimpleLine) {
      uncertainSegment = lineSegments.find(({ words: [firstWord] }) =>
        firstWord !== undefined && COMPOUND_COMMAND_WORDS.has(firstWord),
      );
    } else {
      uncertainSegment = lineSegments[0];
    }
    if (uncertainSegment) {
      uncertainSegment.cwdUncertain = true;
    }

    if (lineSegments.length) {
      segments[segments.length - 1].nextOperator ??= ";";
      segments.push(...lineSegments);
    }
    if (!isSimpleLine) {
      break;
    }
  }

  return segments;
}

function tokenizedSegments(command: string): ShellCommandSegment[] {
  const commands: ShellCommandSegment[] = [];
  let words: (string | undefined)[] = [];
  let nextOperator: string | undefined;
  let discardNext = false;

  for (const token of parse(command, () => ({}))) {
    if (typeof token === "string") {
      if (discardNext) discardNext = false;
      else words.push(token);
      continue;
    }
    if ("comment" in token) break;
    if (!("op" in token) || token.op === "glob") {
      if (discardNext) discardNext = false;
      else words.push(undefined);
      continue;
    }
    if (COMMAND_BOUNDARIES[token.op]) {
      if (words.length) commands.push({ words, nextOperator: token.op });
      words = [];
      nextOperator = undefined;
      discardNext = false;
    } else if (REDIRECTIONS[token.op]) {
      discardNext = true;
    }
  }
  if (words.length) commands.push({ words, nextOperator });
  return commands;
}


export function shellCommands(command: string): (string | undefined)[][] {
  return shellCommandSegments(command).map(({ words }) => words);
}
