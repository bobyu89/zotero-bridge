// A small OpenAlex API stand-in for the citation-chase tests: single works by doi:/pmid:/W-id, and
// work lists for filter=cited_by:W… / cites:W… with per-page and cursor paging (meta.next_cursor).
function work(n, fields = {}) {
	return Object.assign({
		id: `https://openalex.org/W${n}`,
		doi: `https://doi.org/10.5555/w${n}`,
		display_name: `Work ${n} on nurse-led fall prevention`,
		publication_year: 2020,
		primary_location: { source: { display_name: "Journal of Nursing" } },
		cited_by_count: n,
		ids: { openalex: `https://openalex.org/W${n}` },
		type: "article",
		referenced_works: [],
	}, fields);
}

/**
 * @param {object} db { works: Work[], refs: { W1: [Work] }, citing: { W1: [Work] } }
 * @param {object} opts { fail(url, n) → response | undefined }
 */
function openAlexMock(db, opts = {}) {
	let log = [];
	let byKey = new Map();
	for (let w of db.works || []) {
		byKey.set(w.id.replace("https://openalex.org/", ""), w);
		if (w.doi) byKey.set("doi:" + w.doi.replace("https://doi.org/", "").toLowerCase(), w);
		if (w.ids && w.ids.pmid) byKey.set("pmid:" + w.ids.pmid.replace(/\D/g, ""), w);
	}
	let json = (status, body, headers = {}) => ({
		status, ok: status >= 200 && status < 300,
		headers: { get: k => (k.toLowerCase() in headers ? headers[k.toLowerCase()] : null) },
		text: async () => JSON.stringify(body),
	});
	let fetch = async (url) => {
		log.push(url);
		let failed = opts.fail && opts.fail(url, log.length);
		if (failed) {
			if (failed instanceof Error) throw failed;
			return failed;
		}
		let u = new URL(url);
		if (u.origin !== "https://api.openalex.org") return json(404, { error: "wrong host" });
		let path = decodeURIComponent(u.pathname);
		let m = /^\/works\/(.+)$/.exec(path);
		if (m) {
			let w = byKey.get(m[1].toLowerCase().startsWith("w") ? m[1].toUpperCase() : m[1].toLowerCase());
			return w ? json(200, w) : json(404, { error: "NotFoundError" });
		}
		if (path !== "/works") return json(404, {});
		let filter = u.searchParams.get("filter") || "";
		let fm = /^(cited_by|cites):(W\d+)$/.exec(filter);
		if (!fm) return json(400, { error: "bad filter" });
		let all = ((fm[1] === "cited_by" ? db.refs : db.citing) || {})[fm[2]] || [];
		all = all.slice().sort((a, b) => b.cited_by_count - a.cited_by_count);
		let per = Number(u.searchParams.get("per-page") || 25);
		let cursor = u.searchParams.get("cursor");
		let page = cursor === "*" ? 0 : Number(cursor.replace("p", ""));
		let results = all.slice(page * per, page * per + per);
		let more = page * per + per < all.length;
		return json(200, { meta: { count: all.length, per_page: per, next_cursor: more ? `p${page + 1}` : null }, results });
	};
	return { fetch, log };
}

module.exports = { work, openAlexMock };
