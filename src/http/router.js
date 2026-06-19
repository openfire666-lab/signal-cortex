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

	// Permissive robots so Claude's web fetcher doesn't back off. Public market
	// data isn't sensitive; we only protect live account data (see below).
	if (path === "/robots.txt") {
		return send(res, 200, "User-agent: *\nAllow: /\n", "text/plain; charset=utf-8");
	}
	if (path === "/") {
		return send(res, 200,
			"signal-cortex — fresh Bybit signal analysis\n" +
			"GET /analyze?sym=AVAXUSDT&dir=long&entry=6.70-6.75&tp=7.05,7.35&sl=6.15&lev=2-5\n" +
			"GET /analyze/AVAXUSDT?dir=long&entry=...&tp=...&sl=...\n" +
			"GET /snapshot/AVAXUSDT\n" +
			"Add &account=1 (+ ?key=TOKEN) for your live Bybit position.\n",
			"text/plain; charset=utf-8");
	}

	try {
		// GET /snapshot/AVAXUSDT — public market data, open read
		const snap = /^\/snapshot\/([A-Za-z0-9]+)$/.exec(path);
		if (snap && req.method === "GET") {
			const m = await engine.fetchMarket(snap[1].toUpperCase());
			return wantsJson(url, req)
				? send(res, 200, m)
				: send(res, 200, brief.snapshotBrief(m), "text/markdown; charset=utf-8");
		}

		// GET/POST /analyze  or  /analyze/SYMBOL
		const am = /^\/analyze(?:\/([A-Za-z0-9]+))?$/.exec(path);
		if (am) {
			const body = req.method === "POST" ? await readBody(req) : {};
			const input = inputFrom(url, body);
			if (am[1] && !input.symbol) input.symbol = am[1].toUpperCase();
			if (!input.symbol) return send(res, 400, { error: "missing symbol (or POST {text:'<signal>'})" });
			// Public analysis is open read. Live ACCOUNT data needs the token.
			if (input.includeAccount && !authed(req, url)) {
				return send(res, 401, { error: "live account data requires ?key=<AUTH_TOKEN>" });
			}
			const a = await engine.analyzeSignal(input);
			return wantsJson(url, req)
				? send(res, 200, a)
				: send(res, 200, brief.analysisBrief(a), "text/markdown; charset=utf-8");
		}

		// POST /parse — preview how a pasted signal parses
		if (path === "/parse" && req.method === "POST") {
			const body = await readBody(req);
			return send(res, 200, engine.parseSignal(body.text || ""));
		}

		return send(res, 404, { error: "not found", routes: ["/health", "/snapshot/:symbol", "/analyze", "/analyze/:symbol", "/parse"] });
	} catch (e) {
		return send(res, 500, { error: e.message });
	}
}

module.exports = { handle };
