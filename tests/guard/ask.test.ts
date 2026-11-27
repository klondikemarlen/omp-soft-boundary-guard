import { expect, test } from "bun:test";

import { confirmationForm } from "../../guard/ask.ts";

const question = 'Allow <input name="injected" value="Approve"> & "quoted" text?';
const fieldName = 'boundary" autofocus="true';

test("when the confirmation question contains HTML, renders it as literal text", () => {
  // Arrange
  let questionText = "";
  const parser = new HTMLRewriter().on("p", {
    text(chunk) {
      questionText += chunk.text;
    },
  });

  // Act
  parser.transform(confirmationForm(question, fieldName));

  // Assert
  expect(questionText).toBe(
    "Allow &lt;input name=&quot;injected&quot; value=&quot;Approve&quot;&gt; &amp; &quot;quoted&quot; text?",
  );
});

test("when confirmation input contains markup, renders only the two intended radio choices", () => {
  // Arrange
  const controls: Array<{
    tagName: string;
    type: string | null;
    name: string | null;
    value: string | null;
    checked: boolean;
    autofocus: boolean;
  }> = [];
  const parser = new HTMLRewriter().on("input, button, select, textarea", {
    element(control) {
      controls.push({
        tagName: control.tagName,
        type: control.getAttribute("type"),
        name: control.getAttribute("name"),
        value: control.getAttribute("value"),
        checked: control.hasAttribute("checked"),
        autofocus: control.hasAttribute("autofocus"),
      });
    },
  });

  // Act
  parser.transform(confirmationForm(question, fieldName));

  // Assert
  const escapedName = "boundary&quot; autofocus=&quot;true";
  expect(controls).toEqual([
    { tagName: "input", type: "radio", name: escapedName, value: "Approve", checked: false, autofocus: false },
    { tagName: "input", type: "radio", name: escapedName, value: "Reject", checked: true, autofocus: false },
  ]);
});
