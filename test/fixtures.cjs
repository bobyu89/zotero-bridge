// Shared sample item data, shaped like ZB.adapter.extractItemData() output
function sampleItem(overrides = {}) {
	return Object.assign({
		id: 1,
		key: "ABCD1234",
		libraryID: 1,
		libraryPath: "library",
		libraryRouteID: "user",
		libraryName: "My Library",
		itemType: "journalArticle",
		title: "Effects of nurse-led education on fall prevention: a randomized controlled trial",
		shortTitle: "",
		creators: [
			{ firstName: "Mei", lastName: "Chen", creatorType: "author" },
			{ firstName: "John", lastName: "Smith", creatorType: "author" },
			{ firstName: "Ann", lastName: "Editor", creatorType: "editor" },
		],
		date: "2024-03-01",
		year: "2024",
		publication: "Journal of Advanced Nursing",
		doi: "10.1111/jan.12345",
		url: "",
		abstract: "Background: Falls are common.\nMethods: RCT with 120 patients.",
		citationKey: "chen2024effects",
		tags: ["fall prevention", "RCT", "2024"],
		collections: ["碩論/文獻回顧", "Reading"],
		dateAdded: "2024-05-01T08:00:00Z",
		apa: "Chen, M., & Smith, J. (2024). Effects of nurse-led education on fall prevention. Journal of Advanced Nursing. https://doi.org/10.1111/jan.12345",
		attachments: [{
			key: "PDF00001",
			title: "Full Text PDF",
			contentType: "application/pdf",
			annotations: [
				{ key: "ANN00001", type: "highlight", text: "Falls decreased by 30%", comment: "key result\nsecond line", color: "#ffd400", pageLabel: "5", tags: ["result"] },
				{ key: "ANN00002", type: "note", text: "", comment: "check sample size", color: "#ff6666", pageLabel: "iv", tags: [] },
				{ key: "ANN00003", type: "image", text: "", comment: "", color: "#5fb236", pageLabel: "7", tags: [] },
			],
		}],
		notes: [],
		aiNote: null,
		fullText: null,
	}, overrides);
}

const AI_MD = `## 一句話摘要
護理師主導衛教可降低住院病人跌倒率 30%（[[Fall prevention]]）。

## 研究設計與方法
- 研究設計：randomized controlled trial
- 場域與樣本：N = 120
  - 子項目

## 關鍵概念
[[Fall prevention]]、[[Health education|衛教]]、[[Self-efficacy]]

## 可引用的句子
> "Falls decreased by 30%" (p. 5)
`;

module.exports = { sampleItem, AI_MD };
