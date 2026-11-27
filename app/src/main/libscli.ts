// Linha de comando da injecao (a mesma do app), pros scripts engine/inject.sh e
// engine/restore.sh. Usa a mesma pasta de base que o app (dados do Electron), pra
// que script e app saibam o que devolver.
// Uso: node app/dist/libscli.js inject|restore [serial]
//      SRO_GAME=eu node app/dist/libscli.js inject [serial]   (cliente da Europa)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeSettings, parseGameVersion, resolveAdb, serialFor } from "../controller/settings";
import { setAdbBin, setEmulator } from "./adbbin";
import { injectEngine, resolveSerial, restoreGame, setBackupDir } from "./inject";

const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
const dataDir = path.join(appData, "sro-bot-app");
setBackupDir(path.join(dataDir, "game-backup"));

// Mesma configuracao do app (pasta do LDPlayer, instancia, adb).
let settings = normalizeSettings(null);
try {
  settings = normalizeSettings(JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8")));
} catch {
  /* sem configuracao: padrao */
}
// SRO_GAME=eu|global escolhe a versao do jogo so nesta execucao, sem mexer na
// configuracao do app.
if (process.env.SRO_GAME) settings = { ...settings, game: parseGameVersion(process.env.SRO_GAME) };
setEmulator(settings);
setAdbBin(resolveAdb(settings, fs.existsSync));
const [cmd, serialArg] = process.argv.slice(2);

const log = (m: string) => console.log(m);
const run = cmd === "inject" ? injectEngine : cmd === "restore" ? restoreGame : null;
if (!run) {
  console.error("uso: node libscli.js inject|restore [serial]");
  process.exit(2);
}
resolveSerial(serialArg ?? serialFor(settings)).then((serial) => run(serial, log)).catch((e) => {
  console.error(String(e));
  process.exit(1);
});
