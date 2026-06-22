"use strict";

// Shared store of recent OPEN channel signals — written by the userbot,
// read by the bot for the /alert "pick a signal" wizard.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "signals.json");

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
		fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
	} catch (e) {
		console.error("signals save:", e.message);
	}
}

module.exports = { load, save, FILE };
