import { remoteRepository } from "../github/remote-repository.ts";
import { gitCommandOutput } from "./command.ts";

export function pushRepository(cwd: string, remote: string, gitOptions: string[] = []): string | undefined {
  return remoteRepository(gitCommandOutput(cwd, [...gitOptions, "remote", "get-url", "--push", remote]));
}
