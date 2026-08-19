import { expect, test } from "bun:test";

import { githubDeviceWrite } from "../../github/device-write.ts";

test("when repository and pull request targets are supplied, device writes prefer the repository", () => {
  // Arrange
  const input = {
    path: "xd://github",
    content: JSON.stringify({
      op: "issue_create",
      repo: "owner/repository",
      pr: "https://github.com/other/pull/1",
    }),
  };

  // Act
  const write = githubDeviceWrite(input);

  // Assert
  expect(write).toEqual({
    action: "GitHub issue creation",
    target: "owner/repository",
    targetUnresolved: false,
    description: undefined,
  });
});

test("when an issue title is empty, device writes preserve its empty description", () => {
  // Arrange
  const input = {
    path: "xd://github",
    content: JSON.stringify({ op: "issue_create", repo: "owner/repository", title: "" }),
  };

  // Act
  const write = githubDeviceWrite(input);

  // Assert
  expect(write).toEqual({
    action: "GitHub issue creation",
    target: "owner/repository",
    targetUnresolved: false,
    description: "Issue title: ",
  });
});
