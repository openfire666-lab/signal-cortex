"use strict";

// Persisted order-monitor state (last-seen open orders + which were "near"-alerted).
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "orderstate.json");

function load() {
	try {
		return JSON.parse(fs.readFileSync(FILE, "utf8")) || { orders: {}, near: [] };
	} catch {
		return { orders: {}, near: [] };
	}
}

function save(s) {
	try {
		fs.mkdirSync(path.dirname(FILE), { recursive: true });
		fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
	} catch (e) {
		console.error("orderstate save:", e.message);
	}
}

module.exports = { load, save };
