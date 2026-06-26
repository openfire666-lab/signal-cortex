"use strict";

// Phase 4 — channel reader (GramJS userbot). Reads new posts AS YOU, distinguishes
// fresh ENTRY signals from target/stop "summary" updates, keeps a list of OPEN
// signals (for the bot's /alert wizard), and pushes fresh signals to your bot DM.
// Read-only — never trades. Needs npm install + TELEGRAM_SESSION + BK_CHANNEL.
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { userbot, telegram } = require("../src/config");
const engine = require("../src/analyze/engine");
const brief = require("../src/format/brief");
const sigStore = require("./signals");
const histStore = require("./history");

const BOT_API = `https://api.telegram.org/bot${telegram.token}`;
let openSignals = sigStore.load();
let history = histStore.load();
let lastSeenId = 0;

const plain = (md) => md.replace(/\*\*/g, "").replace(/^#+ /gm, "");

async function notify(text) {
	for (const id of telegram.allowedChats) {
		await fetch(`${BOT_API}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: id, text, disable_web_page_preview: true }),
		}).catch((e) => console.error("notify:", e.message));
	}
}

function classify(text) {
	const id = (text.match(/SIGNAL ID:\s*#?(\d+)/i) || [])[1] || null;
	const hasEntry = /ENTRY:\s*[\d.]/i.test(text);
	const isUpdate = /Target\s*\d+\s*:.*✅/i.test(text)
		|| /STOP\s*LOSS:.*(🚫|Loss)/i.test(text)
		|| /\b(Profit|Loss)\s*\(/i.test(text);
	return { id, hasEntry, isUpdate };
}

function addOpen(sig) {
	openSignals = openSignals.filter((s) => s.id !== sig.id && s.symbol !== sig.symbol);
	openSignals.unshift({ ...sig, ts: Date.now() });
	openSignals = openSignals.slice(0, 12);
	sigStore.save(openSignals);
}

function closeOpen(id, symbol) {
	const before = openSignals.length;
	openSignals = openSignals.filter((s) => !((id && s.id === id) || (symbol && s.symbol === symbol)));
	if (openSignals.length !== before) sigStore.save(openSignals);
}

// ── scorecard history ─────────────────────────────────────────────────────────
function recordOpen(sig) {
	if (sig.id && history.find((h) => h.id === sig.id)) return;
	history.unshift({ id: sig.id, symbol: sig.symbol, direction: sig.direction, entry: sig.entry, targets: sig.targets, sl: sig.sl, posted: Date.now(), status: "open", targetsHit: 0, pnlPct: null, closed: null });
	history = history.slice(0, 500);
	histStore.save(history);
}

function recordOutcome(id, symbol, o) {
	let rec = id ? history.find((h) => h.id === id) : null;
	if (!rec) rec = history.find((h) => h.symbol === symbol && h.status === "open");
	if (!rec) {
		rec = { id, symbol, direction: null, entry: null, targets: null, sl: null, posted: null, status: "open", targetsHit: 0, pnlPct: null, closed: null };
		history.unshift(rec);
	}
	if (o.targetsHit != null && o.targetsHit > (rec.targetsHit || 0)) rec.targetsHit = o.targetsHit;
	if (o.stopped) { rec.status = "lost"; if (o.pnlPct != null) rec.pnlPct = -Math.abs(o.pnlPct); }
	else { rec.status = "won"; if (o.pnlPct != null) rec.pnlPct = Math.abs(o.pnlPct); }
	rec.closed = Date.now();
	histStore.save(history);
}

// Process one channel message. doNotify=false during startup backfill.
async function ingest(text, doNotify) {
	if (!text) return;
	const { id, hasEntry, isUpdate } = classify(text);
	const parsed = engine.parseSignal(text);

	if (hasEntry && parsed.symbol) {
		const sig = { id, symbol: parsed.symbol, direction: parsed.direction, entry: parsed.entry, targets: parsed.targets, sl: parsed.stopLoss };
		addOpen(sig);
		recordOpen(sig);
		if (doNotify) {
			const a = await engine.analyzeSignal({ ...parsed, includeAccount: telegram.allowedChats.length > 0 });
			const score = a.score || 0;
			if (score < userbot.minScore) { console.log(`skip push: ${parsed.symbol} score ${score} < ${userbot.minScore}`); return; }
			const emoji = score >= 70 ? "🟢" : score >= 50 ? "🟡" : "🔴";
			await notify(`📡 ${emoji} ${userbot.channel || "VIP"} — ${parsed.symbol} ${String(parsed.direction).toUpperCase()} (score ${score})\n\n` + plain(brief.analysisBrief(a)));
		}
		return;
	}

	if (isUpdate && parsed.symbol) {
		closeOpen(id, parsed.symbol);
		const hits = (text.match(/Target\s*\d+\s*:[^✅]*✅/gi) || []).length;
		const pm = text.match(/([\d.]+)\s*%\s*(Profit|Loss)/i);
		const pnlNum = pm ? parseFloat(pm[1]) : null;
		const stopped = /STOP\s*LOSS:.*🚫/i.test(text) || (pm && /Loss/i.test(pm[2]));
		recordOutcome(id, parsed.symbol, { targetsHit: hits, pnlPct: pnlNum, stopped });
		if (doNotify) {
			await notify(`📕 ${parsed.symbol} update — ${stopped ? "stopped out. " : hits ? hits + " target(s) hit. " : ""}${pm ? pm[0] : ""}`.trim());
		}
		return;
	}
}

// Dedup wrapper — process each message once, tracking the highest id seen.
async function handleMsg(msg, doNotify) {
	const id = (msg && msg.id) || 0;
	if (id && id <= lastSeenId) return;
	if (id) lastSeenId = Math.max(lastSeenId, id);
	await ingest((msg && (msg.message || msg.text)) || "", doNotify);
}

(async () => {
	if (!userbot.apiId || !userbot.session) {
		console.error("userbot not configured — need TELEGRAM_API_ID/HASH/SESSION (run userbot-login.js).");
		process.exit(1);
	}
	if (!telegram.token || !telegram.allowedChats.length) {
		console.error("Need TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_CHATS to push the analysis to you.");
		process.exit(1);
	}
	const client = new TelegramClient(new StringSession(userbot.session), userbot.apiId, userbot.apiHash, { connectionRetries: 5 });
	await client.connect();
	const me = await client.getMe();
	try { await client.getDialogs({ limit: 200 }); } catch (e) { console.error("getDialogs:", e.message); }
	const ch = /^-?\d+$/.test(userbot.channel) ? Number(userbot.channel) : userbot.channel;

	// Backfill recent signals (no push) so the wizard/scorecard have data at once.
	try {
		const ms = await client.getMessages(ch, { limit: 40 });
		for (const m of ms.slice().reverse()) await handleMsg(m, false).catch(() => {});
		console.log(`backfill: ${openSignals.length} open signals, lastSeenId ${lastSeenId}`);
	} catch (e) { console.error("backfill:", e.message); }

	// Live stream (fast path).
	const filter = userbot.channel ? { chats: [ch] } : {};
	client.addEventHandler(
		(e) => handleMsg(e.message, true).catch((err) => console.error("live:", err.message)),
		new NewMessage(filter),
	);

	// Safety-net poller — GramJS update streams can silently stop after a
	// reconnect/TIMEOUT; every 3 min re-fetch and push anything the stream missed.
	setInterval(async () => {
		try {
			const ms = await client.getMessages(ch, { limit: 30 });
			for (const m of ms.slice().reverse()) await handleMsg(m, true).catch(() => {});
		} catch (e) { console.error("poll:", e.message); }
	}, 180000);

	console.log(`userbot connected as ${me.username || me.firstName}; reading ${userbot.channel || "ALL chats"} → bot DM (poll every 3m)`);
})().catch((e) => { console.error(e); process.exit(1); });
