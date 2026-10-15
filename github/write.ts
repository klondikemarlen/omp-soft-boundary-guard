export type GitHubWrite = {
  action: string;
  target?: string;
  targetUnresolved?: boolean;
  gitOptions?: string[];
  remote?: string;
  description?: string;
};
