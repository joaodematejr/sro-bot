import { app, BrowserWindow, dialog, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";

import { isConnectionLostText, isKickedText, isSameChar, type LoginProfile, mergeProfile, parseCharTarget } from "../controller/login";
import { autoLogin, stopAutoLogin } from "./autologin";
import { BOX_UNLOCKING, type ContinentalConfig } from "../controller/continental";
import { floatFromBits } from "../controller/update";
import type { DemonTowerConfig } from "../controller/tower";
import { runContinental, stopContinental } from "./continental";
import { adbConnect, adbForward, queryPlayer, sendCommand, setAutoFight } from "./engine";
import {
  bringGameToFront,
  ensureEmulator,
  gameForeground,
  gameState,
  injectEngine,
  readGameFile,
  checkEnvironment,
  resolveSerial,
  restoreGame,
  setBackupDir,
  stopGame,
} from "./inject";
import { type GameState, reconnectPlan } from "../controller/libstate";
import { type AppSettings, consolePath, normalizeSettings, resolveAdb, serialFor } from "../controller/settings";
import { adbBin, setAdbBin, setEmulator } from "./adbbin";
import { runDemonTower, stopDemonTower } from "./tower";
import { hpPercent, readChannel, readEnemiesAround, readTrainSnapshot, safeToStopHunt, type TrainConfig } from "../controller/train";
import type { FirmConfig } from "../controller/firm";
import { runFirm, stopFirm } from "./firm";
import type { GuildConfig } from "../controller/guild";
import { runGuild, stopGuild } from "./guild";
import type { CardAlbumConfig } from "../controller/cardalbum";
import { previewCardAlbum, runCardAlbum, setCardAlbumDir, stopCardAlbum } from "./cardalbum";
import { runActChests } from "./actchest";
import { runFreebies } from "./freebies";
import { runGuildHallCheck, runQigongAccept, runQigongRequest, setQigongDir, setQigongObjvReader } from "./qigong";
import { pauseTrain, runTrain, stopTrain } from "./train";
import { gameIps, pingIp, setVpnDir, vpnDisable, vpnEnable, vpnHealth, vpnStatus } from "./vpn";
import { hasCredentials, saveCredentials, setCredentialsDir } from "./credentials";
import { alertTelegram, hasTelegramToken, linkTelegram, loadTelegram, saveTelegram, setTelegramDir, type TelegramSettings, testTelegram } from "./telegram";
import type { TelegramAlert } from "../controller/telegram";
import { setBoosterDir } from "./booster";
import { sellJunk, setObjvReader } from "./sell";
import { readBuild, setAttrReader } from "./build";
import { aiChat, type AppInfo, aiSnapshot, hasAiKey, loadAiSettings, providerModels, saveAiSettings, setAiDir } from "./ai";
import type { AiSettings, ChatMessage } from "../controller/ai";
import { flushHistory, historySummary, initHistory, recordEvent, recordSample } from "./history";
import type { HistEvent } from "../controller/history";
import { diagnosticFileName } from "../controller/diagnostic";
import { collectDiagnostic } from "./diagnostic";
import { setupUpdater } from "./updater";
import { isLocalizationKey, MAP_RADIUS_M, parseEnts, readMapGetp, readTeamIds } from "../controller/map";

// Configuracao de caminhos (pasta do LDPlayer, instancia, adb) na pasta de dados.
function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings(): AppSettings {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(settingsPath(), "utf8")));
  } catch {
    return normalizeSettings(null);
  }
}

let settings = loadSettings();
let SERIAL = process.env.SRO_SERIAL ?? serialFor(settings);
// Ultimo login feito pelo bot (char e servidor lido na tela antes do Let's go).
// Zera quando o jogo reabre; login manual fica sem servidor conhecido.
let lastLogin: { name?: string; server?: string } = {};

function applySettings(s: AppSettings): void {
  settings = s;
  setEmulator(s);
  setAdbBin(resolveAdb(s, fs.existsSync));
  SERIAL = process.env.SRO_SERIAL ?? serialFor(s);
}

// No MuMu a porta do adb sai do MuMuManager (so com a instancia aberta).
async function refreshSerial(): Promise<void> {
  if (!process.env.SRO_SERIAL) SERIAL = await resolveSerial(SERIAL);
}
applySettings(settings);

ipcMain.handle("settings:get", async () => {
  await refreshSerial();
  return { settings, serial: SERIAL, adb: adbBin() };
});

ipcMain.handle("settings:set", async (_e, raw: Partial<AppSettings>) => {
  const s = normalizeSettings(raw);
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
  applySettings(s);
  await refreshSerial();
  const warn = fs.existsSync(consolePath(s)) ? "" : `${consolePath(s)} nao achado`;
  return { settings, serial: SERIAL, adb: adbBin(), warn };
});

ipcMain.handle("settings:test", async () => {
  await refreshSerial();
  return checkEnvironment(SERIAL, settings.instance);
});
const HOST_PORT = 27105;

let win: BrowserWindow | null = null;

// Regiao/servidor/char do ultimo login (pra reusar quando o jogo pedir escolha).
function loginProfilePath(): string {
  return path.join(app.getPath("userData"), "login-profile.json");
}

function loadLoginProfile(): LoginProfile {
  try {
    return JSON.parse(fs.readFileSync(loginProfilePath(), "utf-8")) as LoginProfile;
  } catch {
    return {};
  }
}

function saveLoginProfile(p: LoginProfile): void {
  try {
    fs.writeFileSync(loginProfilePath(), JSON.stringify(p, null, 2));
  } catch (e) {
    win?.webContents.send("sro:log", "nao salvou o perfil de login: " + String(e));
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b0d10",
    title: "SRO Bot",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, "index.html"));
}

// Funcoes expostas ao renderer via IPC.
ipcMain.handle("engine:setup", async () => {
  await adbConnect(SERIAL);
  await adbForward(SERIAL, HOST_PORT);
  return { serial: SERIAL, port: HOST_PORT };
});

ipcMain.handle("engine:player", async () => {
  return queryPlayer("127.0.0.1", HOST_PORT);
});

// Mapa ao vivo (aba Mapa): uma leitura por chamada. ENTS quando o engine tem;
// senao a leitura reserva pelo GETP. O time e o nome do mapa mudam pouco: o time
// e relido a cada 30 s e o nome so quando a cena muda.
let mapTeam = { ids: new Set<number>(), at: 0 };
let mapScene = { id: -1, name: "" };
const mapNames = new Map<string, string>();
ipcMain.handle("engine:map", async () => {
  const q = (tag: string, body: string) => sendCommand("127.0.0.1", HOST_PORT, tag, body);
  if (Date.now() - mapTeam.at > 30000) mapTeam = { ids: await readTeamIds(q), at: Date.now() };
  const r = await q("ENTS", String(MAP_RADIUS_M));
  const snap = parseEnts(r, mapTeam.ids) ?? (await readMapGetp(q, mapTeam.ids));
  if (!snap) return null;
  // Nome de NPC vem como chave: traduz e guarda (no maximo 10 novas por leitura).
  let fresh = 0;
  for (const e of snap.ents) {
    if (!isLocalizationKey(e.name)) continue;
    if (!mapNames.has(e.name) && fresh++ < 10) {
      const t = await q("GETP", `Localization Localize:"${e.name}"`);
      mapNames.set(e.name, typeof t.str === "string" && t.str !== e.name ? t.str : "");
    }
    e.name = mapNames.get(e.name) ?? "";
  }
  const sc = await q("GETP", "XScene get_SceneID");
  const scene = sc.ok === true && typeof sc.int === "number" ? sc.int : -1;
  if (scene !== mapScene.id) {
    const nm = scene > 0 ? await q("GETP", `Localization Localize:"SceneList_Comment_${scene}"`) : {};
    const name = typeof nm.str === "string" && !nm.str.startsWith("SceneList_") ? nm.str : "";
    mapScene = { id: scene, name };
  }
  const ln = await q("GETP", "ChannelDocument get_CurrentLineID");
  const line = ln.ok === true && typeof ln.int === "number" ? ln.int : undefined;
  const ch = line ? await q("GETP", `ChannelDocument LineIDToLine:${line}`) : {};
  return { ...snap, scene, sceneName: mapScene.name, channel: typeof ch.int === "number" ? ch.int : undefined };
});

// Mochila: espacos livres e ocupados (so leitura; pro aviso de mochila cheia).
ipcMain.handle("engine:bag", async () => {
  const q = (body: string) => sendCommand("127.0.0.1", HOST_PORT, "GETP", body);
  const e = await q("XBagDocument GetEmptySlotCount");
  const u = await q("XBagDocument ItemBag Items get_Count");
  return {
    empty: e.ok === true && typeof e.int === "number" ? e.int : undefined,
    used: u.ok === true && typeof u.int === "number" ? u.int : undefined,
  };
});

// True se o jogo esta em primeiro plano (watchdog usa pra decidir reabrir).
ipcMain.handle("engine:gamefg", async () => {
  return gameForeground(SERIAL);
});

// Reabre o jogo: se o processo esta vivo (so em background), traz pra frente;
// se morreu, injeta e sobe de novo. Refaz o forward nos dois casos.
// O jogo mostra "Connection failed" (caiu a conexao: "lost") ou "logged in on
// another device" (outro aparelho entrou na conta: "kicked")? "" = nenhum.
ipcMain.handle("engine:connlost", async () => {
  const q = (tag: string, body: string) => sendCommand("127.0.0.1", HOST_PORT, tag, body);
  const vis = await q("SKIL", "getv ModalDlg IsVisible");
  if (vis.bool !== true) return "";
  const t = await q("GETP", "ModalDlg m_uiBehaviour m_Label GetText");
  const text = typeof t.str === "string" ? t.str : undefined;
  return isKickedText(text) ? "kicked" : isConnectionLostText(text) ? "lost" : "";
});

// `restart` = fecha o jogo antes (conexao caida: o jogo segue aberto, mas parado).
ipcMain.handle("engine:reopen", async (_e, restart?: boolean) => {
  const push = (m: string) => win?.webContents.send("sro:log", "[watchdog] " + m);
  try {
    if (restart) {
      push("conexao com o servidor caiu: reiniciando o jogo...");
      await stopGame(SERIAL);
    } else {
      // Mesmo cuidado do engine:inject: adb sem resposta nao vira "jogo fechado"
      // (reinjetar fecha o jogo).
      const game = await gameState(SERIAL);
      if (game === "unknown") {
        push("adb sem resposta: nao reinicio o jogo; tento de novo na proxima checagem.");
        return { ok: false, erro: "adb sem resposta" };
      }
      if (game === "running") {
        await bringGameToFront(SERIAL, push);
        await adbForward(SERIAL, HOST_PORT);
        return { ok: true, mode: "front" };
      }
    }
    lastLogin = {};
    SERIAL = await ensureEmulator(SERIAL, push);
    await adbConnect(SERIAL);
    await injectEngine(SERIAL, push);
    await adbForward(SERIAL, HOST_PORT);
    return { ok: true, mode: "inject" };
  } catch (e) {
    push("reabrir falhou: " + String(e));
    return { ok: false, erro: String(e) };
  }
});

ipcMain.handle("engine:autofight", async (_e, on: boolean) => {
  return setAutoFight("127.0.0.1", HOST_PORT, on);
});

// Vende agora a lista fixa de lixo (botao do Treino).
ipcMain.handle("engine:selljunk", async () => {
  const q = (tag: string, body: string) => sendCommand("127.0.0.1", HOST_PORT, tag, body);
  const push = (m: string) => win?.webContents.send("sro:log", "[venda] " + m);
  return sellJunk(q, push);
});

// Desliga a caca so se for seguro (fora de combate e sem monstro perto); senao
// deixa ligada pro auto-play do jogo seguir defendendo o char.
ipcMain.handle("engine:autofightoff", async () => {
  const q = (tag: string, body: string) => sendCommand("127.0.0.1", HOST_PORT, tag, body);
  const s = await readTrainSnapshot(q);
  if (s?.inWorld && !s.dead) {
    const near = await readEnemiesAround(q, s.pos);
    const hpPct = hpPercent(s.hp, s.maxHp);
    if (!safeToStopHunt(s.inCombat, near, hpPct)) return { kept: true, inCombat: !!s.inCombat, near, hpPct: hpPct === undefined ? undefined : Math.round(hpPct) };
  }
  await setAutoFight("127.0.0.1", HOST_PORT, false);
  return { kept: false };
});

// Roda o Demon Locking Tower (por metodo, guiado por estado) com a config do painel.
ipcMain.handle("engine:tower", async (_e, cfg: DemonTowerConfig) => {
  const push = (m: string) => win?.webContents.send("sro:log", "[tower] " + m);
  return runDemonTower("127.0.0.1", HOST_PORT, cfg, push);
});

ipcMain.handle("engine:towerstop", async () => {
  stopDemonTower();
});

// Roda o Continental Exploration (por metodo, guiado por estado) com a config do painel.
ipcMain.handle("engine:continental", async (_e, cfg: ContinentalConfig) => {
  const push = (m: string) => win?.webContents.send("sro:log", "[continental] " + m);
  return runContinental("127.0.0.1", HOST_PORT, cfg, push);
});

ipcMain.handle("engine:continentalstop", async () => {
  stopContinental();
});

// Segundos que faltam pro bau que esta destravando (null = nenhum destravando).
// SlotBoxInfo fica lido depois de uma passada no tabuleiro.
ipcMain.handle("engine:chestleft", async () => {
  const q = (tag: string, body: string) => sendCommand("127.0.0.1", HOST_PORT, tag, body);
  const keys = await q("KEYS", "XSuperRiskDocument SlotBoxInfo");
  let left: number | null = null;
  for (const k of Array.isArray(keys.keys) ? (keys.keys as number[]) : []) {
    const st = await q("GETP", `XSuperRiskDocument SlotBoxInfo get_Item:${k} state`);
    if (st.int !== BOX_UNLOCKING) continue;
    const lt = await q("GETP", `XSuperRiskDocument SlotBoxInfo get_Item:${k} leftTime`);
    if (typeof lt.int === "number") left = Math.min(left ?? Infinity, Math.max(0, floatFromBits(lt.int)));
  }
  return left;
});

// Firm (tarefa diaria de guilda): aceita no Leebaek, entrega e pede ajuda.
ipcMain.handle("engine:firm", async (_e, cfg: FirmConfig) => {
  const push = (m: string) => win?.webContents.send("sro:log", "[firm] " + m);
  return runFirm("127.0.0.1", HOST_PORT, cfg, push);
});

ipcMain.handle("engine:firmstop", async () => {
  stopFirm();
});

// Guild utilities: sign-in, baus do sign-in, salario (red packet so avisa).
ipcMain.handle("engine:guild", async (_e, cfg: GuildConfig) => {
  const push = (m: string) => win?.webContents.send("sro:log", "[guilda] " + m);
  return runGuild("127.0.0.1", HOST_PORT, cfg, push);
});

ipcMain.handle("engine:guildstop", async () => {
  stopGuild();
});

// Album de cards: analisa sobras seguras e ativa/sobe/quebra excedentes.
ipcMain.handle("engine:cardalbumpreview", async (_e, cfg: CardAlbumConfig) => {
  const push = (m: string) => win?.webContents.send("sro:log", "[cards] " + m);
  return previewCardAlbum("127.0.0.1", HOST_PORT, cfg, push);
});

ipcMain.handle("engine:cardalbum", async (_e, cfg: CardAlbumConfig) => {
  const push = (m: string) => win?.webContents.send("sro:log", "[cards] " + m);
  return runCardAlbum("127.0.0.1", HOST_PORT, cfg, push);
});

ipcMain.handle("engine:cardalbumstop", async () => {
  stopCardAlbum();
});

// Baus de atividade diaria: pega os liberados (so metodo, com a caca ligada).
ipcMain.handle("engine:actchest", async () => {
  const push = (m: string) => win?.webContents.send("sro:log", "[atividade] " + m);
  return runActChests("127.0.0.1", HOST_PORT, push);
});

// Gratis do dia: Event Pack com preco 0, attendance e caixinha do Daily Pack (so metodo).
ipcMain.handle("engine:freebies", async (_e, donate: boolean) => {
  const push = (m: string) => win?.webContents.send("sro:log", "[gratis] " + m);
  return runFreebies("127.0.0.1", HOST_PORT, push, donate === true);
});

// Qigong: aceitar (checagem rapida) e pedir (passada de pedidos).
ipcMain.handle("engine:qigongaccept", async () => {
  const push = (m: string) => win?.webContents.send("sro:log", "[qigong] " + m);
  return runQigongAccept("127.0.0.1", HOST_PORT, push);
});

ipcMain.handle("engine:qigongrequest", async () => {
  const push = (m: string) => win?.webContents.send("sro:log", "[qigong] " + m);
  return runQigongRequest("127.0.0.1", HOST_PORT, push);
});

ipcMain.handle("engine:guildhallcheck", async () => {
  const push = (m: string) => win?.webContents.send("sro:log", "[qigong] " + m);
  return runGuildHallCheck("127.0.0.1", HOST_PORT, push);
});

ipcMain.handle("engine:loginstop", async () => {
  stopAutoLogin();
});

// Treino completo: prepara o auto-play do jogo, liga a caca e vigia ate parar.
ipcMain.handle("app:version", () => app.getVersion());

// Treino rodando agora: antes de fechar pra atualizar, a caca do jogo e religada.
let trainRunning = false;
ipcMain.handle("engine:train", async (_e, cfg: TrainConfig) => {
  const push = (m: string) => win?.webContents.send("sro:log", "[treino] " + m);
  trainRunning = true;
  try {
    return await runTrain("127.0.0.1", HOST_PORT, cfg, push);
  } finally {
    trainRunning = false;
  }
});

ipcMain.handle("engine:trainstop", async () => {
  stopTrain();
});

// Pausa segura do treino (vai pra cidade e conclui); null cancela.
ipcMain.handle("engine:trainpause", async (_e, reason: string | null) => {
  pauseTrain(reason);
});

// Ponto de treino = onde o char esta agora (cena + posicao).
ipcMain.handle("engine:trainspot", async () => {
  const q = (tag: string, body: string) => sendCommand("127.0.0.1", HOST_PORT, tag, body);
  const s = await readTrainSnapshot(q);
  if (!s?.inWorld || !s.pos || s.scene === undefined) return { ok: false, erro: "char fora de mundo" };
  // Logo depois do login a posicao vem (0, 0, 0) por alguns segundos (visto ao vivo).
  if (s.pos[0] === 0 && s.pos[2] === 0)
    return { ok: false, erro: "a posicao do char ainda nao carregou; tente de novo em alguns segundos" };
  const { channel } = await readChannel(q);
  return { ok: true, spot: { scene: s.scene, x: s.pos[0], y: s.pos[1], z: s.pos[2], channel } };
});

// Troca de personagem pro Continental (os dados sao por char): reinicia o jogo
// (o engine continua injetado nas libs) e loga no char pedido. Nao grava o char
// no perfil: o perfil continua apontando pro principal. "Nome@Servidor" troca
// tambem de servidor (o id sai da lista lida na tela do login).
ipcMain.handle("engine:switchchar", async (_e, entry: string) => {
  const push = (m: string) => win?.webContents.send("sro:log", "[continental] " + m);
  const { name, server } = parseCharTarget(entry);
  push(`trocando pro char ${name}${server ? ` (${server})` : ""}...`);
  try {
    await stopGame(SERIAL);
    await adbForward(SERIAL, HOST_PORT);
    const saved = loadLoginProfile();
    const target = server && !(saved.serverName ?? "").startsWith(server)
      ? { ...saved, charName: name, serverName: server, serverId: undefined }
      : { ...saved, charName: name };
    lastLogin = {};
    const { ok, profile } = await autoLogin(SERIAL, "127.0.0.1", HOST_PORT, true, (m) => push("login: " + m), 240000, target);
    if (ok) lastLogin = { name: profile.charName, server: profile.serverName };
    if (ok && profile.charName !== name) return { ok: false, erro: `entrou com ${profile.charName ?? "?"}` };
    return ok ? { ok: true } : { ok: false, erro: "login nao concluiu" };
  } catch (e) {
    return { ok: false, erro: String(e) };
  }
});

// O char em mundo e o pedido ("Nome" ou "Nome@Servidor")? Com o servidor do
// ultimo login, separa chars de mesmo nome em servidores diferentes.
ipcMain.handle("engine:ischar", async (_e, entry: string) => {
  const p = await queryPlayer("127.0.0.1", HOST_PORT);
  if (!p.ok || !p.name) return false;
  return isSameChar({ name: p.name, server: lastLogin.name === p.name ? lastLogin.server : undefined }, entry);
});

// Char principal (perfil de login salvo) no formato da lista: "Nome@Servidor".
// O Continental volta pra ele no fim do ciclo, pra Firm e Treino rodarem nele.
ipcMain.handle("engine:mainchar", async () => {
  const p = loadLoginProfile();
  return p.charName ? `${p.charName}${p.serverName ? `@${p.serverName}` : ""}` : "";
});

// Injeta o engine (troca o libmain pelo loader) e sobe o jogo. Depois faz o
// forward da porta. O log vai para o renderer em tempo real.
ipcMain.handle("engine:inject", async () => {
  const push = (m: string) => win?.webContents.send("sro:log", m);
  try {
    // Jogo ja injetado e o char em mundo (ex.: o app foi reaberto): so reconecta.
    // Reiniciar deixava o char parado no ponto de caca sem cliente; com o relogin
    // demorando 4 min o char principal morreu (2026-11-07 21:37). O engine e perguntado
    // primeiro (o forward do adb sobrevive ao app); adb sem resposta nunca
    // reinicia (2026-11-09 10:08, ver reconnectPlan).
    const inWorld = async () => {
      const p = await queryPlayer("127.0.0.1", HOST_PORT).catch(() => ({ ok: false }) as { ok: boolean; name?: string });
      return p.ok ? p : undefined;
    };
    let p = await inWorld();
    let game: GameState = p ? "running" : "unknown";
    for (let i = 0; !p && i < 3; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 2000));
      await adbConnect(SERIAL).catch(() => undefined);
      game = await gameState(SERIAL);
      if (game === "running") {
        await adbForward(SERIAL, HOST_PORT).catch(() => undefined);
        p = await inWorld();
      }
      if (game !== "unknown") break;
    }
    const plan = reconnectPlan(!!p, game);
    if (plan === "reconnect") {
      push(`jogo ja aberto com o engine e ${p?.name ?? "o char"} em mundo: conectado sem reiniciar.`);
      return { ok: true };
    }
    if (plan === "abort") {
      push("adb sem resposta: nao da pra saber se o jogo esta aberto, entao nao reinicio. Clique de novo em alguns segundos.");
      return { ok: false, erro: "adb sem resposta" };
    }
    lastLogin = {};
    SERIAL = await ensureEmulator(SERIAL, push);
    await adbConnect(SERIAL);
    await injectEngine(SERIAL, push);
    await adbForward(SERIAL, HOST_PORT);
    push(`forward ok (host ${HOST_PORT} -> device 27100)`);
    return { ok: true };
  } catch (e) {
    push("injecao falhou: " + String(e));
    return { ok: false, erro: String(e) };
  }
});

// Devolve as libs do jogo ao que estavam antes da injecao e confere o md5.
ipcMain.handle("engine:restore", async () => {
  const push = (m: string) => win?.webContents.send("sro:log", m);
  try {
    await adbConnect(SERIAL);
    await restoreGame(SERIAL, push);
    return { ok: true };
  } catch (e) {
    push("restauracao falhou: " + String(e));
    return { ok: false, erro: String(e) };
  }
});

// Eco dos logs do renderer no stdout do main (observabilidade do watchdog).
ipcMain.on("ui:log", (_e, m: string) => {
  // eslint-disable-next-line no-console
  console.log("[ui]", m);
});

ipcMain.handle("engine:autologin", async () => {
  const lines: string[] = [];
  // So abre o jogo se ele nao estiver rodando: o login por metodo parte de
  // qualquer tela do login, sem reiniciar (antes o tap exigia tela limpa).
  const launch = (await gameState(SERIAL)) === "stopped";
  const push = (m: string) => {
    lines.push(m);
    win?.webContents.send("sro:log", "[login] " + m);
  };
  const before = loadLoginProfile();
  const { ok, profile } = await autoLogin(SERIAL, "127.0.0.1", HOST_PORT, launch, push, 240000, before);
  // Servidor so e conhecido se o login passou pelo painel nesta vez.
  if (ok) lastLogin = { name: profile.charName, server: profile.serverName };
  const saved = mergeProfile(before, profile);
  saveLoginProfile(saved);
  push(
    `perfil de login: regiao ${saved.regionName ?? "?"} (${saved.regionId ?? "?"}), ` +
      `servidor ${saved.serverName ?? "?"} (id ${saved.serverId ?? "?"}), char ${saved.charName ?? "?"}`,
  );
  return { ok, log: lines.join("\n") };
});

// Rota do jogo por VPN gratuita (WireGuard + WARP). Ligar e desligar pede
// administrador; o status e os IPs do jogo nao.
ipcMain.handle("vpn:status", async () => {
  const st = await vpnStatus();
  let seen: string[] = [];
  let missing: string[] = [];
  try {
    ({ seen, missing } = await gameIps(SERIAL));
  } catch {
    // emulador ou jogo fechado: sem IPs do jogo agora
  }
  return { ...st, seen, missing };
});

ipcMain.handle("vpn:enable", async (_e, ips: string[]) => {
  const push = (m: string) => win?.webContents.send("sro:log", "[vpn] " + m);
  try {
    let seen: string[] = [];
    try {
      ({ seen } = await gameIps(SERIAL));
    } catch {
      // sem jogo aberto: vai so com os IPs pedidos e os fixos
    }
    return { ok: true, status: await vpnEnable([...ips, ...seen], push) };
  } catch (e) {
    push("falhou: " + (e instanceof Error ? e.message : String(e)));
    return { ok: false, erro: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle("vpn:disable", async () => {
  const push = (m: string) => win?.webContents.send("sro:log", "[vpn] " + m);
  try {
    return { ok: true, status: await vpnDisable(push) };
  } catch (e) {
    push("falhou: " + (e instanceof Error ? e.message : String(e)));
    return { ok: false, erro: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle("vpn:health", async () => {
  await vpnHealth((m) => win?.webContents.send("sro:log", "[vpn] " + m));
});

ipcMain.handle("vpn:ping", async (_e, ip: string) => {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return {};
  return pingIp(ip);
});

// Conta do jogo (login da Gamo): o renderer so grava e sabe se ha uma salva; a
// senha nunca volta pra ele.
ipcMain.handle("cred:get", async () => ({ has: hasCredentials() }));
ipcMain.handle("cred:set", async (_e, id: string, pwd: string) => {
  try {
    saveCredentials(String(id ?? ""), String(pwd ?? ""));
    return { ok: true, has: hasCredentials() };
  } catch (e) {
    return { ok: false, erro: e instanceof Error ? e.message : String(e), has: hasCredentials() };
  }
});

// Avisos pelo Telegram: o token so entra (criptografado) e nunca volta pro renderer.
const tgState = () => ({ settings: loadTelegram(), hasToken: hasTelegramToken() });
const tgErr = (e: unknown) => ({ ok: false, erro: e instanceof Error ? e.message : String(e), ...tgState() });
ipcMain.handle("tg:get", async () => tgState());
ipcMain.handle("tg:set", async (_e, s: Partial<TelegramSettings>, token?: string) => {
  try {
    saveTelegram(s ?? {}, typeof token === "string" ? token : undefined);
    return { ok: true, ...tgState() };
  } catch (e) {
    return tgErr(e);
  }
});
ipcMain.handle("tg:link", async () => {
  try {
    await linkTelegram();
    await testTelegram();
    return { ok: true, ...tgState() };
  } catch (e) {
    return tgErr(e);
  }
});
ipcMain.handle("tg:test", async () => {
  try {
    await testTelegram();
    return { ok: true, ...tgState() };
  } catch (e) {
    return tgErr(e);
  }
});
ipcMain.handle("tg:alert", async (_e, a: TelegramAlert, charName?: string) => {
  try {
    return { ok: true, sent: await alertTelegram(a, typeof charName === "string" ? charName : undefined) };
  } catch (e) {
    return { ok: false, erro: e instanceof Error ? e.message : String(e) };
  }
});

// Aba de IA (opcional, so sugere; modo Manual nao faz chamada de rede).
ipcMain.handle("ai:get", async () => ({ settings: loadAiSettings(), hasKey: hasAiKey() }));

ipcMain.handle("ai:set", async (_e, s: Partial<AiSettings>, key?: string) => {
  try {
    return { ok: true, settings: saveAiSettings(s, key), hasKey: hasAiKey() };
  } catch (e) {
    return { ok: false, erro: e instanceof Error ? e.message : String(e) };
  }
});

async function aiState(appInfo: AppInfo) {
  const route = (await vpnStatus()).service === "running" ? "VPN (WARP)" : "direta";
  const snap = await aiSnapshot("127.0.0.1", HOST_PORT, appInfo, route);
  const q = (tag: string, body: string) => sendCommand("127.0.0.1", HOST_PORT, tag, body);
  snap.build = await readBuild(q, snap.char?.level).catch(() => undefined);
  const h = historySummary(24 * 3600 * 1000);
  const hm = (ts: number) => new Date(ts).toTimeString().slice(0, 5);
  snap.history = {
    areas: h.areas.slice(0, 8).map(({ area, minutes, expPerHour, minHpPct, deaths }) => ({ area, minutes, expPerHour, minHpPct, deaths })),
    events: h.events.slice(0, 12).map((e) => `${hm(e.ts)} ${e.kind}: ${e.text}`),
  };
  return snap;
}

// Historico (SQLite): amostra por minuto, eventos do log e o resumo pras telas.
ipcMain.handle("hist:tick", async (_e, training: boolean) => {
  try {
    return !!(await recordSample("127.0.0.1", HOST_PORT, training));
  } catch {
    return false;
  }
});
ipcMain.handle("hist:event", async (_e, ev: HistEvent) => recordEvent(ev));
ipcMain.handle("hist:summary", async (_e, hours: number) => historySummary(Math.max(1, Math.min(24 * 30, hours)) * 3600 * 1000));

// Diagnostico: o painel manda o log e o localStorage; o main junta versoes e os
// .json da pasta de dados (nunca os .bin) e pergunta onde salvar.
ipcMain.handle("diag:export", async (_e, local: Record<string, string>, log: string) => {
  const when = new Date();
  let history: unknown;
  try {
    history = historySummary(24 * 3600 * 1000);
  } catch (e) {
    history = "sem historico: " + String(e);
  }
  const text = collectDiagnostic(app.getPath("userData"), {
    when,
    versions: { app: app.getVersion(), electron: process.versions.electron, os: `${process.platform} ${process.getSystemVersion()}`, serial: SERIAL },
    local,
    history,
    log,
  });
  const r = win
    ? await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("downloads"), diagnosticFileName(when)), filters: [{ name: "Texto", extensions: ["txt"] }] })
    : { canceled: true, filePath: undefined };
  if (r.canceled || !r.filePath) return { ok: false, erro: "cancelado" };
  fs.writeFileSync(r.filePath, text, "utf-8");
  return { ok: true, path: r.filePath };
});

ipcMain.handle("ai:snapshot", async (_e, appInfo: AppInfo) => aiState(appInfo));

ipcMain.handle("ai:chat", async (_e, history: ChatMessage[], appInfo: AppInfo) => {
  try {
    return { ok: true, text: await aiChat(history, await aiState(appInfo)) };
  } catch (e) {
    return { ok: false, erro: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle("ai:models", async () => providerModels());

// Base das libs (o libmain.so que estava antes da injecao) por emulador, fora do repo.
setBackupDir(path.join(app.getPath("userData"), "game-backup"));
setVpnDir(path.join(app.getPath("userData"), "vpn"));
setAiDir(app.getPath("userData"));
setCredentialsDir(app.getPath("userData"));
setTelegramDir(app.getPath("userData"));
setBoosterDir(app.getPath("userData"));
setQigongDir(app.getPath("userData"));
setCardAlbumDir(app.getPath("userData"));
setObjvReader(() => readGameFile(SERIAL, "sro_objv.txt"));
setQigongObjvReader(() => readGameFile(SERIAL, "sro_objv.txt"));
setAttrReader(() => readGameFile(SERIAL, "sro_attrvals.txt"));

app.whenReady().then(async () => {
  try {
    await initHistory(app.getPath("userData"), __dirname);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log("historico desligado: " + String(e));
  }
  createWindow();
  setupUpdater(
    (s) => win?.webContents.send("update:status", s),
    (m) => win?.webContents.send("sro:log", "[update] " + m),
    // Fechar o app no meio de uma viagem do Treino deixaria a caca desligada: religa
    // antes (com o char em mundo), como nas trocas de EXE feitas a mao.
    async () => {
      if (!trainRunning) return;
      const p = await queryPlayer("127.0.0.1", HOST_PORT).catch(() => ({ ok: false }));
      if (p.ok) await setAutoFight("127.0.0.1", HOST_PORT, true);
    },
  );
});

app.on("before-quit", () => flushHistory(true));

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
