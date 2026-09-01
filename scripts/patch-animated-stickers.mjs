import { readFileSync, writeFileSync } from "node:fs";

const SENTINEL = "/* patched: animated-sticker-frame-extraction */";
const target = process.argv[2];
if (!target) {
	console.error("Usage: node patch-animated-stickers.mjs <file>");
	process.exit(1);
}

let src = readFileSync(target, "utf8");

if (src.includes(SENTINEL)) {
	console.log("ALREADY PATCHED (mjs check)");
	process.exit(0);
}

const skipBlock =
	`if (sticker.is_animated || sticker.is_video) {\n` +
	`\t\tlogVerbose("telegram: skipping animated/video sticker (only static stickers supported)");\n` +
	`\t\treturn null;\n` +
	`\t}\n`;

if (!src.includes(skipBlock)) {
	console.error("ERROR: skip block not found (exact match failed)");
	process.exit(1);
}

src = src.replace(skipBlock, SENTINEL + "\n");

const downloadAnchor =
	`const saved = await downloadAndSaveTelegramFile({\n` +
	`\t\tfilePath: file.file_path,\n` +
	`\t\ttoken,\n` +
	`\t\ttransport,\n` +
	`\t\tmaxBytes,\n` +
	`\t\tapiRoot: params.apiRoot,\n` +
	`\t\ttrustedLocalFileRoots: params.trustedLocalFileRoots,\n` +
	`\t\tdangerouslyAllowPrivateNetwork: params.dangerouslyAllowPrivateNetwork,\n` +
	`\t\tabortSignal\n` +
	`\t});`;

if (!src.includes(downloadAnchor)) {
	console.error("ERROR: downloadAndSaveTelegramFile call-site anchor not found");
	process.exit(1);
}

const frameExtraction = downloadAnchor + `
\t\tif ((sticker.is_video || sticker.is_animated) && saved.path) {
\t\t\tconst framePath = saved.path.replace(/\\.[^.]+$/, "_frame.png");
\t\t\ttry {
\t\t\t\tconst { execFileSync } = await import("node:child_process");
\t\t\t\tif (sticker.is_video) {
\t\t\t\t\texecFileSync("ffmpeg", ["-i", saved.path, "-frames:v", "1", "-f", "image2", framePath, "-y"], { timeout: 10000 });
\t\t\t\t} else {
\t\t\t\t\texecFileSync("/home/k/.openclaw/bin/tgs2png", [saved.path, framePath], { timeout: 15000 });
\t\t\t\t}
\t\t\t\tsaved.path = framePath;
\t\t\t\tsaved.contentType = "image/webp";
\t\t\t\tlogVerbose(\`telegram: extracted frame from \${sticker.is_video ? "video" : "animated"} sticker\`);
\t\t\t} catch (e) {
\t\t\t\tlogVerbose(\`telegram: sticker frame extraction failed: \${e.message}\`);
\t\t\t\treturn null;
\t\t\t}
\t\t}`;

src = src.replace(downloadAnchor, frameExtraction);

writeFileSync(target, src, "utf8");
