"use strict";

// ONE-TIME interactive login for the channel reader. Run on the box:
//   cd ~/signal-cortex && npm install && node bot/userbot-login.js
// Enter your phone, the code Telegram sends, and 2FA password (if any). It then
// prints a SESSION STRING (put in .env as TELEGRAM_SESSION) and lists your
// channels so you can pick Binance Killers (set BK_CHANNEL to its @username or id).
const readline = require("readline");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { userbot } = require("../src/config");

function ask(q) {
	return new Promise((res) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question(q, (a) => { rl.close(); res(a.trim()); });
	});
}

(async () => {
	if (!userbot.apiId || !userbot.apiHash) {
		console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first.");
		process.exit(1);
	}
	const client = new TelegramClient(new StringSession(""), userbot.apiId, userbot.apiHash, { connectionRetries: 5 });
	await client.start({
		phoneNumber: () => ask("Phone (international, e.g. +371...): "),
		password: () => ask("2FA password (leave blank if none): "),
		phoneCode: () => ask("Login code Telegram just sent you: "),
		onError: (e) => console.error(e),
	});

	console.log("\n================  TELEGRAM_SESSION (paste into .env)  ================\n");
	console.log(client.session.save());
	console.log("\n================  Your channels (pick Binance Killers)  ==============\n");
	const dialogs = await client.getDialogs({ limit: 200 });
	for (const d of dialogs) {
		if (d.isChannel || d.isGroup) {
			const uname = d.entity && d.entity.username ? "  @" + d.entity.username : "";
			console.log(`${(d.title || "").slice(0, 40).padEnd(42)} id ${String(d.id)}${uname}`);
		}
	}
	console.log("\nSet BK_CHANNEL to the @username if shown, else the id.");
	await client.disconnect();
	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
