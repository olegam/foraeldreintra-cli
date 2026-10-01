import { copyFile, mkdir } from "node:fs/promises";
const result = await Bun.build({
  entrypoints: ["packages/foraeldreintra-cli/src/index.ts"],
  target: "bun",
  outdir: "dist",
});
if (!result.success) {
  console.error("Build failed.");
  process.exit(1);
}
await mkdir("dist", { recursive: true });
await copyFile(
  "packages/foraeldreintra-cli/src/extract-docx.py",
  "dist/extract-docx.py",
);
console.log("Built dist/index.js and DOCX extraction helper.");
