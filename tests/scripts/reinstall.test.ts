import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

const reinstallScript = fileURLToPath(new URL("../../scripts/reinstall.ts", import.meta.url));

test("when reinstall runs, it installs the soft boundary guard", () => {
  // Arrange
  const directory = mkdtempSync(join(tmpdir(), "omp-soft-boundary-guard-"));
  const ompStubPath = join(directory, "omp");
  const installLogPath = join(directory, "calls");

  try {
    writeFileSync(ompStubPath, `#!/bin/sh
printf '%s\\n' "$*" >> "$OMP_REINSTALL_LOG"
`);
    chmodSync(ompStubPath, 0o755);

    // Act
    execFileSync(process.execPath, [reinstallScript], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        OMP_REINSTALL_LOG: installLogPath,
      },
    });

    // Assert
    const calls = readFileSync(installLogPath, "utf8").trim().split("\n");
    expect(calls).toEqual(["plugin install github:klondikemarlen/omp-soft-boundary-guard"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
