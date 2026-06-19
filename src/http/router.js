"use strict";

// Tiny zero-dependency router over node:http.
const { authToken } = require("../config");
const engine = require("../analyze/engine");
const brief = require("../format/brief");

function send(res, status, body, contentType) {
	res.writeHead(status, { "Content-Type": contentType || "application/json; charset=utf-8" });
	res.end(typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

function authed(req, url) {
	if (!authToken) return true;
	const hdr = req.headers["authorization"] || "";
	const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
	return bearer === authToken || url.searchParams.get("key") === authToken;
}

function readBody(req) {
	return new Promise((resolve) => {
		let data = "";
		req.on("data", (c) => (data += c));
		req.on("end", () => {
			if (!data) return resolve({});
			try { resolve(JSON.parse(data)); }
			catch { resolve({ text: data }); }
		});
	});
}

// Build an analysis input from query params OR a JSON/text body.
function inputFrom(url, body) {
	if (body && body.text) return { ...engine.parseSignal(body.text), includeAccount: truthy(url.searchParams.get("account")) || body.includeAccount };
	const q = (k) => url.searchParams.get(k);
	const merged = {
		symbol: body.symbol || q("symbol") || q("sym"),
		direction: body.direction || q("dir") || q("direction"),
		entry: body.entry || q("entry"),
		targets: body.targets || q("tp") || q("targets"),
		stopLoss: body.stopLoss ?? q("sl"),
		leverage: body.leverage || q("lev"),
		includeAccount: body.includeAccount || truthy(q("account")),
	};
	if (merged.symbol) merged.symbol = String(merged.symbol).toUpperCase();
	return merged;
}

function truthy(v) {
	return v === true || v === "1" || v === "true" || v === "yes";
}

function wantsJson(url, req) {
	if (url.searchParams.get("format") === "json") return true;
	if (url.searchParams.get("format") === "md") return false;
	return (req.headers["accept"] || "").includes("application/json");
}

async function handle(req, res) {
	const url = new URL(req.url, "http://localhost");
	const path = url.pathname.replace(/\/+$/, "") || "/";

	if (path === "/health") return send(res, 200, { ok: true, ts: new Date().toISOString() });

	if (!authed(req, url)) return send(res, 401, { error: "unauthorized — provide ?key= or Bearer token" });

	try {
		// GET /snapshot/AVAXUSDT
		const snap = /^\/snapshot\/([A-Za-z0-9]+)$/.exec(path);
		if (snap && req.method === "GET") {
			const m = await engine.fetchMarket(snap[1].toUpperCase());
			return wantsJson(url, req)
				? send(res, 200, m)
				: send(res, 200, brief.snapshotBrief(m), "text/markdown; charset=utf-8");
		}

		// GET/POST /analyze
		if (path === "/analyze") {
			const body = req.method === "POST" ? await readBody(req) : {};
			const input = inputFrom(url, body);
			if (!input.symbol) return send(res, 400, { error: "missing symbol (or POST {text:'<signal>'})" });
			const a = await engine.analyzeSignal(input);
			return wantsJson(url, req)
				? send(res, 200, a)
				: send(res, 200, brief.analysisBrief(a), "text/markdown; charset=utf-8");
		}

		// POST /parse — just echo the parsed signal (debugging / preview)
		if (path === "/parse" && req.method === "POST") {
			const body = await readBody(req);
			return send(res, 200, engine.parseSignal(body.text || ""));
		}

		return send(res, 404, { error: "not found", routes: ["/health", "/snapshot/:symbol", "/analyze", "/parse"] });
	} catch (e) {
		return send(res, 500, { error: e.message });
	}
}

module.exports = { handle };
