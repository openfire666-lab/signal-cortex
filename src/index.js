"use strict";

const http = require("http");
const { port } = require("./config");
const { handle } = require("./http/router");

http.createServer((req, res) => {
	handle(req, res).catch((e) => {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: e.message }));
	});
}).listen(port, () => {
	console.log(`signal-cortex listening on :${port}`);
});
