// Packs the plugin into dist/zotero-bridge-<version>.xpi (a zip file) without extra dependencies.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const INCLUDE = ["manifest.json", "bootstrap.js", "prefs.js", "content", "locale"];

function walk(path) {
	if (statSync(path).isDirectory()) {
		return readdirSync(path).sort().flatMap(name => walk(join(path, name)));
	}
	return [path];
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(buf) {
	let c = 0xffffffff;
	for (let b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function zip(entries) {
	let locals = [];
	let centrals = [];
	let offset = 0;
	// Fixed timestamp (1980-01-01) keeps builds reproducible
	let dosTime = 0;
	let dosDate = (0 << 9) | (1 << 5) | 1;
	for (let { name, data } of entries) {
		let nameBuf = Buffer.from(name, "utf8");
		let compressed = deflateRawSync(data, { level: 9 });
		let crc = crc32(data);
		let local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6); // UTF-8 names
		local.writeUInt16LE(8, 8); // deflate
		local.writeUInt16LE(dosTime, 10);
		local.writeUInt16LE(dosDate, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, nameBuf, compressed);

		let central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(8, 10);
		central.writeUInt16LE(dosTime, 12);
		central.writeUInt16LE(dosDate, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBuf);
		offset += local.length + nameBuf.length + compressed.length;
	}
	let centralSize = centrals.reduce((n, b) => n + b.length, 0);
	let end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, ...centrals, end]);
}

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const files = INCLUDE.flatMap(p => walk(join(root, p)));
const entries = files.map(f => ({ name: relative(root, f).split("\\").join("/"), data: readFileSync(f) }));
mkdirSync(join(root, "dist"), { recursive: true });
const out = join(root, "dist", `zotero-bridge-${manifest.version}.xpi`);
writeFileSync(out, zip(entries));
console.log(`Built ${relative(root, out)} (${entries.length} files)`);
