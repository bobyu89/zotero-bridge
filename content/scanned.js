/*
 * ZotMax — scanned PDFs: is there usable full text, and what the AI gets when there isn't.
 * Pure functions apart from the injected `io` ({ stat, read }); loaded into the plugin scope by
 * bootstrap.js and required directly by the Node tests.
 *
 * Full-text status of an item (frontmatter `full_text`, Notion "Full Text"):
 *   ok      — the PDF (or EPUB/HTML snapshot) has a text layer
 *   partial — a PDF with very little text for its page count: mostly scanned pages
 *   none    — a PDF without a text layer (a scan), or only a download stamp
 *   no_pdf  — no PDF/EPUB/HTML file attachment on this computer
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) {
		module.exports = api;
	}
	else {
		(root.ZB = root.ZB || {}).scanned = api;
	}
})(this, function () {
	const STATUSES = ["ok", "partial", "none", "no_pdf"];
	// For the README and messages; the stored values are the codes above
	const STATUS_LABELS = {
		ok: "有全文",
		partial: "部分掃描（文字層不完整）",
		none: "掃描版（沒有文字層）",
		no_pdf: "沒有 PDF",
	};

	// Non-whitespace characters per page. A text page of a journal article has about 2,500–5,000,
	// a page that is mostly a figure or table still several hundred. A scan has none, apart from
	// publisher download stamps (about 100–200 per page) or an OCR'd cover page.
	const NONE_PER_PAGE = 100;
	const PARTIAL_PER_PAGE = 600;
	// Without a page count only a practically empty text layer can be called a scan
	const NONE_WITHOUT_PAGES = 20;
	// A non-PDF source (EPUB, HTML snapshot) counts as full text from this many characters on
	const MIN_OTHER_CHARS = 200;

	// Defaults for sending a scanned PDF to the AI (prefs llm.pdfMaxMB / llm.pdfMaxPages). Below the
	// documented API limits (Claude: 32 MB request, 100 pages on 200k-context models; OpenAI: 32 MB
	// of files per request), leaving room for base64 (+33%) and the prompt text.
	const PDF_MAX_MB = 20;
	const PDF_MAX_PAGES = 100;

	function countChars(text) {
		return String(text || "").replace(/\s+/g, "").length;
	}

	/**
	 * Status of one attachment.
	 * @param {object} s { isPDF, chars, pages (0/null = unknown) }
	 */
	function classifySource(s) {
		let chars = s.chars || 0;
		if (!s.isPDF) return chars >= MIN_OTHER_CHARS ? "ok" : "none";
		if (s.pages > 0) {
			let perPage = chars / s.pages;
			if (perPage < NONE_PER_PAGE) return "none";
			if (perPage < PARTIAL_PER_PAGE) return "partial";
			return "ok";
		}
		return chars < NONE_WITHOUT_PAGES ? "none" : "ok";
	}

	/**
	 * Item status from its text-bearing attachments (the best one wins: a text PDF plus a
	 * scanned supplement is "ok").
	 * @param {object[]} sources [{ key, isPDF, hasFile, chars, pages, path, title }]
	 * @returns {{ status, source, sources }} source: the attachment the status comes from
	 */
	function classifyFullText(sources) {
		let usable = (sources || []).filter(s => s.hasFile || s.chars > 0)
			.map(s => Object.assign({}, s, { status: classifySource(s) }))
			// An EPUB or snapshot without text is not a scan, just not useful
			.filter(s => s.isPDF || s.status === "ok");
		if (!usable.length) return { status: "no_pdf", source: null, sources: [] };
		let rank = st => STATUSES.indexOf(st);
		let best = usable.reduce((a, b) => (rank(b.status) < rank(a.status) ? b : a));
		return { status: best.status, source: best, sources: usable };
	}

	/** Characters per page of a source, rounded ("" when the page count is unknown). */
	function perPage(source) {
		return source && source.pages > 0 ? Math.round(source.chars / source.pages) : "";
	}

	/**
	 * Rough page count from the PDF bytes (count of /Type /Page objects); 0 when none are visible,
	 * e.g. because the page objects sit in compressed object streams.
	 */
	function countPDFPages(bytes) {
		let text = new TextDecoder("latin1").decode(bytes);
		let m = text.match(/\/Type\s*\/Page(?![A-Za-z])/g);
		return m ? m.length : 0;
	}

	const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

	/** Standard base64 (with padding, no line breaks), without depending on btoa() in the scope. */
	function bytesToBase64(bytes) {
		let parts = [];
		let n = bytes.length;
		let full = n - (n % 3);
		// Joined in chunks: one string per 3 bytes would be slow for a 20 MB file
		for (let start = 0; start < full; start += 0x6000) {
			let chunk = [];
			let end = Math.min(full, start + 0x6000);
			for (let i = start; i < end; i += 3) {
				let v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
				chunk.push(B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63]);
			}
			parts.push(chunk.join(""));
		}
		if (n % 3 === 1) {
			let v = bytes[full] << 16;
			parts.push(B64[v >> 18] + B64[(v >> 12) & 63] + "==");
		}
		else if (n % 3 === 2) {
			let v = (bytes[full] << 16) | (bytes[full + 1] << 8);
			parts.push(B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + "=");
		}
		return parts.join("");
	}

	function hasAnnotationContent(data) {
		return (data.attachments || []).some(att => (att.annotations || [])
			.some(a => String(a.text || "").trim() || String(a.comment || "").trim()));
	}

	function hasNotes(notesMarkdown) {
		return (notesMarkdown || []).some(n => n.md && n.md.trim());
	}

	/** Full text the AI can use: a scan's stray text (download stamps) doesn't count. */
	function usableFullText(data) {
		return !!(data.fullText && String(data.fullText).trim()) && data.fullTextStatus !== "none";
	}

	/** What the AI reads besides the full text, for messages: "摘要與劃線", "摘要", "書目資料"… */
	function readLabel(data, notesMarkdown) {
		let parts = [];
		if (String(data.abstract || "").trim()) parts.push("摘要");
		if (hasAnnotationContent(data)) parts.push("劃線");
		if (hasNotes(notesMarkdown)) parts.push("筆記");
		if (!parts.length) return "書目資料";
		return parts.length === 1 ? parts[0] : parts.slice(0, -1).join("、") + "與" + parts[parts.length - 1];
	}

	/** Is there anything for the AI to read besides the bibliographic fields? */
	function hasReadableInput(data, notesMarkdown, pdf) {
		return !!pdf || usableFullText(data) || !!String(data.abstract || "").trim()
			|| hasAnnotationContent(data) || hasNotes(notesMarkdown);
	}

	/** The provider can read a PDF file part (an OpenAI-compatible server behind a custom base URL may not). */
	function providerReadsPDF(llm) {
		return llm.provider !== "openai" || !String(llm.baseURL || "").trim();
	}

	/**
	 * Decide what goes to the AI for one item, reading the scanned PDF when it is to be sent.
	 * Never throws.
	 * @param {object} data item data (fullTextStatus, fullTextSource from the adapter)
	 * @param {object} llm settings.llm: { provider, baseURL, fullTextLimit, sendScannedPDF, pdfMaxMB, pdfMaxPages }
	 * @param {object} io { stat(path) → { size }, read(path) → Uint8Array }
	 * @returns {Promise<{ pdf, messages, skip }>} pdf: { data (base64), filename, pages, size } or null;
	 *   skip: true when there is nothing to read, so the AI must not be called
	 */
	async function prepareAIInput(data, llm, notesMarkdown, io) {
		let messages = [];
		let pdf = null;
		let status = data.fullTextStatus;
		// fullTextLimit 0 = the user chose not to send full text: no PDF either, and nothing to warn about
		let wantsFullText = (llm.fullTextLimit || 0) > 0;
		let source = data.fullTextSource;
		let reason = "";
		if (wantsFullText && llm.sendScannedPDF && (status === "none" || status === "partial") && source && source.path) {
			if (!providerReadsPDF(llm)) reason = "（使用自訂 API base URL 時不傳送 PDF）";
			else {
				let read = await readPDF(source, llm, io);
				pdf = read.pdf;
				reason = read.reason;
			}
		}
		if (!hasReadableInput(data, notesMarkdown, pdf)) {
			return { pdf: null, skip: true, messages: ["⚠️ 沒有全文、摘要、劃線或筆記可讀，略過 AI 筆記（避免 AI 憑空產生內容）"] };
		}
		if (wantsFullText) {
			let label = readLabel(data, notesMarkdown);
			let pages = pdf && pdf.pages ? `${pdf.pages} 頁，` : "";
			let sent = `已把 PDF 直接傳給 AI 讀（${pages}較耗 token）`;
			if (status === "none") {
				messages.push(pdf ? `⚠️ 掃描版 PDF（沒有文字層）：${sent}`
					: `⚠️ 掃描版 PDF（沒有文字層），AI 只讀了${label}${reason}`);
			}
			else if (status === "partial") {
				let avg = perPage(source);
				let head = `⚠️ PDF 大部分沒有文字層${avg !== "" ? `（每頁平均約 ${avg} 字）` : ""}`;
				messages.push(pdf ? `${head}：${sent}` : `${head}，AI 讀到的全文不完整${reason}`);
			}
			else if (status === "no_pdf") {
				messages.push(`⚠️ 沒有 PDF 全文，AI 只讀了${label}`);
			}
		}
		return { pdf, skip: false, messages };
	}

	async function readPDF(source, llm, io) {
		let maxMB = llm.pdfMaxMB > 0 ? llm.pdfMaxMB : PDF_MAX_MB;
		let maxPages = llm.pdfMaxPages > 0 ? llm.pdfMaxPages : PDF_MAX_PAGES;
		try {
			let size = (await io.stat(source.path)).size;
			if (size > maxMB * 1024 * 1024) {
				return { pdf: null, reason: `（PDF ${(size / 1024 / 1024).toFixed(1)} MB，超過 ${maxMB} MB，沒有傳給 AI）` };
			}
			if (source.pages > maxPages) {
				return { pdf: null, reason: `（PDF ${source.pages} 頁，超過 ${maxPages} 頁，沒有傳給 AI）` };
			}
			let bytes = await io.read(source.path);
			let pages = source.pages || countPDFPages(bytes) || null;
			if (pages > maxPages) {
				return { pdf: null, reason: `（PDF ${pages} 頁，超過 ${maxPages} 頁，沒有傳給 AI）` };
			}
			let filename = String(source.filename || source.title || "document").replace(/[\\/]/g, "_");
			if (!/\.pdf$/i.test(filename)) filename += ".pdf";
			return { pdf: { data: bytesToBase64(bytes), filename, pages, size: bytes.length }, reason: "" };
		}
		catch (e) {
			return { pdf: null, reason: `（無法讀取 PDF 檔：${e.message || e}）` };
		}
	}

	/**
	 * Run `generate(pdf)` (one LLM call). When the API rejects the attached PDF (HTTP 400 or 413:
	 * too many pages, too large, unsupported), retry once without it — unless that would leave the
	 * AI nothing to read. Sets data.aiReadPDF for the quote verification.
	 */
	async function generateWithPDF(input, data, notesMarkdown, generate, messages) {
		let pdf = input && input.pdf;
		data.aiReadPDF = !!pdf;
		try {
			return await generate(pdf || null);
		}
		catch (e) {
			if (!pdf || (e.status !== 400 && e.status !== 413) || !hasReadableInput(data, notesMarkdown, null)) throw e;
			data.aiReadPDF = false;
			let i = messages.findIndex(m => m.includes("已把 PDF 直接傳給 AI 讀"));
			let note = `⚠️ AI 無法讀取這份 PDF（${e.message || e}），改讀${readLabel(data, notesMarkdown)}`;
			if (i >= 0) messages.splice(i, 1, note);
			else messages.push(note);
			return generate(null);
		}
	}

	/**
	 * Sources for the quote verification (verify.verifyQuotes). When the AI read a scan, the text
	 * layer doesn't show what it read: quotes not found elsewhere are "⚠️ 無全文可查證", not "not found".
	 */
	function quoteSources(data, texts) {
		if (data.aiReadPDF || data.fullTextStatus === "none") {
			return { fullText: null, texts: [...(texts || []), data.fullText].filter(Boolean) };
		}
		return { fullText: data.fullText, texts };
	}

	return {
		STATUSES, STATUS_LABELS, NONE_PER_PAGE, PARTIAL_PER_PAGE, NONE_WITHOUT_PAGES, MIN_OTHER_CHARS,
		PDF_MAX_MB, PDF_MAX_PAGES, countChars, classifySource, classifyFullText, countPDFPages, bytesToBase64,
		readLabel, hasReadableInput, usableFullText, providerReadsPDF, prepareAIInput, generateWithPDF, quoteSources,
	};
});
