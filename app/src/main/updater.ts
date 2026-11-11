// Atualizacao automatica pelos Releases do GitHub (electron-updater com o provider
// github do package.json; o release.yml publica o instalador, o latest.yml e o
// blockmap). So no app instalado (NSIS): o EXE portatil nao se atualiza e so ganha
// o aviso. Confere ao abrir e a cada CHECK_EVERY_MS e baixa sozinho, mas so instala
// quando o usuario clica: cada troca de versao tem o ok dele.

import fs from "node:fs";
import path from "node:path";

import { app, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";

// O que estava ligado quando o usuario clicou em Atualizar: o app novo, ao abrir,
// reabre o jogo (so reconecta) e religa o bot. Vale por RESUME_MAX_MS, pra nao
// religar numa abertura qualquer mais tarde.
export interface UpdateResume {
  game: boolean;
  bot: boolean;
}
const RESUME_MAX_MS = 10 * 60 * 1000;
const resumeFile = () => path.join(app.getPath("userData"), "update-resume.json");

// Le e apaga o aviso (uma vez so). null = nada a retomar.
export function takeUpdateResume(now = Date.now()): UpdateResume | null {
  try {
    const raw = JSON.parse(fs.readFileSync(resumeFile(), "utf8")) as Partial<UpdateResume> & { at?: number };
    fs.rmSync(resumeFile(), { force: true });
    if (typeof raw.at !== "number" || now - raw.at > RESUME_MAX_MS || now < raw.at) return null;
    return { game: raw.game === true, bot: raw.bot === true };
  } catch {
    return null;
  }
}

export type UpdateState =
  | { kind: "off"; reason: string }
  | { kind: "idle"; checkedAt: number }
  | { kind: "downloading"; version: string; pct?: number }
  | { kind: "ready"; version: string }
  | { kind: "error"; reason: string };

const CHECK_EVERY_MS = 2 * 60 * 60 * 1000;

let state: UpdateState = { kind: "off", reason: "nao iniciado" };

type Log = (msg: string) => void;
type Send = (s: UpdateState) => void;

// beforeInstall: o que fazer antes de fechar pra instalar (o main religa a caca do
// jogo se o Treino estiver rodando, pra o char nao ficar parado na troca).
export function setupUpdater(send: Send, log: Log, beforeInstall: () => Promise<void>): void {
  const set = (s: UpdateState) => {
    state = s;
    send(s);
  };
  ipcMain.handle("update:state", () => state);
  ipcMain.handle("update:resume", () => takeUpdateResume());
  ipcMain.handle("update:install", async (_e, resume?: UpdateResume) => {
    if (state.kind !== "ready") return false;
    log(`instalando a versao ${state.version}; o app reabre sozinho${resume?.bot ? " e religa o bot" : ""}.`);
    try {
      fs.writeFileSync(resumeFile(), JSON.stringify({ game: resume?.game === true, bot: resume?.bot === true, at: Date.now() }));
    } catch {
      /* sem disco: o usuario religa a mao */
    }
    await beforeInstall().catch(() => undefined);
    // isSilent: sem as telas do instalador; isForceRunAfter: reabre o app no fim.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return true;
  });
  if (!app.isPackaged) {
    set({ kind: "off", reason: "app de desenvolvimento" });
    return;
  }
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    set({ kind: "off", reason: "EXE portatil: versoes novas no Releases do GitHub (o instalador se atualiza sozinho)" });
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on("update-available", (i) => {
    log(`versao ${i.version} disponivel; baixando.`);
    set({ kind: "downloading", version: i.version });
  });
  autoUpdater.on("download-progress", (p) => {
    if (state.kind === "downloading") set({ ...state, pct: Math.round(p.percent) });
  });
  autoUpdater.on("update-downloaded", (i) => {
    log(`versao ${i.version} baixada: clique em "Atualizar" no topo pra instalar.`);
    set({ kind: "ready", version: i.version });
  });
  autoUpdater.on("update-not-available", () => {
    if (state.kind !== "ready") set({ kind: "idle", checkedAt: Date.now() });
  });
  autoUpdater.on("error", (e) => {
    const reason = String(e?.message ?? e).split("\n")[0].slice(0, 200);
    log(`atualizacao: ${reason}`);
    if (state.kind !== "ready") set({ kind: "error", reason });
  });
  const check = () => {
    if (state.kind === "ready" || state.kind === "downloading") return;
    autoUpdater.checkForUpdates().catch(() => undefined);
  };
  check();
  setInterval(check, CHECK_EVERY_MS);
}
