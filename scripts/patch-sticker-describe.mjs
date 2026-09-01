import { readFileSync, writeFileSync } from "node:fs";

const SENTINEL = "/* patched: sticker-describe-budget */";
const target = process.argv[2];
if (!target) {
	console.error("Usage: node patch-sticker-describe.mjs <file>");
	process.exit(1);
}

let src = readFileSync(target, "utf8");

if (src.includes(SENTINEL)) {
	console.log("ALREADY PATCHED (mjs check)");
	process.exit(0);
}

const anchor =
	`\t\treturn (await getTelegramRuntime().mediaUnderstanding.describeImageFileWithModel({\n` +
	`\t\t\tfilePath: imagePath,\n` +
	`\t\t\tmime: "image/webp",\n` +
	`\t\t\tcfg,\n` +
	`\t\t\tagentDir,\n` +
	`\t\t\tprovider,\n` +
	`\t\t\tmodel,\n` +
	`\t\t\tprompt: STICKER_DESCRIPTION_PROMPT,\n` +
	`\t\t\tmaxTokens: 150,\n` +
	`\t\t\ttimeoutMs: 3e4\n` +
	`\t\t}`;

if (!src.includes(anchor)) {
	console.error("ERROR: describeImageFileWithModel anchor not found — file structure changed");
	process.exit(1);
}

const patched = anchor
	.replace("maxTokens: 150,", "maxTokens: 2000,")
	.replace("timeoutMs: 3e4", "timeoutMs: 9e4");

src = src.replace(anchor, "\t\t" + SENTINEL + "\n" + patched);

writeFileSync(target, src, "utf8");
