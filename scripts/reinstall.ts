import { execFileSync } from "node:child_process";

execFileSync("omp", ["plugin", "install", "github:klondikemarlen/omp-soft-boundary-guard"], { stdio: "inherit" });
