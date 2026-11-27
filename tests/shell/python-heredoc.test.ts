import { expect, test } from "bun:test";

import { pythonHeredocSource } from "../../shell/python-heredoc.ts";

test("when a quoted Python heredoc is the whole command, preserves the source verbatim", () => {
  // Arrange
  const source = 'print("$HOME")\n# END is not the delimiter here\n';
  const command = `python - <<"END"\n${source}END\n`;

  // Act / Assert
  expect(pythonHeredocSource(command)).toBe(source);
});

test.each([
  ["the shell expands the body", "python <<END\nprint(1)\nEND"],
  ["the delimiter is missing", "python <<'END'\nprint(1)"],
  ["another command follows the delimiter", "python3 <<'END'\nprint(1)\nEND\nprintf done"],
])("when %s, does not treat the whole command as literal Python", (_scenario, command) => {
  // Act / Assert
  expect(pythonHeredocSource(command)).toBeUndefined();
});
