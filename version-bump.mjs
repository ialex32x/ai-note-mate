import { readFileSync, writeFileSync } from "fs";

// This script is only intended to run inside CI (the release workflow).
// The single source of truth for the plugin version is the pushed git tag,
// which CI exposes via TARGET_VERSION. A CLI arg is supported only to make
// the script easy to invoke manually for debugging.
const targetVersion = process.argv[2] || process.env.TARGET_VERSION;

if (!targetVersion) {
	console.error(
		"version-bump: no target version provided (set TARGET_VERSION or pass as arg)."
	);
	process.exit(1);
}

// Tags must already be normalized by the workflow, but double-check here so
// this script is also safe to run by hand.
if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(targetVersion)) {
	console.error(`version-bump: invalid semver "${targetVersion}" (must not start with "v").`);
	process.exit(1);
}

// read minAppVersion from manifest.json and bump version to target version
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

// update versions.json:
// versions.json is a fallback used when the user's Obsidian is older than
// manifest.json's minAppVersion.  Each entry is a threshold marker: "starting
// from plugin version X, you need Obsidian version Y".  Therefore we only add
// a new entry when minAppVersion actually changes; if it stays the same the
// existing entry is already sufficient.
const versions = JSON.parse(readFileSync("versions.json", "utf8"));

const alreadyHasMinAppVersion = Object.values(versions).includes(minAppVersion);
if (!alreadyHasMinAppVersion) {
	versions[targetVersion] = minAppVersion;
	writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");
}

console.log(`version-bump: set version to ${targetVersion} (minAppVersion ${minAppVersion}).`);
