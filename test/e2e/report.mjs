// Prints the e2e results (<work-dir>/results.json, written by the harness inside Zotero) and exits
// non-zero unless every check passed. Adds a Markdown table to the GitHub job summary when run in CI.
// Usage: node test/e2e/report.mjs <work-dir>
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const work = process.argv[2];
const resultsPath = join(work, "results.json");
const logPath = join(work, "zotero.log");

function tail(path, n) {
	if (!existsSync(path)) return `(no ${path})`;
	return readFileSync(path, "utf8").split("\n").slice(-n).join("\n");
}

function summary(md) {
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
}

if (!existsSync(resultsPath)) {
	console.error(`\nNo ${resultsPath}: the harness never finished inside Zotero.`);
	console.error("Either Zotero did not start, the harness plugin was not installed/enabled, or Zotero was killed by the timeout.");
	console.error("Plugin/add-on related lines from zotero.log:");
	if (existsSync(logPath)) {
		let lines = readFileSync(logPath, "utf8").split("\n")
			.filter(l => /zotero-bridge|zb-e2e|AddonManager|XPIProvider|bootstrap|Error/i.test(l));
		console.error(lines.slice(-80).join("\n"));
	}
	console.error("\nLast 60 lines of zotero.log:\n" + tail(logPath, 60));
	summary("## Zotero e2e\n\n❌ No results: the harness never finished inside Zotero (see zotero.log in the artifact).");
	process.exit(1);
}

const results = JSON.parse(readFileSync(resultsPath, "utf8"));
console.log(`\nZotero ${results.zoteroVersion} (Gecko ${results.gecko}, ${results.platform}, ${results.locale}) — ${results.reason}`);
let rows = [];
for (let t of results.tests) {
	let mark = t.ok ? "PASS" : t.skipped ? "SKIP" : "FAIL";
	console.log(`${mark}  ${t.name}${t.ms !== undefined ? ` (${t.ms} ms)` : ""}`);
	if (!t.ok) {
		console.log(String(t.error).split("\n").map(l => "      " + l).join("\n"));
		for (let m of t.pluginErrors || []) console.log(`      plugin error: ${m.text} (${m.source})${m.stack ? "\n        " + m.stack.split("\n").join("\n        ") : ""}`);
		for (let m of t.otherConsoleErrors || []) console.log(`      other console error: ${m.text} (${m.source})`);
	}
	rows.push(`| ${t.ok ? "✅" : t.skipped ? "⏭️" : "❌"} | ${t.name} | ${t.ok ? "" : String(t.error).split("\n")[0].replace(/\|/g, "\\|")} |`);
}
let failed = results.tests.filter(t => !t.ok).length;
console.log(`\n${results.tests.length - failed}/${results.tests.length} passed`);
summary(`## Zotero e2e — Zotero ${results.zoteroVersion}\n\n| | Check | Error |\n|---|---|---|\n${rows.join("\n")}\n`);
process.exit(results.ok && !failed ? 0 : 1);
