import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const stableVersionPattern = /^\d+\.\d+\.\d+$/;

function compareReleaseVersions(left: bigint[], right: bigint[]): number {
  for (const [index, part] of left.entries()) {
    if (part < right[index]) {
      return -1;
    }
    if (part > right[index]) {
      return 1;
    }
  }

  return 0;
}

const packageData: unknown = JSON.parse(readFileSync("package.json", "utf8"));
if (
  typeof packageData !== "object" ||
  packageData === null ||
  !("version" in packageData) ||
  typeof packageData.version !== "string" ||
  !stableVersionPattern.test(packageData.version)
) {
  throw new Error("package.json must declare a semantic release version");
}
const packageVersion = packageData.version;

const tags = execFileSync("git", ["for-each-ref", "--format=%(refname:strip=2)", "refs/tags"], {
  encoding: "utf8",
});
let latestRelease: { tag: string; version: bigint[] } | undefined;

for (const tag of tags.split("\n")) {
  const tagVersion = tag.replace(/^v/, "");
  if (!stableVersionPattern.test(tagVersion)) {
    continue;
  }

  const version = tagVersion.split(".").map(BigInt);
  if (!latestRelease || compareReleaseVersions(version, latestRelease.version) > 0) {
    latestRelease = { tag, version };
  }
}

if (latestRelease) {
  const comparison = compareReleaseVersions(packageVersion.split(".").map(BigInt), latestRelease.version);
  if (comparison === 0) {
    throw new Error(`package version ${packageVersion} is unchanged from ${latestRelease.tag}; bump it before release`);
  }
  if (comparison < 0) {
    throw new Error(`package version ${packageVersion} is older than ${latestRelease.tag}`);
  }

  console.log(`release version ${packageVersion} (after ${latestRelease.tag})`);
} else {
  console.log(`release version ${packageVersion}`);
}
