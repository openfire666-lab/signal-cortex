"use strict";

// Tiny JSON-file store for active price watches (survives bot restarts).
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "watches.json");

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
		console.error("watches save:", e.message);
	}
}

module.exports = { load, save, FILE };
