// Writes the two PDFs the e2e test imports (no dependencies):
//   text.pdf — one page with a real text layer (Helvetica), about 2,500 characters
//   scan.pdf — one page with only an image, like a scan without OCR
// Usage: node test/e2e/make-fixtures.mjs <dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function buildPDF(objects) {
	// objects[i] is the body of object i+1: a string, or { dict, stream: Buffer }
	let parts = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
	let offset = parts[0].length;
	let offsets = [];
	objects.forEach((obj, i) => {
		offsets.push(offset);
		let chunk;
		if (typeof obj === "string") {
			chunk = Buffer.from(`${i + 1} 0 obj\n${obj}\nendobj\n`, "latin1");
		}
		else {
			chunk = Buffer.concat([
				Buffer.from(`${i + 1} 0 obj\n<< ${obj.dict} /Length ${obj.stream.length} >>\nstream\n`, "latin1"),
				obj.stream,
				Buffer.from("\nendstream\nendobj\n", "latin1"),
			]);
		}
		parts.push(chunk);
		offset += chunk.length;
	});
	let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
		+ offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")
		+ `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
	parts.push(Buffer.from(xref, "latin1"));
	return Buffer.concat(parts);
}

const SENTENCES = [
	"Falls are a leading cause of injury among older adults living in the community.",
	"This randomised trial tested a twelve week exercise programme delivered by nurses.",
	"Participants in the intervention group trained balance and strength three times a week.",
	"The primary outcome was the rate of falls during twelve months of follow up.",
	"Secondary outcomes were fear of falling, gait speed and quality of life scores.",
	"The intervention reduced the rate of falls by thirty percent compared with usual care.",
	"Adherence to the programme was high and no serious adverse events were reported.",
	"Nurses can deliver structured exercise safely in primary care and home settings.",
];

function textPDF() {
	let lines = [];
	for (let i = 0; i < 4; i++) lines.push(...SENTENCES);
	let escape = s => s.replace(/[\\()]/g, m => "\\" + m);
	let content = ["BT", "/F1 9 Tf", "11 TL", "40 760 Td"]
		.concat(lines.map(l => `(${escape(l)}) Tj T*`))
		.concat(["ET"]).join("\n");
	return buildPDF([
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
		{ dict: "", stream: Buffer.from(content, "latin1") },
	]);
}

function scanPDF() {
	// 64×64 grey "scan" with a few darker stripes
	let size = 64;
	let pixels = Buffer.alloc(size * size);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) pixels[y * size + x] = y % 8 < 2 ? 60 : 230;
	}
	return buildPDF([
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
		{ dict: `/Type /XObject /Subtype /Image /Width ${size} /Height ${size} /ColorSpace /DeviceGray /BitsPerComponent 8`, stream: pixels },
		{ dict: "", stream: Buffer.from("q 512 0 0 692 50 50 cm /Im1 Do Q", "latin1") },
	]);
}

const dir = process.argv[2];
if (!dir) {
	console.error("usage: node test/e2e/make-fixtures.mjs <dir>");
	process.exit(2);
}
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "text.pdf"), textPDF());
writeFileSync(join(dir, "scan.pdf"), scanPDF());
console.log(`wrote text.pdf and scan.pdf to ${dir}`);
