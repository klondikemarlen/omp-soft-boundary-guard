import { remoteRepository } from "../github/remote-repository.ts";
import { gitCommandOutput } from "./command.ts";
import { defaultPushRemote } from "./default-push-remote.ts";

export function pushRepositories(cwd: string, remote: string | undefined, gitOptions: string[] = []): string[] {
  const destination = remote ?? defaultPushRemote(cwd, gitOptions);
  const literalRepository = remoteRepository(destination);
  if (literalRepository) {
    return [literalRepository];
  }

  const pushUrls = gitCommandOutput(cwd, [...gitOptions, "remote", "get-url", "--push", "--all", "--", destination]);
  if (!pushUrls) {
    return [];
  }

  const repositories = new Set<string>();
  for (const url of pushUrls.split("\n")) {
    const repository = remoteRepository(url);
    if (repository) {
      repositories.add(repository);
    }
  }

  return [...repositories];
}
