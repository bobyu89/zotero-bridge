// The committed .xpi and updates.json must match, or Zotero's auto-update rejects the download
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..");

test("updates.json lists the current version with the hash of the committed .xpi", () => {
	let manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
	let updates = JSON.parse(fs.readFileSync(path.join(ROOT, "updates.json"), "utf8"));
	let entry = updates.addons[manifest.applications.zotero.id].updates.find(u => u.version === manifest.version);
	assert.ok(entry, "run `npm run build` after changing the version");
	let xpi = fs.readFileSync(path.join(ROOT, "dist", `zotero-bridge-${manifest.version}.xpi`));
	assert.equal(entry.update_hash, "sha256:" + crypto.createHash("sha256").update(xpi).digest("hex"),
		"dist/*.xpi is stale: run `npm run build`");
	assert.equal(entry.update_link,
		`https://github.com/bobyu89/zotero-bridge/releases/download/v${manifest.version}/zotero-bridge-${manifest.version}.xpi`);
});

// Read our own zip format (no data descriptors) back into { name: Buffer }
function readZip(buf) {
	let zlib = require("node:zlib");
	let files = {};
	let off = 0;
	while (buf.readUInt32LE(off) === 0x04034b50) {
		let method = buf.readUInt16LE(off + 8);
		let size = buf.readUInt32LE(off + 18);
		let nameLen = buf.readUInt16LE(off + 26);
		let extraLen = buf.readUInt16LE(off + 28);
		let name = buf.slice(off + 30, off + 30 + nameLen).toString("utf8");
		let start = off + 30 + nameLen + extraLen;
		let data = buf.slice(start, start + size);
		files[name] = method === 8 ? zlib.inflateRawSync(data) : data;
		off = start + size;
	}
	return files;
}

test("the committed .xpi contains exactly the current sources", () => {
	let manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
	let files = readZip(fs.readFileSync(path.join(ROOT, "dist", `zotero-bridge-${manifest.version}.xpi`)));
	let walk = p => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap(n => walk(path.join(p, n))) : [p]);
	let sources = ["manifest.json", "bootstrap.js", "prefs.js", "content", "locale"]
		.flatMap(p => walk(path.join(ROOT, p)))
		.map(f => path.relative(ROOT, f).split(path.sep).join("/"));
	assert.deepEqual(Object.keys(files).sort(), sources.sort());
	for (let name of sources) {
		assert.ok(files[name].equals(fs.readFileSync(path.join(ROOT, name))), `${name} in dist/*.xpi is stale: run \`npm run build\``);
	}
});
