import type { ToolInput } from "../extension/contract.ts";
import { normalizeRepository } from "./normalize-repository.ts";
import { githubTarget, isHelpRequest } from "./target.ts";
import type { GitHubWrite } from "./write.ts";

function environmentQuery(input: ToolInput): string | undefined {
  if (typeof input.command !== "string" || typeof input.env !== "object" || input.env === null || Array.isArray(input.env)) return undefined;
  if (/[;&|]/.test(input.command)) return undefined;

  const variables = [...input.command.matchAll(/(?:^|\s)(?:-f|--raw-field)\s+(?:["'])?query=(?:["'])?\$([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map((match) => match[1]);
  const [variable] = variables;
  if (!variable || variables.length !== 1) return undefined;

  const value = (input.env as Record<string, unknown>)[variable];
  if (typeof value === "string") return value;
  return undefined;
}

function graphqlQuery(words: (string | undefined)[], index: number, input: ToolInput): string | undefined {
  for (; index < words.length; index += 1) {
    const word = words[index];
    let value: string | undefined;
    if (word === "--raw-field" || word === "-f") {
      value = words[index + 1];
    } else if (typeof word === "string" && word.startsWith("--raw-field=")) {
      value = word.slice("--raw-field=".length);
    } else if (typeof word === "string" && word.startsWith("-f")) {
      value = word.slice(2);
    }
    if (typeof value !== "string" || !value.startsWith("query=")) continue;
    const query = value.slice("query=".length);
    if (!query || query.startsWith("$")) return environmentQuery(input);
    return query;
  }
  return environmentQuery(input);
}

function githubApiHostnameUnresolved(words: (string | undefined)[], input: ToolInput): boolean {
  const hostnames: string[] = [];
  if (typeof process.env.GH_HOST === "string") hostnames.push(process.env.GH_HOST);
  if (typeof input.env === "object" && input.env !== null && !Array.isArray(input.env)) {
    const hostname = (input.env as Record<string, unknown>).GH_HOST;
    if (typeof hostname === "string") hostnames.push(hostname);
  }

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (typeof word !== "string") continue;
    if (word.startsWith("GH_HOST=")) {
      hostnames.push(word.slice("GH_HOST=".length));
      continue;
    }
    if (word === "--hostname") {
      const hostname = words[index + 1];
      if (typeof hostname !== "string") return true;
      hostnames.push(hostname);
      index += 1;
      continue;
    }
    if (word.startsWith("--hostname=")) hostnames.push(word.slice("--hostname=".length));
  }
  return hostnames.some((hostname) => hostname.toLowerCase() !== "github.com");
}

type GraphqlToken = { type: "name" | "string" | "punct"; value: string };

function appendGraphqlStringToken(document: string, index: number, tokens: GraphqlToken[]): number | undefined {
  if (document.startsWith('"""', index)) {
    const end = document.indexOf('"""', index + 3);
    if (end === -1) return undefined;
    tokens.push({ type: "string", value: document.slice(index + 3, end) });
    return end + 3;
  }

  let end = index + 1;
  while (end < document.length) {
    if (document[end] === "\\") {
      end += 2;
      continue;
    }
    if (document[end] === '"') break;
    end += 1;
  }
  if (end >= document.length) return undefined;
  try {
    tokens.push({ type: "string", value: JSON.parse(document.slice(index, end + 1)) });
  } catch {
    return undefined;
  }
  return end + 1;
}

function graphqlTokens(document: string): GraphqlToken[] | undefined {
  const tokens: GraphqlToken[] = [];
  for (let index = 0; index < document.length;) {
    const character = document[index];
    if (/\s|,/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "#") {
      index = document.indexOf("\n", index);
      if (index === -1) break;
      continue;
    }
    if (document.startsWith('"""', index) || character === '"') {
      const nextIndex = appendGraphqlStringToken(document, index, tokens);
      if (nextIndex === undefined) return undefined;
      index = nextIndex;
      continue;
    }
    if (document.startsWith("...", index)) {
      tokens.push({ type: "punct", value: "..." });
      index += 3;
      continue;
    }
    if (character === "-" || /\d/.test(character)) {
      const number = document.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (!number) return undefined;
      index += number[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const end = document.slice(index).search(/[^A-Za-z0-9_]/);
      const value = end === -1 ? document.slice(index) : document.slice(index, index + end);
      tokens.push({ type: "name", value });
      index += value.length;
      continue;
    }
    if ("!$&():=@[]{}|".includes(character)) {
      tokens.push({ type: "punct", value: character });
      index += 1;
      continue;
    }
    return undefined;
  }
  return tokens;
}

function graphqlOperation(document: string): "query" | "mutation" | undefined {
  const tokens = graphqlTokens(document);
  if (!tokens) return undefined;
  if (tokens[0]?.value === "{") return "query";

  let depth = 0;
  let operation: "query" | "mutation" | "subscription" | undefined;
  let count = 0;
  for (const token of tokens) {
    if (depth === 0 && token.type === "name" && ["query", "mutation", "subscription"].includes(token.value)) {
      operation = token.value as typeof operation;
      count += 1;
    }
    if (token.value === "{") depth += 1;
    if (token.value === "}") depth -= 1;
  }
  return count === 1 && operation !== "subscription" ? operation : undefined;
}

type ApiValueOption = "field-argument" | "field-inline" | "argument" | "inline";

function apiMethodValue(words: (string | undefined)[], index: number): string | null | undefined {
  const word = words[index];
  if (word === "--method" || word === "-X") {
    const value = words[index + 1];
    return typeof value === "string" && !value.startsWith("-") ? value.toUpperCase() : null;
  }
  if (typeof word !== "string") return undefined;
  if (!word.startsWith("--method=") && !word.startsWith("-X")) return undefined;

  const value = word.startsWith("--method=") ? word.slice(word.indexOf("=") + 1) : word.slice(2);
  return value ? value.toUpperCase() : null;
}

function apiValueOption(word: string | undefined): ApiValueOption | undefined {
  if (word === "--raw-field" || word === "-f" || word === "--field" || word === "-F" || word === "--input") {
    return "field-argument";
  }
  if (word === "--hostname" || word === "--jq" || word === "--template" || word === "--header" || word === "-H") {
    return "argument";
  }
  if (typeof word !== "string") return undefined;
  if (
    word.startsWith("--raw-field=") ||
    word.startsWith("--field=") ||
    word.startsWith("--input=") ||
    word.startsWith("-f") ||
    word.startsWith("-F")
  ) return "field-inline";
  if (/^(?:--hostname|--jq|--template|--header|-H)=/.test(word)) return "inline";
  return undefined;
}

function apiEndpointTarget(word: string | undefined): string | null | undefined {
  if (typeof word !== "string") return undefined;
  const path = word.match(/(?:^|\/)repos\/([^/\s]+)\/([^/?\s]+)/i);
  if (!path) return undefined;
  return normalizeRepository(`${path[1]}/${path[2]}`) ?? null;
}

export function githubApiWrite(words: (string | undefined)[], index: number, input: ToolInput): GitHubWrite | undefined {
  if (isHelpRequest(words, index)) return undefined;
  if (words[index] === "graphql") {
    const document = graphqlQuery(words, index + 1, input);
    if (document && graphqlOperation(document) === "query") return undefined;
    return { action: "GitHub API write", targetUnresolved: true };
  }

  const targetInfo = githubTarget(words, index);
  const hostnameUnresolved = githubApiHostnameUnresolved(words, input);
  let target = targetInfo.target;
  let method = "GET";
  let methodUnresolved = false;
  let methodExplicit = false;
  let hasFields = false;
  let skipNext = false;

  for (; index < words.length; index += 1) {
    const word = words[index];
    if (skipNext) {
      skipNext = false;
      continue;
    }

    const parsedMethod = apiMethodValue(words, index);
    if (parsedMethod !== undefined) {
      methodExplicit = true;
      if (parsedMethod === null) methodUnresolved = true;
      else method = parsedMethod;
      if (word === "--method" || word === "-X") index += 1;
      continue;
    }

    const valueOption = apiValueOption(word);
    if (valueOption !== undefined) {
      hasFields ||= valueOption === "field-argument" || valueOption === "field-inline";
      skipNext = valueOption === "field-argument" || valueOption === "argument";
      continue;
    }

    const endpointTarget = apiEndpointTarget(word);
    if (endpointTarget !== undefined) target = endpointTarget ?? undefined;
  }

  const requestIsReadOnly = !methodUnresolved && method === "GET" && (!hasFields || methodExplicit);
  if (requestIsReadOnly) return undefined;
  return {
    action: "GitHub API write",
    target,
    targetUnresolved: targetInfo.targetUnresolved || hostnameUnresolved || methodUnresolved || !target,
  };
}
