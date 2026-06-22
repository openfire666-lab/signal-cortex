"use strict";

// Channel signal history (for the scorecard). Written by the userbot as signals
// open and close; read by the bot's /stats. Capped to the most recent 500.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "history.json");

function load() {
	try {
		return JSON.parse(fs.readFileSync(FILE, "utf8")) || [];
	} catch {
		return [];
	}
}

function save(list) {
	try {
		fs.mkdirSync(path.dirname(FILE), { recursive: true });
		fs.writeFileSync(FILE, JSON.stringify(list.slice(0, 500), null, 2));
	} catch (e) {
		console.error("history save:", e.message);
	}
}

module.exports = { load, save, FILE };
