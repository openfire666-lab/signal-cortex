// Optional MCP surface (Phase 2) — same engine, exposed as MCP tools for
// Claude Code / desktop. Install deps first:  npm i @modelcontextprotocol/sdk zod
// Run:  node mcp/server.mjs   (stdio transport)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const engine = require("../src/analyze/engine.js");
const brief = require("../src/format/brief.js");

const server = new McpServer({ name: "signal-cortex", version: "0.1.0" });

server.tool(
	"market_snapshot",
	"Fresh Bybit market snapshot (price, multi-TF trend, levels, funding, OI) for a symbol like AVAXUSDT.",
	{ symbol: z.string() },
	async ({ symbol }) => {
		const m = await engine.fetchMarket(symbol.toUpperCase());
		return { content: [{ type: "text", text: brief.snapshotBrief(m) }] };
	},
);

server.tool(
	"analyze_signal",
	"Analyze a trade signal against FRESH Bybit data. Pass structured fields, or paste the raw signal block as `text`.",
	{
		symbol: z.string().optional(),
		direction: z.enum(["long", "short"]).optional(),
		entry: z.string().optional(),
		targets: z.string().optional(),
		stopLoss: z.number().optional(),
		leverage: z.string().optional(),
		text: z.string().optional(),
		includeAccount: z.boolean().optional(),
	},
	async (args) => {
		const input = args.text
			? { ...engine.parseSignal(args.text), includeAccount: args.includeAccount }
			: { ...args };
		if (input.symbol) input.symbol = input.symbol.toUpperCase();
		const a = await engine.analyzeSignal(input);
		return { content: [{ type: "text", text: brief.analysisBrief(a) }] };
	},
);

await server.connect(new StdioServerTransport());
