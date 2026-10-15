import type { ToolInput } from "../extension/contract.ts";

function stableValue(value: unknown, omitIntent = false, omitTitle = false): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableValue(entry));
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => (!omitIntent || key !== "i") && (!omitTitle || key !== "title"))
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

export function retryIdentity(toolName: string, input: ToolInput, context: string): string {
  return `${toolName}\u0000${context}\u0000${JSON.stringify(stableValue(input, true, toolName === "eval"))}`;
}

export function authorizationKey(
  toolName: string,
  action: string,
  target: string,
  input: ToolInput,
  context: string,
): string {
  return `${action}\u0000${target}\u0000${retryIdentity(toolName, input, context)}`;
}