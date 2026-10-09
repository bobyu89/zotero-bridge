// Declare compatibility with a newer Zotero version without publishing a new release.
// Zotero reads `applications.zotero.strict_max_version` from updates.json for the installed
// version, so after testing on a new Zotero release run:
//   npm run compat -- 11.*
// then commit manifest.json and updates.json and push to main.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const max = process.argv[2];
if (!/^\d+(\.\d+)?\.\*$/.test(max || "")) {
	console.error("Usage: npm run compat -- <max version>, e.g. 11.*  or 10.2.*");
	process.exit(1);
}

const manifestPath = join(root, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.applications.zotero.strict_max_version = max;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const updatesPath = join(root, "updates.json");
const updates = JSON.parse(readFileSync(updatesPath, "utf8"));
const entries = updates.addons[manifest.applications.zotero.id].updates;
// Only the published version is changed; its .xpi and hash stay valid
const entry = entries.find(u => u.version === manifest.version);
if (!entry) {
	console.error(`updates.json has no entry for ${manifest.version}; run npm run build first`);
	process.exit(1);
}
entry.applications.zotero.strict_max_version = max;
writeFileSync(updatesPath, JSON.stringify(updates, null, 2) + "\n");
console.log(`ZotMax ${manifest.version} now declares Zotero up to ${max}`);
