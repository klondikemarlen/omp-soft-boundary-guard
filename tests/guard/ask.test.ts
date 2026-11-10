import { expect, test } from "bun:test";

import { confirmationForm } from "../../guard/ask.ts";

test("when confirmation text contains HTML, renders it as text rather than controls", () => {
  // Arrange
  const question = 'Allow <input name="injected" value="Approve"> & "quoted" text?';
  const questionId = 'boundary" autofocus="true';
  // Act
  const html = confirmationForm(question, questionId);
  // Assert
  expect(html).toContain('Allow &lt;input name=&quot;injected&quot; value=&quot;Approve&quot;&gt; &amp; &quot;quoted&quot; text?');
  expect(html).toContain('name="boundary&quot; autofocus=&quot;true"');
  expect(html).not.toContain(question);
  expect(html).not.toContain(`name="${questionId}"`);
});
