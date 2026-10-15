import { gitCommandOutput } from "./command.ts";

export function defaultPushRemote(cwd: string, gitOptions: string[] = []): string {
  const branch = gitCommandOutput(cwd, [...gitOptions, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  return (
    (branch && gitCommandOutput(cwd, [...gitOptions, "config", "--get", `branch.${branch}.pushRemote`])) ??
    gitCommandOutput(cwd, [...gitOptions, "config", "--get", "remote.pushDefault"]) ??
    (branch && gitCommandOutput(cwd, [...gitOptions, "config", "--get", `branch.${branch}.remote`])) ??
    "origin"
  );
}
