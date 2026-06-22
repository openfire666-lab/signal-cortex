"use strict";

// Daily equity snapshots for the P&L / equity-curve view.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "equity.json");

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
		fs.writeFileSync(FILE, JSON.stringify(list.slice(-400), null, 2));
	} catch (e) {
		console.error("equity save:", e.message);
	}
}

module.exports = { load, save };
