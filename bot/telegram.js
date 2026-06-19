"use strict";

// Phase 3 — Telegram bot. Forward (or paste) a signal to the bot and it replies
// with fresh Bybit analysis. Zero-dependency: long-polls the Bot API with fetch,
// reuses the same engine as the HTTP service. Enable by setting TELEGRAM_BOT_TOKEN.
const { telegram } = require("../src/config");
const engine = require("../src/analyze/engine");
const brief = require("../src/format/brief");

const API = `https://api.telegram.org/bot${telegram.token}`;

async function call(method, params) {
	const res = await fetch(`${API}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(params),
	});
	return res.json();
}

function allowed(chatId) {
	if (!telegram.allowedChats.length) return true; // open if no allowlist set
	return telegram.allowedChats.includes(String(chatId));
}

// The brief is markdown; Telegram's parsers are brittle, so send clean plain text.
function plain(md) {
	return md.replace(/\*\*/g, "").replace(/^#+ /gm, "");
}

async function reply(chatId, text) {
	await call("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
}

async function handle(msg) {
	const chatId = msg.chat && msg.chat.id;
	if (!chatId) return;
	const text = msg.text || msg.caption || "";
	console.log(`msg from chat ${chatId} (${msg.chat.username || msg.chat.first_name || "?"})`);

	// /id always answers — even if not allow-listed — so you can discover your id.
	if (/^\/id\b/.test(text)) {
		return reply(chatId, `chat id: ${chatId}\nAdd it to TELEGRAM_ALLOWED_CHATS to lock the bot to you.`);
	}

	if (!allowed(chatId)) return;

	if (/^\/(start|help)/.test(text)) {
		return reply(chatId,
			"Forward me a signal (or paste one with COIN / Direction / ENTRY / TARGETS / STOP LOSS) " +
			"and I'll analyze it against fresh Bybit data.\n\n" +
			"Or send:  AVAXUSDT long 6.70-6.75 tp 7.05,7.35 sl 6.15");
	}

	const parsed = engine.parseSignal(text);
	if (!parsed.symbol) return; // not a signal — stay quiet

	try {
		const a = await engine.analyzeSignal(parsed);
		await reply(chatId, plain(brief.analysisBrief(a)));
	} catch (e) {
		await reply(chatId, `⚠ ${e.message}`);
	}
}

async function main() {
	if (!telegram.token) {
		console.error("TELEGRAM_BOT_TOKEN not set — bot disabled.");
		process.exit(1);
	}
	const me = await call("getMe");
	console.log(`telegram bot polling as @${me.result ? me.result.username : "?"}`);
	let offset = 0;
	for (;;) {
		try {
			const r = await call("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
			if (r.ok) {
				for (const u of r.result) {
					offset = u.update_id + 1;
					if (u.message) await handle(u.message).catch((e) => console.error("handle:", e.message));
				}
			}
		} catch (e) {
			console.error("poll:", e.message);
			await new Promise((r) => setTimeout(r, 3000));
		}
	}
}

main();
