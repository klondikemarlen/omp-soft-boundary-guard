const LEGACY_READ_ACTIONS: Record<string, true> = {
  "--get": true,
  "--get-all": true,
  "--get-color": true,
  "--get-colorbool": true,
  "--get-regexp": true,
  "--get-urlmatch": true,
  "--list": true,
};

const MUTATING_SUBCOMMANDS: Record<string, true> = {
  edit: true,
  "remove-section": true,
  "rename-section": true,
  set: true,
  unset: true,
};

const OPTIONS_WITH_VALUES: Record<string, true> = {
  "--blob": true,
  "--comment": true,
  "--default": true,
  "--file": true,
  "--type": true,
  "--url": true,
  "--value": true,
};

const DISPLAY_AND_LOCATION_OPTIONS: Record<string, true> = {
  "--bool": true,
  "--bool-or-int": true,
  "--bool-or-str": true,
  "--expiry-date": true,
  "--fixed-value": true,
  "--global": true,
  "--includes": true,
  "--int": true,
  "--local": true,
  "--name-only": true,
  "--no-type": true,
  "--null": true,
  "--path": true,
  "--regexp": true,
  "--show-names": true,
  "--show-origin": true,
  "--show-scope": true,
  "--system": true,
  "--worktree": true,
};

export function isReadOnlyGitConfig(args: (string | undefined)[]): boolean {
  let isMutatingSubcommand = false;
  let hasReadAction = false;
  let operandCount = 0;

  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined) {
      return false;
    }

    if (word === "--") {
      operandCount = args.length - index - 1;
      break;
    }

    if (!word.startsWith("-") || word === "-") {
      if (isMutatingSubcommand) {
        continue;
      }

      if (word === "get" || word === "list") {
        return true;
      }

      if (Object.hasOwn(MUTATING_SUBCOMMANDS, word)) {
        isMutatingSubcommand = true;
        continue;
      }

      // Legacy config stops parsing options at the first positional operand.
      operandCount = args.length - index;
      break;
    }

    if (word.startsWith("--")) {
      const equals = word.indexOf("=");
      const option = equals === -1 ? word : word.slice(0, equals);
      if (Object.hasOwn(OPTIONS_WITH_VALUES, option)) {
        if (equals === -1) {
          index += 1;
        }
        continue;
      }
      if (word === "--help") {
        return true;
      }
      if (Object.hasOwn(LEGACY_READ_ACTIONS, word)) {
        hasReadAction = true;
        continue;
      }
      const positiveOption = word.replace(/^--no-/, "--");
      if (
        !Object.hasOwn(DISPLAY_AND_LOCATION_OPTIONS, word) &&
        !Object.hasOwn(DISPLAY_AND_LOCATION_OPTIONS, positiveOption)
      ) {
        return false;
      }
      continue;
    }

    for (let flagIndex = 1; flagIndex < word.length; flagIndex += 1) {
      const flag = word[flagIndex];
      if (flag === "f" || flag === "t") {
        if (flagIndex === word.length - 1) {
          index += 1;
        }
        break;
      }
      if (flag === "h") {
        return true;
      }
      if (flag === "l") {
        hasReadAction = true;
      } else if (flag !== "z") {
        return false;
      }
    }
  }

  // With no legacy action flag, one key reads it; a key plus a value writes it.
  return !isMutatingSubcommand && (hasReadAction || operandCount === 1);
}
