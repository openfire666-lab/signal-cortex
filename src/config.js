"use strict";

// Zero-dependency .env loader — keeps the box deploy to "copy files + node".
const fs = require("fs");
const path = require("path");

(function loadDotenv() {
	const p = path.join(__dirname, "..", ".env");
	if (!fs.existsSync(p)) return;
	for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
		const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
		if (!m || line.trim().startsWith("#")) continue;
		let v = m[2];
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
			v = v.slice(1, -1);
		}
		if (process.env[m[1]] === undefined) process.env[m[1]] = v;
	}
})();

module.exports = {
	port: parseInt(process.env.PORT || "8090", 10),
	authToken: process.env.AUTH_TOKEN || "",
	bybit: {
		base: (process.env.BYBIT_BASE || "https://api.bybit.com").replace(/\/$/, ""),
		category: process.env.BYBIT_CATEGORY || "linear",
		key: process.env.BYBIT_API_KEY || "",
		secret: process.env.BYBIT_API_SECRET || "",
		recvWindow: process.env.BYBIT_RECV_WINDOW || "5000",
	},
};
