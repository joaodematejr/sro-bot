// Todo teste em src/controller/__tests__ precisa estar no build:test e no test do
// package.json: o node --test ignora calado arquivo que nao existe, e um teste fora
// das listas nunca roda (cardalbum.test, 2026-11-12).
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts;
const names = fs.readdirSync(path.join(root, "src/controller/__tests__")).filter((f) => f.endsWith(".test.ts"));

const missing = [];
for (const f of names) {
  const base = f.slice(0, -3);
  if (!scripts["build:test"].includes(`src/controller/__tests__/${f}`)) missing.push(`${f} fora do build:test`);
  if (!scripts.test.includes(`dist/test/${base}.js`)) missing.push(`${base}.js fora do test`);
}
if (missing.length) {
  console.error("teste fora das listas do package.json:\n  " + missing.join("\n  "));
  process.exit(1);
}
