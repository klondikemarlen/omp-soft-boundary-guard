export function pythonHeredocSource(command: string): string | undefined {
  const opening = /^[ \t]*python3?(?:[ \t]+-)?[ \t]*<<[ \t]*(['"])([A-Za-z_][A-Za-z0-9_]*)\1[ \t]*\n/.exec(command);
  if (!opening) {
    return undefined;
  }

  const delimiter = opening[2];
  const sourceStart = opening[0].length;
  let lineStart = sourceStart;
  while (lineStart < command.length) {
    const newline = command.indexOf("\n", lineStart);
    let lineEnd = command.length;
    if (newline !== -1) {
      lineEnd = newline;
    }

    if (lineEnd - lineStart === delimiter.length && command.startsWith(delimiter, lineStart)) {
      if (/[^ \t\n]/.test(command.slice(lineEnd))) {
        return undefined;
      }

      return command.slice(sourceStart, lineStart);
    }

    lineStart = lineEnd + 1;
  }

  return undefined;
}
