import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

const packageRoot = new URL("../..", import.meta.url).pathname;

function reinstallCalls(): string[] {
  const directory = mkdtempSync(join(tmpdir(), "omp-soft-boundary-guard-"));
  const command = join(directory, "omp");
  const log = join(directory, "calls");
  writeFileSync(command, `#!/bin/sh
printf '%s\\n' "$*" >> "$OMP_REINSTALL_LOG"
`);
  chmodSync(command, 0o755);
  try {
    execFileSync(process.execPath, ["run", "scripts/reinstall.ts"], {
      cwd: packageRoot,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        OMP_REINSTALL_LOG: log,
      },
    });
    return readFileSync(log, "utf8").trim().split("\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("when reinstall runs, it installs the soft boundary guard", () => {
  // Arrange
  // Act
  const calls = reinstallCalls();

  // Assert
  expect(calls).toEqual(["plugin install github:klondikemarlen/omp-soft-boundary-guard"]);
});
