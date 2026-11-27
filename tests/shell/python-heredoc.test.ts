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
  { condition: "the shell expands the body", header: "python <<END", trailer: "\nEND" },
  { condition: "the delimiter is missing", header: "python <<'END'", trailer: "" },
  { condition: "another command follows", header: "python3 <<'END'", trailer: "\nEND\nprintf done" },
])("when $condition, does not treat the whole command as literal Python", ({ header, trailer }) => {
  // Arrange
  const command = `${header}\nprint(1)${trailer}`;

  // Act / Assert
  expect(pythonHeredocSource(command)).toBeUndefined();
});
