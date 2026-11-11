// Logica do renderer: conecta, le o estado do jogador pelo engine e desenha.

import { chestDelayMs } from "../controller/continental";
import { type AiAction, parseActions, stripActions, validateAction } from "../controller/aiactions";
import { activityExpLine, eventFromLog, type ExpPoint } from "../controller/history";
import { unsignedExp } from "../controller/train";
import { bagLevel, bagStep, bagText, type BagWatch } from "../controller/bag";
import { dueDailies, gameDay } from "../controller/daily";
import { luckyMoneyWindow } from "../controller/freebies";
import { QIGONG_REQUEST_EVERY_MS } from "../controller/qigong";
import { EXP_KEEP_MS, expDropText, type ExpPoint as RatePoint, type ExpWatch, expWatchStep } from "../controller/expwatch";

interface PlayerState {
  ok: boolean;
  player?: string;
  name?: string;
  level?: number;
  exp?: number;
  maxExp?: number;
  hp?: number;
  maxHp?: number;
  mp?: number;
  maxMp?: number;
  dead?: boolean;
  inCombat?: boolean;
  autoPlayOn?: boolean;
  aiFighting?: boolean;
  corrected?: [number, number, number];
  next?: [number, number, number];
  erro?: string;
}

// Estado da atualizacao pelos Releases (espelha o UpdateState do main/updater.ts).
interface UpdateUiState {
  kind: "off" | "idle" | "downloading" | "ready" | "error";
  version?: string;
  pct?: number;
  reason?: string;
}

declare global {
  interface Window {
    sro: {
      setup: () => Promise<{ serial: string; port: number }>;
      player: () => Promise<PlayerState>;
      inject: () => Promise<{ ok: boolean; erro?: string }>;
      restore: () => Promise<{ ok: boolean; erro?: string }>;
      gameForeground: () => Promise<boolean>;
      reopen: (restart?: boolean) => Promise<{ ok: boolean; mode?: string; erro?: string }>;
      connectionLost: () => Promise<"" | "lost" | "kicked">;
      autoFight: (on: boolean) => Promise<{ ok?: boolean; method?: number; erro?: string }>;
      autoFightOffSafe: () => Promise<{ kept: boolean; inCombat?: boolean; near?: number; hpPct?: number }>;
      sellJunk: () => Promise<number>;
      runTower: (cfg: {
        refreshOnFailure: boolean;
        sweep: boolean;
        fightOnceBeforeSweeping: boolean;
        refreshRewardRatio: number;
        useBuff: boolean;
      }) => Promise<{ ok: boolean; erro?: string }>;
      stopTower: () => Promise<void>;
      runContinental: (cfg: ContinentalUiConfig) => Promise<{ ok: boolean; erro?: string; restart?: boolean }>;
      stopContinental: () => Promise<void>;
      chestLeft: () => Promise<number | null>;
      aiGet: () => Promise<{ settings: AiSettingsUi; hasKey: boolean }>;
      aiSet: (s: AiSettingsUi, key?: string) => Promise<{ ok: boolean; erro?: string; settings?: AiSettingsUi; hasKey?: boolean }>;
      aiSnapshot: (appInfo: AiAppInfo) => Promise<Record<string, unknown>>;
      aiChat: (history: AiMsg[], appInfo: AiAppInfo) => Promise<{ ok: boolean; text?: string; erro?: string }>;
      aiModels: () => Promise<string[]>;
      credGet: () => Promise<{ has: boolean }>;
      bag: () => Promise<{ empty?: number; used?: number }>;
      credSet: (id: string, pwd: string) => Promise<{ ok: boolean; erro?: string; has: boolean }>;
      histTick: (training: boolean) => Promise<boolean>;
      histEvent: (ev: { ts: number; kind: string; text: string }) => Promise<void>;
      histSummary: (hours: number) => Promise<{
        areas: { area: string; minutes: number; expPerHour: number; minHpPct?: number; deaths: number }[];
        events: { ts: number; kind: string; text: string }[];
        samples: number;
      }>;
      switchChar: (name: string) => Promise<{ ok: boolean; erro?: string }>;
      mainChar: () => Promise<string>;
      isChar: (entry: string) => Promise<boolean>;
      runTrain: (cfg: TrainUiConfig) => Promise<{ ok: boolean; erro?: string; deaths?: number; reason?: string }>;
      stopTrain: () => Promise<void>;
      pauseTrain: (reason: string | null) => Promise<void>;
      trainSpot: () => Promise<{ ok: boolean; erro?: string; spot?: TrainSpotUi }>;
      runFirm: (cfg: FirmUiConfig) => Promise<{ ok: boolean; erro?: string; submitted?: number }>;
      stopFirm: () => Promise<void>;
      runGuild: (cfg: GuildUiConfig) => Promise<{ ok: boolean; erro?: string; done?: number }>;
      stopGuild: () => Promise<void>;
      runActChests: () => Promise<{ ok: boolean; erro?: string; done?: number; reason?: string }>;
      runFreebies: (donate: boolean) => Promise<{ ok: boolean; erro?: string; done?: number; reason?: string }>;
      qigongAccept: () => Promise<{ ok: boolean; accepted?: string; erro?: string }>;
      guildHallCheck: () => Promise<{ ok: boolean; left?: boolean }>;
      qigongRequest: () => Promise<{ ok: boolean; done: number; erro?: string }>;
      getSettings: () => Promise<SettingsView>;
      setSettings: (s: SettingsUi) => Promise<SettingsView>;
      testSettings: () => Promise<{ name: string; ok: boolean; detail: string }[]>;
      vpnStatus: () => Promise<VpnView>;
      vpnEnable: (ips: string[]) => Promise<{ ok: boolean; erro?: string }>;
      vpnDisable: () => Promise<{ ok: boolean; erro?: string }>;
      vpnPing: (ip: string) => Promise<{ avgMs?: number; lossPct?: number }>;
      vpnHealth: () => Promise<void>;
      autoLogin: () => Promise<{ ok: boolean; log: string }>;
      stopLogin: () => Promise<void>;
      uiLog: (m: string) => void;
      onLog: (cb: (msg: string) => void) => void;
      appVersion: () => Promise<string>;
      updateState: () => Promise<UpdateUiState>;
      updateInstall: (resume: { game: boolean; bot: boolean }) => Promise<boolean>;
      updateResume: () => Promise<{ game: boolean; bot: boolean } | null>;
      onUpdate: (cb: (s: UpdateUiState) => void) => void;
    };
  }
}

// Pill do treino (auto-hunt). Module scope: usado pelos botoes e pelo polling.
function setAf(on: boolean): void {
  const el = $("af-status");
  el.textContent = on ? "ligado" : "desligado";
  el.className = "pill " + (on ? "bg-ink-600 text-ok" : "bg-ink-600 text-muted");
}

// ---- Config do Demon Locking Tower ----

interface TowerUiConfig {
  refreshOnFailure: boolean;
  sweep: boolean;
  fightOnceBeforeSweeping: boolean;
  useBuff: boolean;
  refreshReward: boolean;
  refreshRewardRatio: number;
}

const TOWER_DEFAULT: TowerUiConfig = {
  refreshOnFailure: true,
  sweep: true,
  fightOnceBeforeSweeping: true,
  useBuff: true,
  refreshReward: true,
  refreshRewardRatio: 1.3,
};

function loadTowerConfig(): TowerUiConfig {
  try {
    const raw = localStorage.getItem("towerConfig");
    if (raw) return { ...TOWER_DEFAULT, ...JSON.parse(raw) };
  } catch {
    /* localStorage pode falhar; usa o default */
  }
  return { ...TOWER_DEFAULT };
}

function readTowerUi(): TowerUiConfig {
  const chk = (id: string) => ($(id) as HTMLInputElement).checked;
  const numv = (id: string, d: number) => {
    const v = parseFloat(($(id) as HTMLInputElement).value);
    return Number.isFinite(v) ? v : d;
  };
  return {
    refreshOnFailure: chk("dlt-refresh"),
    sweep: chk("dlt-sweep"),
    fightOnceBeforeSweeping: chk("dlt-fight"),
    useBuff: chk("dlt-buff"),
    refreshReward: chk("dlt-refreshreward"),
    refreshRewardRatio: Math.min(1.5, Math.max(1, numv("dlt-ratio", 1.3))), // multiple vai de 1.0 a 1.5
  };
}

function applyTowerUi(c: TowerUiConfig): void {
  ($("dlt-refresh") as HTMLInputElement).checked = c.refreshOnFailure;
  ($("dlt-sweep") as HTMLInputElement).checked = c.sweep;
  ($("dlt-fight") as HTMLInputElement).checked = c.fightOnceBeforeSweeping;
  ($("dlt-buff") as HTMLInputElement).checked = c.useBuff;
  ($("dlt-refreshreward") as HTMLInputElement).checked = c.refreshReward;
  ($("dlt-ratio") as HTMLInputElement).value = String(c.refreshRewardRatio);
}

function saveTowerConfig(): void {
  try {
    localStorage.setItem("towerConfig", JSON.stringify(readTowerUi()));
  } catch {
    /* ignora */
  }
}

function setTowerStatus(text: string, cls: string): void {
  const el = $("dlt-status");
  el.textContent = text;
  el.className = "pill " + cls;
}

// ---- Configuracao (pasta do LDPlayer, instancia, adb) ----

interface SettingsUi {
  emulator: "ldplayer" | "mumu";
  ldplayerDir: string;
  mumuDir: string;
  instance: number;
  adbPath: string;
}

interface SettingsView {
  settings: SettingsUi;
  serial: string;
  adb: string;
  warn?: string;
}

function showSettings(v: SettingsView): void {
  ($("st-emu") as HTMLSelectElement).value = v.settings.emulator;
  ($("st-lddir") as HTMLInputElement).value = v.settings.ldplayerDir;
  ($("st-mumudir") as HTMLInputElement).value = v.settings.mumuDir;
  ($("st-inst") as HTMLInputElement).value = String(v.settings.instance);
  ($("st-adb") as HTMLInputElement).value = v.settings.adbPath;
  $("st-serial").textContent = v.serial;
  $("st-adbinfo").textContent = "adb em uso: " + v.adb;
  $("inst-name").textContent = v.settings.emulator === "mumu" ? "MuMu Player" : "LDPlayer";
  $("inst-info").textContent = `${v.settings.emulator} · idx ${v.settings.instance} · ${v.serial}`;
}

function readSettingsUi(): SettingsUi {
  const n = parseInt(($("st-inst") as HTMLInputElement).value, 10);
  return {
    emulator: ($("st-emu") as HTMLSelectElement).value === "mumu" ? "mumu" : "ldplayer",
    ldplayerDir: ($("st-lddir") as HTMLInputElement).value.trim(),
    mumuDir: ($("st-mumudir") as HTMLInputElement).value.trim(),
    instance: Number.isFinite(n) && n >= 0 ? n : 0,
    adbPath: ($("st-adb") as HTMLInputElement).value.trim(),
  };
}

// ---- Rota do jogo (VPN gratuita) ----

interface VpnView {
  wireguard: boolean;
  account: boolean;
  service: "running" | "stopped" | "missing";
  ips: string[]; // no tunel
  seen: string[]; // que o jogo usa agora
  missing: string[]; // do jogo, fora do tunel
}

const appStartedAt = Date.now();
const connDrops: number[] = [];
const vpnWarned = new Set<string>();
let vpnBusy = false;
let lastVpn: VpnView | undefined;

function showDrops(): void {
  const h = (Date.now() - appStartedAt) / 3600000;
  const rate = h >= 0.25 ? ` (${(connDrops.length / h).toFixed(1)}/h)` : "";
  const last = connDrops.length ? `, a última às ${new Date(connDrops[connDrops.length - 1]).toLocaleTimeString()}` : "";
  $("vpn-drops").textContent = `${connDrops.length} desde que o app abriu${rate}${last}`;
}

function showVpn(v: VpnView): void {
  lastVpn = v;
  const on = v.service === "running";
  const pill = $("vpn-status");
  pill.textContent = !v.wireguard ? "WireGuard não instalado" : on ? "VPN" : v.service === "stopped" ? "VPN parada" : "direta";
  pill.className = "pill bg-ink-600 " + (on ? "text-ok" : v.wireguard ? "text-muted" : "text-warn");
  $("vpn-ips").textContent = v.ips.length ? v.ips.join(", ") : "-";
  ($("btn-vpn-on") as HTMLButtonElement).textContent = on ? "Atualizar IPs" : "Ligar VPN";
  const miss = $("vpn-missing");
  miss.classList.toggle("hidden", !(on && v.missing.length));
  miss.textContent = on && v.missing.length ? `o jogo está usando ${v.missing.join(", ")} fora do túnel: clique em Atualizar IPs` : "";
  showDrops();
}

async function refreshVpn(): Promise<void> {
  try {
    const v = await window.sro.vpnStatus();
    showVpn(v);
    // Servidor novo (outro servidor ou troca de IP) fora do tunel: avisa uma vez.
    for (const ip of v.service === "running" ? v.missing : []) {
      if (vpnWarned.has(ip)) continue;
      vpnWarned.add(ip);
      log(`[vpn] servidor de jogo ${ip} fora do túnel; em Ferramentas, clique em Atualizar IPs.`);
    }
  } catch (e) {
    log("[vpn] status falhou: " + String(e));
  }
}

async function vpnAction(fn: () => Promise<{ ok: boolean; erro?: string }>): Promise<void> {
  if (vpnBusy) return;
  vpnBusy = true;
  try {
    await fn();
    await refreshVpn();
  } finally {
    vpnBusy = false;
  }
}

async function measureVpnPing(): Promise<void> {
  // Servidor de jogo que o jogo usa agora (o center so atende no login).
  const ip = lastVpn?.seen.find((i) => i !== "13.250.144.245") ?? "54.169.246.199";
  $("vpn-ping").textContent = `medindo ${ip}...`;
  const r = await window.sro.vpnPing(ip);
  const text = r.avgMs === undefined ? `${ip}: sem resposta` : `${ip}: ${r.avgMs} ms, perda ${r.lossPct ?? "?"}%`;
  $("vpn-ping").textContent = text;
  log(`[vpn] ping ${text}`);
}

// ---- Aba de IA (opcional; so sugere, nao executa) ----

interface AiSettingsUi {
  mode: "manual" | "ai";
  provider: "ollama" | "gemini" | "openrouter" | "groq" | "mistral";
  model: string;
  ollamaUrl: string;
  actions: "off" | "confirm" | "auto";
}
interface AiMsg {
  role: "user" | "assistant";
  text: string;
}
// Acoes pedidas pela IA por mensagem (indice no historico) e o resultado.
const aiActionResults = new Map<string, string>();
let aiActionsMode: "off" | "confirm" | "auto" = "off";
interface AiAppInfo {
  train: { running: boolean; spots: string[]; hpGuardPct?: number; deathLimit?: number };
  activities: string[];
  recentLog: string[];
}

const aiHistory: AiMsg[] = [];
let aiBusy = false;

function aiAppInfo(): AiAppInfo {
  const t = readTrainUi();
  const acts = ["act-train", "act-cont", "act-firm", "act-tower", "act-guild", "act-actchest", "act-freebies", "act-qigong"].filter((id) => isChecked(id));
  return {
    train: {
      running: trainRunning,
      spots: (t.spots ?? []).map((s) => `cena ${s.scene} (${Math.round(s.x)}, ${Math.round(s.z)})`),
      hpGuardPct: t.switchLowHp || undefined,
      deathLimit: t.deathLimit,
    },
    activities: acts.map((id) => id.replace("act-", "")),
    recentLog: $("log").innerText.split("\n").slice(0, 25),
  };
}

function readAiUi(): AiSettingsUi {
  return {
    mode: ($("ai-mode-ai") as HTMLInputElement).checked ? "ai" : "manual",
    provider: ($("ai-provider") as HTMLSelectElement).value as AiSettingsUi["provider"],
    model: ($("ai-model") as HTMLInputElement).value.trim(),
    ollamaUrl: ($("ai-ollama") as HTMLInputElement).value.trim(),
    actions: (["off", "confirm", "auto"] as const).find((v) => v === ($("ai-actions") as HTMLSelectElement).value) ?? "off",
  };
}

function showAi(s: AiSettingsUi, hasKey: boolean): void {
  ($(s.mode === "ai" ? "ai-mode-ai" : "ai-mode-manual") as HTMLInputElement).checked = true;
  ($("ai-provider") as HTMLSelectElement).value = s.provider;
  ($("ai-model") as HTMLInputElement).value = s.model;
  ($("ai-ollama") as HTMLInputElement).value = s.ollamaUrl;
  ($("ai-actions") as HTMLSelectElement).value = s.actions;
  aiActionsMode = s.actions;
  ($("ai-key") as HTMLInputElement).placeholder = hasKey ? "chave guardada (criptografada)" : "cole a chave aqui";
  ($("btn-ai-send") as HTMLButtonElement).disabled = s.mode !== "ai";
  $("ai-status").textContent = s.mode === "ai" ? `conectado: ${s.provider} / ${s.model}` : "modo Manual: nenhuma chamada de rede";
}

async function refreshAiSnap(): Promise<void> {
  $("ai-snap").textContent = "lendo...";
  try {
    $("ai-snap").textContent = JSON.stringify(await window.sro.aiSnapshot(aiAppInfo()), null, 2);
  } catch (e) {
    $("ai-snap").textContent = "falhou: " + String(e);
  }
}

function renderAiChat(): void {
  const box = $("ai-chat");
  box.innerHTML = "";
  aiHistory.forEach((m, i) => {
    const div = document.createElement("div");
    div.className = m.role === "user" ? "text-gold" : "text-gray-200";
    div.textContent = (m.role === "user" ? "Você: " : "IA: ") + (m.role === "assistant" ? stripActions(m.text) : m.text);
    div.style.whiteSpace = "pre-wrap";
    box.appendChild(div);
    if (m.role !== "assistant" || aiActionsMode === "off") return;
    parseActions(m.text).forEach((a, j) => {
      const key = `${i}:${j}`;
      const row = document.createElement("div");
      row.className = "flex items-center gap-2 text-xs";
      const done = aiActionResults.get(key);
      if (done) {
        row.textContent = done;
        row.className += " text-muted";
      } else {
        const v = validateAction(a, aiCharLevel);
        const b = document.createElement("button");
        b.className = "btn";
        b.textContent = v.ok ? `Executar: ${v.desc}` : `Recusada: ${v.erro}`;
        b.disabled = !v.ok;
        b.addEventListener("click", () => void runAiAction(key, a));
        row.appendChild(b);
      }
      box.appendChild(row);
    });
  });
  // Esperando a resposta: linha piscando com os segundos (pedido do usuario).
  if (aiBusy) {
    const wait = document.createElement("div");
    wait.id = "ai-wait";
    wait.className = "text-muted animate-pulse";
    wait.textContent = `IA: pensando... ${Math.round((Date.now() - aiBusySince) / 1000)}s`;
    box.appendChild(wait);
  }
  box.scrollTop = box.scrollHeight;
}

let aiCharLevel = 0;
let aiBusySince = 0;

// Para so o loop do Treino (a caca do jogo segue ligada) e sobe de novo com a
// config nova; o Treino so sai andando fora de combate.
async function restartTrain(): Promise<void> {
  if (trainRunning) {
    await window.sro.stopTrain();
    for (let i = 0; i < 20 && trainRunning; i++) await new Promise((r) => setTimeout(r, 1000));
  }
  if (polling && isChecked("act-train") && !trainRunning) void runTrainActivity(true);
}

async function runAiAction(key: string, a: AiAction): Promise<void> {
  if (aiActionResults.has(key)) return;
  aiActionResults.set(key, "executando...");
  renderAiChat();
  const p = await window.sro.player();
  aiCharLevel = p.level ?? aiCharLevel;
  const v = validateAction(a, aiCharLevel);
  let result: string;
  if (!v.ok) {
    result = `recusada: ${v.erro}`;
  } else {
    switch (a.acao) {
      case "trocar_ponto": {
        const ar = v.area!;
        const spot = { scene: ar.scene, x: ar.x, y: ar.y, z: ar.z, range: 200 };
        const rest = trainSpots.filter((s) => s.scene !== spot.scene || Math.hypot(s.x - spot.x, s.z - spot.z) > 30);
        trainSpots = [spot, ...rest].slice(0, 3);
        saveTrainConfig();
        showTrainSpots();
        await restartTrain();
        break;
      }
      case "protecao_hp":
        ($("tr-sw-hp-on") as HTMLInputElement).checked = true;
        ($("tr-sw-hp") as HTMLInputElement).value = String(Math.round(Number(a.pct)));
        saveTrainConfig();
        await restartTrain();
        break;
      case "entrar_time":
        ($("tr-team-on") as HTMLInputElement).checked = a.ligar !== false;
        saveTrainConfig();
        await restartTrain();
        break;
      case "passada_baus":
        try {
          localStorage.setItem("chestNextAt", "0");
        } catch {
          /* sem storage */
        }
        void maybeRunChests();
        break;
      case "continental_agora":
        void runContinentalSafely().then((ok) => setContNext(ok ? CONT_EVERY_MS : CONT_RETRY_MS));
        break;
      case "pausar_na_cidade":
        await window.sro.pauseTrain("pausa pedida pela IA");
        break;
    }
    result = `executado: ${v.desc}`;
  }
  aiActionResults.set(key, result);
  log(`[ia] ${result}`);
  renderAiChat();
}

async function sendAi(): Promise<void> {
  const input = $("ai-input") as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text || aiBusy) return;
  aiBusy = true;
  aiBusySince = Date.now();
  input.value = "";
  aiHistory.push({ role: "user", text });
  const btn = $("btn-ai-send") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Aguardando...";
  renderAiChat();
  const tick = window.setInterval(() => {
    const w = document.getElementById("ai-wait");
    if (w) w.textContent = `IA: pensando... ${Math.round((Date.now() - aiBusySince) / 1000)}s`;
  }, 1000);
  try {
    const r = await window.sro.aiChat(aiHistory, aiAppInfo());
    aiHistory.push({ role: "assistant", text: r.ok ? r.text ?? "" : `(erro: ${r.erro ?? "sem resposta"})` });
    const p = await window.sro.player();
    aiCharLevel = p.level ?? aiCharLevel;
  } finally {
    window.clearInterval(tick);
    aiBusy = false;
    btn.disabled = false;
    btn.textContent = "Enviar";
    renderAiChat();
  }
  // Automatico: executa o que a IA pediu (com as mesmas travas).
  if (aiActionsMode === "auto") {
    const i = aiHistory.length - 1;
    const acts = aiHistory[i]?.role === "assistant" ? parseActions(aiHistory[i].text) : [];
    for (let j = 0; j < acts.length; j++) await runAiAction(`${i}:${j}`, acts[j]);
  }
}

async function wireAi(): Promise<void> {
  const v = await window.sro.aiGet();
  showAi(v.settings, v.hasKey);
  // Sugestoes do campo Modelo: a lista do provedor salvo (Ollama ou API).
  const loadModels = async () => {
    const models = await window.sro.aiModels();
    $("ai-models").innerHTML = models.map((m) => `<option value="${m.replace(/"/g, "")}"></option>`).join("");
  };
  void loadModels();
  const save = async (key?: string) => {
    const r = await window.sro.aiSet(readAiUi(), key);
    if (!r.ok || !r.settings) {
      $("ai-status").textContent = "nao salvou: " + (r.erro ?? "erro");
      return;
    }
    showAi(r.settings, !!r.hasKey);
    ($("ai-key") as HTMLInputElement).value = "";
    void loadModels();
    log(`[ia] config salva (${r.settings.mode === "ai" ? `${r.settings.provider} / ${r.settings.model}` : "Manual"}).`);
  };
  $("btn-ai-save").addEventListener("click", () => void save(($("ai-key") as HTMLInputElement).value.trim() || undefined));
  $("btn-ai-delkey").addEventListener("click", () => void save(""));
  $("btn-ai-snap").addEventListener("click", () => void refreshAiSnap());
  // Trocou o provedor: o modelo do outro nao serve (vazio = o padrao do novo); a
  // lista de sugestoes volta depois de Salvar (e a do provedor salvo).
  $("ai-provider").addEventListener("change", () => {
    ($("ai-model") as HTMLInputElement).value = "";
    $("ai-models").innerHTML = "";
  });
  void wireCred();
  $("btn-sell-now").addEventListener("click", async () => {
    log("venda do lixo: vendendo...");
    const freed = await window.sro.sellJunk().catch(() => 0);
    if (!freed) log("venda do lixo: nada da lista na mochila.");
  });
  $("btn-hist").addEventListener("click", () => void refreshHistory());
  $("hist-hours").addEventListener("change", () => void refreshHistory());
  void refreshHistory();
  $("btn-ai-send").addEventListener("click", () => void sendAi());
  $("ai-input").addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    if (k.key === "Enter" && !k.shiftKey) {
      k.preventDefault();
      void sendAi();
    }
  });
}

async function testSettingsUi(): Promise<void> {
  $("st-result").textContent = "testando...";
  const r = await window.sro.testSettings();
  $("st-result").textContent = r.map((c) => `${c.ok ? "[ok]   " : "[falha]"} ${c.name}: ${c.detail}`).join("\n");
  log(r.every((c) => c.ok) ? "conexao ok." : "conexao com problema: " + r.filter((c) => !c.ok).map((c) => c.name).join(", "));
}

// ---- Config do Firm ----

interface FirmUiConfig {
  stopAfter: number;
  maxQuality: number;
  allowItems: number[];
  askHelp: boolean;
  allowTeleport: boolean;
}

const FIRM_DEFAULT: FirmUiConfig = { stopAfter: 3, maxQuality: 2, allowItems: [], askHelp: true, allowTeleport: true };

function readFirmUi(): FirmUiConfig {
  const n = (id: string, d: number) => {
    const v = parseInt(($(id) as HTMLInputElement).value, 10);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  const items = ($("fm-allow") as HTMLInputElement).value.split(",").map((x) => parseInt(x.trim(), 10))
    .filter((x) => Number.isFinite(x) && x > 0);
  return {
    stopAfter: n("fm-stop", FIRM_DEFAULT.stopAfter),
    maxQuality: n("fm-quality", FIRM_DEFAULT.maxQuality),
    allowItems: items,
    askHelp: ($("fm-help") as HTMLInputElement).checked,
    allowTeleport: ($("fm-teleport") as HTMLInputElement).checked,
  };
}

function applyFirmUi(c: FirmUiConfig): void {
  ($("fm-stop") as HTMLInputElement).value = String(c.stopAfter);
  ($("fm-quality") as HTMLInputElement).value = String(c.maxQuality);
  ($("fm-allow") as HTMLInputElement).value = c.allowItems.join(", ");
  ($("fm-help") as HTMLInputElement).checked = c.askHelp;
  ($("fm-teleport") as HTMLInputElement).checked = c.allowTeleport;
}

function loadFirmConfig(): FirmUiConfig {
  try {
    const raw = localStorage.getItem("firmConfig");
    if (raw) return { ...FIRM_DEFAULT, ...JSON.parse(raw) };
  } catch {
    /* localStorage pode falhar; usa o default */
  }
  return { ...FIRM_DEFAULT };
}

function saveFirmConfig(): void {
  try {
    localStorage.setItem("firmConfig", JSON.stringify(readFirmUi()));
  } catch {
    /* ignora */
  }
}

function setFirmStatus(text: string, cls: string): void {
  const el = $("fm-status");
  el.textContent = text;
  el.className = "pill " + cls;
}

// Roda o Firm uma vez (ate a meta do dia ou acabar o que entregar).
async function runFirmActivityInner(): Promise<boolean> {
  log("atividade Firm ativa: rodando...");
  setFirmStatus("rodando", "bg-ink-600 text-warn");
  const r = await window.sro.runFirm(readFirmUi());
  if (r.ok) {
    setFirmStatus("concluido", "bg-ink-600 text-ok");
    log(`Firm concluido (${r.submitted ?? 0} entregue(s) nesta passada).`);
  } else if (r.erro === "parado") {
    setFirmStatus("parado", "bg-ink-600 text-muted");
  } else {
    setFirmStatus("falhou", "bg-ink-600 text-danger");
    log("firm falhou: " + (r.erro ?? "erro"));
  }
  return r.ok;
}

// ---- Config do Guild utilities ----

interface GuildUiConfig {
  signIn: "off" | "normal" | "luxury";
  chests: boolean;
  salary: boolean;
  redPacket: boolean;
  storeWeekly?: boolean; // gasta contribuicao: desligado numa instalacao nova
}

const GUILD_DEFAULT: GuildUiConfig = { signIn: "normal", chests: true, salary: true, redPacket: true, storeWeekly: false };

function readGuildUi(): GuildUiConfig {
  const v = ($("gu-signin") as HTMLSelectElement).value;
  return {
    signIn: v === "luxury" || v === "off" ? v : "normal",
    chests: ($("gu-chests") as HTMLInputElement).checked,
    salary: ($("gu-salary") as HTMLInputElement).checked,
    redPacket: ($("gu-red") as HTMLInputElement).checked,
    storeWeekly: ($("gu-store") as HTMLInputElement).checked,
  };
}

function applyGuildUi(c: GuildUiConfig): void {
  ($("gu-signin") as HTMLSelectElement).value = c.signIn;
  ($("gu-chests") as HTMLInputElement).checked = c.chests;
  ($("gu-salary") as HTMLInputElement).checked = c.salary;
  ($("gu-red") as HTMLInputElement).checked = c.redPacket;
  ($("gu-store") as HTMLInputElement).checked = !!c.storeWeekly;
}

function loadGuildConfig(): GuildUiConfig {
  try {
    const raw = localStorage.getItem("guildConfig");
    if (raw) return { ...GUILD_DEFAULT, ...JSON.parse(raw) };
  } catch {
    /* localStorage pode falhar; usa o default */
  }
  return { ...GUILD_DEFAULT };
}

function saveGuildConfig(): void {
  try {
    localStorage.setItem("guildConfig", JSON.stringify(readGuildUi()));
  } catch {
    /* ignora */
  }
}

function setGuildStatus(text: string, cls: string): void {
  const el = $("gu-status");
  el.textContent = text;
  el.className = "pill " + cls;
}

// Roda o Guild utilities uma vez (sign-in, baus, salario).
async function runGuildActivityInner(): Promise<boolean> {
  log("atividade Guild utilities ativa: rodando...");
  setGuildStatus("rodando", "bg-ink-600 text-warn");
  const r = await window.sro.runGuild(readGuildUi());
  if (r.ok) {
    setGuildStatus("concluido", "bg-ink-600 text-ok");
    log(`Guild utilities concluido (${r.done ?? 0} acao(oes)).`);
  } else if (r.erro === "parado") {
    setGuildStatus("parado", "bg-ink-600 text-muted");
  } else {
    setGuildStatus("falhou", "bg-ink-600 text-danger");
    log("guild utilities falhou: " + (r.erro ?? "erro"));
  }
  return r.ok;
}

// ---- Baus de atividade diaria ----

// Confere a cada 15 min com o bot rodando: os pontos vem do Firm, da Tower e do
// sign-in e zeram na virada (18:00), entao rodar so uma vez por dia perderia os
// baus. So metodo: roda com o Treino cacando, sem pausar.
const ACT_CHEST_EVERY_MS = 15 * 60 * 1000;
const ACT_CHEST_RETRY_MS = 5 * 60 * 1000;
let actChestNextAt = 0;
let actChestBusy = false;
let actChestLast = "";

function setActChestStatus(text: string, cls: string): void {
  const el = $("ac-status");
  el.textContent = text;
  el.className = "pill " + cls;
}

async function maybeRunActChests(): Promise<void> {
  if (!polling || !isChecked("act-actchest") || actChestBusy || watchdogBusy || loggingIn || outOfWorldSince !== 0) return;
  if (Date.now() < actChestNextAt) return;
  actChestBusy = true;
  actChestNextAt = Date.now() + ACT_CHEST_EVERY_MS;
  try {
    const r = await window.sro.runActChests();
    if (r.ok) {
      setActChestStatus("concluido", "bg-ink-600 text-ok");
      // So loga quando pegou algo ou o resumo mudou (a cada 15 min seria ruido).
      const line = `baus de atividade: ${r.reason ?? "nada a fazer"}.`;
      if ((r.done ?? 0) > 0 || line !== actChestLast) log(line);
      actChestLast = line;
    } else {
      setActChestStatus("falhou", "bg-ink-600 text-danger");
      log("baus de atividade: " + (r.erro ?? "erro"));
      actChestNextAt = Date.now() + ACT_CHEST_RETRY_MS;
    }
  } finally {
    actChestBusy = false;
  }
}

// ---- Gratis do dia ----

// Confere a cada 30 min com o bot rodando: o diario renova na virada (18:00), o
// semanal e o mensal na deles. Na janela do Lucky Money (09:00 as 11:15 em Brasilia)
// a cada 5 min, pros red envelopes da guilda. So metodo: roda com o Treino cacando.
const FREEBIES_EVERY_MS = 30 * 60 * 1000;
const FREEBIES_LUCKY_EVERY_MS = 5 * 60 * 1000;
let freebiesLastAt = 0;
const FREEBIES_RETRY_MS = 5 * 60 * 1000;
let freebiesNextAt = 0;
let freebiesBusy = false;
let freebiesLast = "";

function setFreebiesStatus(text: string, cls: string): void {
  const el = $("fb-status");
  el.textContent = text;
  el.className = "pill " + cls;
}

async function maybeRunFreebies(): Promise<void> {
  if (!polling || !isChecked("act-freebies") || freebiesBusy || watchdogBusy || loggingIn || outOfWorldSince !== 0) return;
  const now = Date.now();
  if (now < freebiesNextAt && !(luckyMoneyWindow(now) && now - freebiesLastAt >= FREEBIES_LUCKY_EVERY_MS)) return;
  freebiesBusy = true;
  freebiesLastAt = now;
  freebiesNextAt = now + FREEBIES_EVERY_MS;
  try {
    const r = await window.sro.runFreebies(isChecked("fb-donate"));
    if (r.ok) {
      setFreebiesStatus("concluido", "bg-ink-600 text-ok");
      // So loga quando pegou algo ou o resumo mudou.
      const line = `gratis do dia: ${r.reason ?? "nada a fazer"}.`;
      if ((r.done ?? 0) > 0 || line !== freebiesLast) log(line);
      freebiesLast = line;
    } else {
      setFreebiesStatus("falhou", "bg-ink-600 text-danger");
      log("gratis do dia: " + (r.erro ?? "erro"));
      freebiesNextAt = Date.now() + FREEBIES_RETRY_MS;
    }
  } finally {
    freebiesBusy = false;
  }
}

// ---- Qigong ----

interface QigongUiConfig {
  request: boolean;
  accept: boolean;
}

const QIGONG_DEFAULT: QigongUiConfig = { request: true, accept: true };

function readQigongUi(): QigongUiConfig {
  return { request: ($("qg-request") as HTMLInputElement).checked, accept: ($("qg-accept") as HTMLInputElement).checked };
}

function applyQigongUi(c: QigongUiConfig): void {
  ($("qg-request") as HTMLInputElement).checked = c.request;
  ($("qg-accept") as HTMLInputElement).checked = c.accept;
}

function loadQigongConfig(): QigongUiConfig {
  try {
    const raw = localStorage.getItem("qigongConfig");
    if (raw) return { ...QIGONG_DEFAULT, ...JSON.parse(raw) };
  } catch {
    /* localStorage pode falhar; usa o default */
  }
  return { ...QIGONG_DEFAULT };
}

function saveQigongConfig(): void {
  try {
    localStorage.setItem("qigongConfig", JSON.stringify(readQigongUi()));
  } catch {
    /* ignora */
  }
}

function setQigongStatus(text: string, cls: string): void {
  const el = $("qg-status");
  el.textContent = text;
  el.className = "pill " + cls;
}

let qigongBusy = false;
let qigongNextAt = 0;
// Nem pede nem aceita com Tower, Guild, Firm ou Continental rodando: aceito, o jogo
// leva o char pra area segura no meio da viagem do Firm (em 2026-11-09 18:01 os
// pedidos sairam junto com ela).
const qigongBlocked = () => dailyBusy || contBusy;

// Aceitar: o convite se recusa sozinho em 15 s, entao confere a cada 4 s. Na mesma
// batida, a rede de seguranca do Guild Hall (char parado la depois de um Qigong).
async function maybeAcceptQigong(): Promise<void> {
  if (!polling || !isChecked("act-qigong") || qigongBusy || qigongBlocked() || watchdogBusy || loggingIn || outOfWorldSince !== 0) return;
  qigongBusy = true;
  try {
    if (readQigongUi().accept) {
      const r = await window.sro.qigongAccept();
      if (r.accepted) setQigongStatus("concluido", "bg-ink-600 text-ok");
    }
    await window.sro.guildHallCheck();
  } finally {
    qigongBusy = false;
  }
}

// Pedir: de onde o char estiver (aceito, o jogo leva os dois pra area segura), a
// cada 10 min com o bot rodando. So um pedido por membro a cada 30 min (no main).
async function maybeRequestQigong(): Promise<void> {
  if (!polling || !isChecked("act-qigong") || !readQigongUi().request || qigongBusy || qigongBlocked() || watchdogBusy || loggingIn || outOfWorldSince !== 0) return;
  if (Date.now() < qigongNextAt) return;
  qigongBusy = true;
  qigongNextAt = Date.now() + QIGONG_REQUEST_EVERY_MS;
  try {
    const r = await window.sro.qigongRequest();
    if (r.done > 0) setQigongStatus("concluido", "bg-ink-600 text-ok");
    if (!r.ok) log(`Qigong: pedido nao feito (${r.erro ?? "erro"}).`);
  } finally {
    qigongBusy = false;
  }
}

// ---- Config do Treino ----

interface TrainSpotUi {
  scene: number;
  x: number;
  y: number;
  z: number;
  channel?: number;
  range?: number;
}

interface TrainUiConfig {
  deathLimit: number;
  setupPotions: boolean;
  spot?: TrainSpotUi; // config antiga (um ponto so); vira o primeiro da lista
  spots?: TrainSpotUi[];
  switchFewMonsters?: { radius: number; min: number };
  switchDeaths?: number;
  switchLowHp?: number;
  stopLevel?: { level: number; expPct: number };
  stopMinGold?: number;
  home?: TrainSpotUi;
  homeOn?: boolean;
  team?: { join: boolean; sameMapOnly: boolean };
  booster?: boolean;
  buffDamage?: boolean;
  buffVip?: boolean;
  berserk?: boolean;
  devil?: boolean;
  autoSkills?: boolean;
  sellJunk?: boolean;
  avoidPlayers?: boolean;
}

// Pontos e cidade nao tem campo proprio: ficam aqui e no localStorage.
let trainSpots: TrainSpotUi[] = [];
let trainHome: TrainSpotUi | undefined;

function intOf(id: string, d: number): number {
  const v = parseInt(($(id) as HTMLInputElement).value, 10);
  return Number.isFinite(v) ? v : d;
}

function checked(id: string): boolean {
  return ($(id) as HTMLInputElement).checked;
}

function readTrainUi(): TrainUiConfig {
  const deaths = intOf("tr-deaths", 0);
  const homeOn = checked("tr-home-on");
  return {
    deathLimit: deaths > 0 ? deaths : 0,
    setupPotions: checked("tr-potions"),
    spots: trainSpots,
    switchFewMonsters: checked("tr-sw-few")
      ? { radius: Math.max(10, intOf("tr-sw-radius", 100)), min: Math.max(1, intOf("tr-sw-min", 1)) }
      : undefined,
    switchDeaths: checked("tr-sw-deaths-on") ? Math.max(1, intOf("tr-sw-deaths", 3)) : 0,
    switchLowHp: checked("tr-sw-hp-on") ? Math.min(90, Math.max(10, intOf("tr-sw-hp", 50))) : 0,
    stopLevel: checked("tr-stop-level-on")
      ? { level: Math.max(1, intOf("tr-stop-level", 90)), expPct: Math.min(100, Math.max(0, intOf("tr-stop-exp", 0))) }
      : undefined,
    stopMinGold: checked("tr-stop-gold-on") ? Math.max(0, intOf("tr-stop-gold", 100000)) : 0,
    home: homeOn ? trainHome : undefined,
    homeOn,
    team: { join: checked("tr-team-on"), sameMapOnly: checked("tr-team-same") },
    booster: checked("tr-booster"),
    buffDamage: checked("tr-buff-dano"),
    buffVip: checked("tr-buff-vip"),
    berserk: checked("tr-berserk"),
    devil: checked("tr-devil"),
    autoSkills: checked("tr-skills"),
    sellJunk: checked("tr-sell"),
    avoidPlayers: checked("tr-players"),
  };
}

function spotLabel(s: TrainSpotUi): string {
  return `cena ${s.scene} (${Math.round(s.x)}, ${Math.round(s.z)})`;
}

function showTrainSpots(): void {
  const box = $("tr-spots");
  box.textContent = "";
  trainSpots.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "flex items-center gap-2 text-xs text-gray-300";
    const label = document.createElement("span");
    label.textContent = `${i + 1}. ${spotLabel(s)}`;
    label.className = "flex-1";
    const ch = document.createElement("input");
    ch.type = "number";
    ch.min = "0";
    ch.max = "9";
    ch.value = String(s.channel ?? 0);
    ch.title = "canal (0 = qualquer)";
    ch.className = "w-12 bg-ink-600 border border-line rounded px-1 py-0.5 text-gray-100";
    ch.addEventListener("change", () => {
      const v = parseInt(ch.value, 10);
      trainSpots[i] = { ...trainSpots[i], channel: Number.isFinite(v) && v > 0 ? v : undefined };
      saveTrainConfig();
    });
    const rg = document.createElement("input");
    rg.type = "number";
    rg.min = "10";
    rg.max = "300";
    rg.value = String(s.range ?? 150);
    rg.title = "raio em metros";
    rg.className = "w-16 bg-ink-600 border border-line rounded px-1 py-0.5 text-gray-100";
    rg.addEventListener("change", () => {
      const v = parseInt(rg.value, 10);
      trainSpots[i] = { ...trainSpots[i], range: Number.isFinite(v) && v >= 10 ? v : undefined };
      saveTrainConfig();
    });
    const del = document.createElement("button");
    del.className = "btn";
    del.textContent = "remover";
    del.addEventListener("click", () => {
      trainSpots.splice(i, 1);
      saveTrainConfig();
      showTrainSpots();
    });
    const chl = document.createElement("span");
    chl.textContent = "canal";
    const rgl = document.createElement("span");
    rgl.textContent = "raio";
    row.append(label, chl, ch, rgl, rg, del);
    box.append(row);
  });
  $("tr-spot").textContent = trainSpots.length ? `${trainSpots.length} ponto(s)` : "sem ponto (caça onde estiver)";
  $("tr-home").textContent = trainHome ? spotLabel(trainHome) : "sem cidade salva";
}

function applyTrainUi(c: TrainUiConfig): void {
  ($("tr-deaths") as HTMLInputElement).value = String(c.deathLimit);
  ($("tr-potions") as HTMLInputElement).checked = c.setupPotions;
  trainSpots = c.spots && c.spots.length ? [...c.spots] : c.spot ? [c.spot] : [];
  trainHome = c.home;
  const few = c.switchFewMonsters;
  ($("tr-sw-few") as HTMLInputElement).checked = !!few;
  if (few) {
    ($("tr-sw-radius") as HTMLInputElement).value = String(few.radius);
    ($("tr-sw-min") as HTMLInputElement).value = String(few.min);
  }
  ($("tr-sw-deaths-on") as HTMLInputElement).checked = !!c.switchDeaths;
  if (c.switchDeaths) ($("tr-sw-deaths") as HTMLInputElement).value = String(c.switchDeaths);
  ($("tr-sw-hp-on") as HTMLInputElement).checked = !!c.switchLowHp;
  if (c.switchLowHp) ($("tr-sw-hp") as HTMLInputElement).value = String(c.switchLowHp);
  ($("tr-stop-level-on") as HTMLInputElement).checked = !!c.stopLevel;
  if (c.stopLevel) {
    ($("tr-stop-level") as HTMLInputElement).value = String(c.stopLevel.level);
    ($("tr-stop-exp") as HTMLInputElement).value = String(c.stopLevel.expPct);
  }
  ($("tr-stop-gold-on") as HTMLInputElement).checked = !!c.stopMinGold;
  if (c.stopMinGold) ($("tr-stop-gold") as HTMLInputElement).value = String(c.stopMinGold);
  ($("tr-home-on") as HTMLInputElement).checked = !!c.homeOn;
  // Time vem ligado numa instalacao nova (sem config salva): o bonus de party e
  // de graca. Quem desligou continua desligado.
  ($("tr-team-on") as HTMLInputElement).checked = c.team?.join !== false;
  ($("tr-team-same") as HTMLInputElement).checked = !!c.team?.sameMapOnly;
  ($("tr-booster") as HTMLInputElement).checked = !!c.booster;
  ($("tr-buff-dano") as HTMLInputElement).checked = !!c.buffDamage;
  ($("tr-buff-vip") as HTMLInputElement).checked = !!c.buffVip;
  ($("tr-berserk") as HTMLInputElement).checked = c.berserk !== false;
  ($("tr-devil") as HTMLInputElement).checked = c.devil !== false;
  ($("tr-skills") as HTMLInputElement).checked = !!c.autoSkills;
  ($("tr-sell") as HTMLInputElement).checked = !!c.sellJunk;
  ($("tr-players") as HTMLInputElement).checked = c.avoidPlayers !== false;
  showTrainSpots();
}

function loadTrainConfig(): TrainUiConfig {
  try {
    const raw = localStorage.getItem("trainConfig");
    if (raw) {
      const c = { deathLimit: 0, setupPotions: true, ...JSON.parse(raw) } as TrainUiConfig;
      // O home so vem salvo quando ligado; guardamos a cidade a parte.
      const home = localStorage.getItem("trainHome");
      if (home) c.home = JSON.parse(home) as TrainSpotUi;
      return c;
    }
  } catch {
    /* localStorage pode falhar; usa o default */
  }
  return { deathLimit: 0, setupPotions: true };
}

function saveTrainConfig(): void {
  try {
    localStorage.setItem("trainConfig", JSON.stringify(readTrainUi()));
    if (trainHome) localStorage.setItem("trainHome", JSON.stringify(trainHome));
    else localStorage.removeItem("trainHome");
  } catch {
    /* ignora */
  }
}

// ---- Config do Continental Exploration ----

interface ContinentalUiConfig {
  mapId: number;
  ignoreGreen: boolean;
  ignoreBlue: boolean;
  restartWhenStuck: boolean;
  onlyOpenChests: boolean;
  stopWhenAllPurple: boolean;
  // Personagens a rodar em ordem (os dados sao por char). Vazio = so o atual.
  chars: string;
  atSpot?: boolean; // rolando no ponto de caca (ver runContinentalSafely)
}

const CONT_DEFAULT: ContinentalUiConfig = {
  mapId: 0, // automatico: o mapa mais alto que o nivel de cada char libera
  ignoreGreen: true,
  ignoreBlue: true,
  restartWhenStuck: true,
  onlyOpenChests: false,
  stopWhenAllPurple: false,
  chars: "",
};

function loadContConfig(): ContinentalUiConfig {
  try {
    const raw = localStorage.getItem("continentalConfig");
    if (raw) return { ...CONT_DEFAULT, ...JSON.parse(raw) };
  } catch {
    /* localStorage pode falhar; usa o default */
  }
  return { ...CONT_DEFAULT };
}

function readContUi(): ContinentalUiConfig {
  const chk = (id: string) => ($(id) as HTMLInputElement).checked;
  const map = parseInt(($("ce-map") as HTMLSelectElement).value, 10);
  return {
    mapId: Number.isFinite(map) ? map : CONT_DEFAULT.mapId,
    ignoreGreen: chk("ce-green"),
    ignoreBlue: chk("ce-blue"),
    restartWhenStuck: chk("ce-restart"),
    onlyOpenChests: chk("ce-onlyopen"),
    stopWhenAllPurple: chk("ce-stoppurple"),
    chars: ($("ce-chars") as HTMLInputElement).value.trim(),
  };
}

function applyContUi(c: ContinentalUiConfig): void {
  ($("ce-map") as HTMLSelectElement).value = String(c.mapId);
  ($("ce-green") as HTMLInputElement).checked = c.ignoreGreen;
  ($("ce-blue") as HTMLInputElement).checked = c.ignoreBlue;
  ($("ce-restart") as HTMLInputElement).checked = c.restartWhenStuck;
  ($("ce-onlyopen") as HTMLInputElement).checked = c.onlyOpenChests;
  ($("ce-stoppurple") as HTMLInputElement).checked = c.stopWhenAllPurple;
  ($("ce-chars") as HTMLInputElement).value = c.chars;
}

// "CharA, CharB" -> ["CharA", "CharB"] (sem vazios nem repetidos).
function parseChars(raw: string): string[] {
  const out: string[] = [];
  for (const n of raw.split(",").map((x) => x.trim())) if (n && !out.includes(n)) out.push(n);
  return out;
}

function saveContConfig(): void {
  try {
    localStorage.setItem("continentalConfig", JSON.stringify(readContUi()));
  } catch {
    /* ignora */
  }
}

function setContStatus(text: string, cls: string): void {
  const el = $("ce-status");
  el.textContent = text;
  el.className = "pill " + cls;
}

// ---- Atividades ativas: cada uma tem um checkbox "Ativa" persistido; Iniciar
// bot roda as marcadas, Parar bot para. ----

function wireActivityFlag(id: string, key: string): void {
  const el = $(id) as HTMLInputElement;
  try {
    el.checked = localStorage.getItem(key) === "1";
  } catch {
    /* ignora */
  }
  el.addEventListener("change", () => {
    try {
      localStorage.setItem(key, el.checked ? "1" : "0");
    } catch {
      /* ignora */
    }
    void onActivityToggle(id);
  });
}

function isChecked(id: string): boolean {
  return ($(id) as HTMLInputElement).checked;
}

// Espera o char entrar em mundo (ok:true) enquanto o bot estiver rodando.
// Com Auto-login marcado, o polling loga sozinho nesse meio tempo.
async function waitInWorld(timeoutMs = 180000): Promise<boolean> {
  let deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && polling) {
    // Auto-login rodando (ex.: baixando uma atualizacao do jogo) tem prazo
    // proprio; o daqui so comeca a contar quando ele termina.
    if (loggingIn) deadline = Date.now() + timeoutMs;
    try {
      const p = await window.sro.player();
      if (p.ok) return true;
    } catch {
      /* engine pode nao estar pronto ainda */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

// Roda o Demon Locking Tower (one-shot, ate concluir).
async function runTowerActivityInner(): Promise<boolean> {
  const c = readTowerUi();
  log("atividade Demon Locking Tower ativa: rodando...");
  setTowerStatus("rodando", "bg-ink-600 text-warn");
  const r = await window.sro.runTower({
    refreshOnFailure: c.refreshOnFailure,
    sweep: c.sweep,
    fightOnceBeforeSweeping: c.fightOnceBeforeSweeping,
    refreshRewardRatio: c.refreshReward ? c.refreshRewardRatio : 0, // 0 = nao rerola
    useBuff: c.useBuff,
  });
  if (r.ok) {
    setTowerStatus("concluido", "bg-ink-600 text-ok");
    log("Demon Locking Tower concluido.");
  } else if (r.erro === "parado") {
    setTowerStatus("parado", "bg-ink-600 text-muted");
    log("Demon Locking Tower parado.");
  } else {
    setTowerStatus("falhou", "bg-ink-600 text-danger");
    log("tower falhou: " + (r.erro ?? "erro"));
  }
  return r.ok;
}

// Roda o Continental em cada personagem da lista (os dados sao por char) e
// volta pro primeiro no fim. Lista vazia = so o char atual. A troca reinicia o
// jogo: watchdog e auto-login ficam travados enquanto isso.
async function runContinentalActivityInner(): Promise<boolean> {
  const chars = parseChars(readContUi().chars);
  if (!chars.length) return runContinentalOnce();
  // Trocar de char reinicia o jogo: nunca com o principal no ponto.
  if (contAtSpot) {
    log("Continental com troca de char pulado: o char esta no ponto de caca. Rode antes do Treino (Iniciar bot) ou com o char na cidade.");
    return false;
  }
  // Trocar de char fecha o jogo; o char que estava cacando fica no mundo sem
  // auto-play e morre (char principal, 2026-11-07 20:36). Com o Treino ou em combate, nao troca.
  const unsafe = await unsafeToSwitch();
  if (unsafe) {
    log(`Continental com troca de char pulado: ${unsafe}. Rode antes do Treino (Iniciar bot) ou com o char na cidade.`);
    return false;
  }
  for (const entry of chars) {
    if (!polling) return false;
    if (!(await switchCharIfNeeded(entry))) continue;
    log(`Continental Exploration no char ${entry}.`);
    await runContinentalOnce();
  }
  // Volta pro char principal (perfil de login), onde rodam Firm e Treino. Sem
  // perfil, volta pro primeiro da lista como antes.
  if (!polling) return false;
  const main = await window.sro.mainChar();
  if (main) {
    log(`Continental: voltando pro char principal ${main}.`);
    return switchCharIfNeeded(main);
  }
  return chars.length > 1 ? switchCharIfNeeded(chars[0]) : true;
}

// Motivo pra nao fechar o jogo agora (troca de char), ou "" se e seguro.
async function unsafeToSwitch(): Promise<string> {
  if (trainRunning) return "o Treino esta rodando";
  try {
    const p = await window.sro.player();
    if (p.ok && p.inCombat) return "o char esta em combate";
  } catch {
    /* engine fora: o jogo ja nao esta em mundo */
  }
  return "";
}

// Continental por tempo: os dados recarregam (1 por char a cada ~1h30, ate 10),
// entao "uma vez por dia" deixava os dados parados em 10/10. Roda a cada 12 h.
const CONT_EVERY_MS = 12 * 3600 * 1000;
const CONT_RETRY_MS = 3600 * 1000;
let contBusy = false;
let lastTrainReason = ""; // por que o ultimo treino concluiu

function contDue(now = Date.now()): boolean {
  try {
    return now >= Number(localStorage.getItem("contNextAt") ?? 0);
  } catch {
    return true;
  }
}

function setContNext(ms: number): void {
  try {
    localStorage.setItem("contNextAt", String(Date.now() + ms));
  } catch {
    /* sem storage: roda de novo no proximo ciclo */
  }
}

// Com o Treino rodando, o char vai pra cidade salva antes (parado no meio dos
// monstros ele morre: char principal, 2026-11-07 20:36), rola os dados e volta a cacar.
// Para so o loop do Treino (a caca do jogo segue ligada) e espera ele sair.
// False = nao parou a tempo.
const TRAIN_LOOP_STOP_MS = 60 * 1000;
async function stopTrainLoop(): Promise<boolean> {
  await window.sro.stopTrain();
  const t0 = Date.now();
  while (trainRunning && Date.now() - t0 < TRAIN_LOOP_STOP_MS) await new Promise((r) => setTimeout(r, 1000));
  return !trainRunning;
}

// Religa o Treino quando o loop antigo terminar de sair.
function resumeTrainLater(why: string): void {
  void (async () => {
    while (trainRunning) await new Promise((r) => setTimeout(r, 1000));
    if (!polling || !isChecked("act-train")) return;
    log(`voltando ao Treino depois ${why}.`);
    await runTrainActivity(true);
  })();
}

// Rola no proprio ponto, com a caca do jogo ligada (como a passada de baus).
// Antes o Treino levava o char pra cidade e voltava: a morte de 2026-11-08 09:49
// foi nessa ida. So o loop do Treino para (pra nao disputar comandos nem tratar a
// arena da caveira como "fora do ponto"); no ponto o jogo nunca e reiniciado e
// nao ha troca de char.
let contAtSpot = false;
async function runContinentalSafely(): Promise<boolean> {
  if (contBusy) return false;
  contBusy = true;
  let resume = false;
  try {
    if (trainRunning) {
      log("Continental: pausando o loop do Treino (caca segue ligada); rola no ponto, sem ir pra cidade.");
      resume = true;
      if (!(await stopTrainLoop())) {
        log("Continental pulado: o Treino nao parou a tempo.");
        return false;
      }
      contAtSpot = true;
    }
    return await runContinentalActivity();
  } finally {
    contAtSpot = false;
    contBusy = false;
    if (resume) resumeTrainLater("do Continental");
  }
}

// Agenda: com o Treino marcado, o Continental espera ele comecar e rola no ponto
// com a caca do jogo ligada (runContinentalSafely).
async function maybeRunContinental(): Promise<void> {
  if (!polling || !isChecked("act-cont") || !contDue() || contBusy || watchdogBusy || loggingIn) return;
  // Treino marcado e ainda comecando: espera ele subir. Treino ja concluido
  // (limite de mortes, meta) deixou o char na cidade: roda direto.
  if (isChecked("act-train") && !trainRunning && activitiesRunning) return;
  setContNext((await runContinentalSafely()) ? CONT_EVERY_MS : CONT_RETRY_MS);
}

// Passada so de baus entre as rodadas de dado: pega o pronto e comeca o proximo.
// Sem dado nao ha luta da caveira, entao roda por cima da caca (provado: ~6 s,
// HP minimo 98% no ponto 74-76).
function chestDue(now = Date.now()): boolean {
  try {
    return now >= Number(localStorage.getItem("chestNextAt") ?? 0);
  } catch {
    return true;
  }
}

async function scheduleChests(): Promise<void> {
  let left: number | null = null;
  try {
    left = await window.sro.chestLeft();
  } catch {
    /* sem leitura: usa o maximo */
  }
  const ms = chestDelayMs(left);
  try {
    localStorage.setItem("chestNextAt", String(Date.now() + ms));
  } catch {
    /* sem storage */
  }
  log(`Continental: proxima passada de baus em ${Math.round(ms / 60000)} min${left !== null ? ` (bau destravando: faltam ${Math.round(left / 60)} min)` : ""}.`);
}

async function maybeRunChests(): Promise<void> {
  if (!polling || !isChecked("act-cont") || contBusy || watchdogBusy || loggingIn || !chestDue()) return;
  if (contDue()) return; // a rodada de dado ja trata os baus
  contBusy = true;
  try {
    log("Continental: passada so de baus.");
    await window.sro.runContinental({ ...readContUi(), onlyOpenChests: true });
    await scheduleChests();
  } finally {
    contBusy = false;
  }
}

// entry = "Nome" ou "Nome@Servidor" (o main troca de servidor no login e sabe
// em qual servidor o bot entrou por ultimo).
async function switchCharIfNeeded(entry: string): Promise<boolean> {
  try {
    if (await window.sro.isChar(entry)) return true;
  } catch {
    /* engine fora: troca mesmo assim */
  }
  const unsafe = await unsafeToSwitch();
  if (unsafe) {
    log(`troca pro char ${entry} recusada: ${unsafe}.`);
    return false;
  }
  watchdogBusy = true;
  loggingIn = true;
  try {
    const r = await window.sro.switchChar(entry);
    if (!r.ok) {
      log(`troca pro char ${entry} falhou: ${r.erro ?? "erro"}`);
      return false;
    }
    return true;
  } finally {
    watchdogBusy = false;
    loggingIn = false;
  }
}

// Uma passada no char atual (ate acabar o dado). Travou e a config pede
// reiniciar: reabre o jogo e tenta de novo uma vez.
async function runContinentalOnce(): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    log("atividade Continental Exploration ativa: rodando...");
    setContStatus("rodando", "bg-ink-600 text-warn");
    const r = await window.sro.runContinental(contAtSpot ? { ...readContUi(), restartWhenStuck: false, atSpot: true } : readContUi());
    if (r.ok) {
      setContStatus("concluido", "bg-ink-600 text-ok");
      log("Continental Exploration concluido.");
      return true;
    }
    if (r.erro === "parado") {
      setContStatus("parado", "bg-ink-600 text-muted");
      log("Continental Exploration parado.");
      return false;
    }
    setContStatus("falhou", "bg-ink-600 text-danger");
    log("continental falhou: " + (r.erro ?? "erro"));
    if (!r.restart || attempt > 0 || !polling) return false;
    log("reiniciando o jogo (travado no Continental Exploration)...");
    const re = await window.sro.reopen();
    if (!re.ok) {
      log("falha ao reabrir: " + (re.erro ?? "erro"));
      return false;
    }
    if (!(await waitInWorld()) || !polling) return false;
  }
  return false;
}

// Treino: ligar roda o treino completo (prepara o auto-play, caca e vigia) ate
// parar ou bater o limite de mortes; desligar para o vigia e a caca.
let trainRunning = false;

// Ao parar o Treino: desliga a caca so se o char estiver fora de combate, com HP
// alto e sem monstro perto (senao fica ligada e o log avisa).
async function huntOffSafely(): Promise<void> {
  const r = await window.sro.autoFightOffSafe().catch(() => ({ kept: false }) as { kept: boolean; inCombat?: boolean; near?: number; hpPct?: number });
  if (r.kept) {
    const why = r.inCombat ? "em combate" : r.near ? `${r.near} monstro(s) por perto` : `HP em ${r.hpPct ?? "?"}%`;
    log(`caca mantida ligada: ${why}. Leve o char pra cidade antes de desligar.`);
  }
}

async function runTrainActivity(on: boolean): Promise<void> {
  if (!on) {
    await window.sro.stopTrain();
    await huntOffSafely();
    setAf(false);
    return;
  }
  if (trainRunning) return;
  trainRunning = true;
  // Conta o "congelado" a partir daqui: em 2026-11-07 16:15, religando o bot com
  // o char parado em Jangan desde 16:07, o vigia viu 8 min sem mudanca na hora,
  // reiniciou o jogo e a conta deslogou.
  liveChangedAt = Date.now();
  lastTrainReason = "";
  setAf(true);
  try {
    const r = await window.sro.runTrain(readTrainUi());
    lastTrainReason = r.reason ?? "";
    if (r.ok) log(`treino concluido (${r.deaths ?? 0} morte(s)).`);
    else if (r.erro !== "parado") log("treino falhou: " + (r.erro ?? "char em mundo?"));
    if (r.ok) await huntOffSafely();
  } finally {
    trainRunning = false;
    setAf(false);
  }
}

function activitiesDone(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem("activitiesDone") ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

function markDone(id: string): void {
  try {
    localStorage.setItem("activitiesDone", JSON.stringify({ ...activitiesDone(), [id]: gameDay() }));
  } catch {
    /* sem storage: roda de novo na proxima vez */
  }
}

const skipLogged = new Set<string>();

// Atividade de uma vez por dia: pula se ja concluiu hoje. Antes cada reconexao
// rodava tudo de novo, inclusive o Continental com troca de char no meio do Treino.
// Diaria que falhou tenta de novo no mesmo dia: em 2026-11-09 18:02 o Firm desistiu
// da viagem e so voltaria no dia seguinte.
const DAILY_RETRY_MS = 30 * 60 * 1000;
const DAILY_MAX_TRIES = 3;
let dailyRetryAt = 0; // 0 = nada falhou
let dailyTries = 0;
// Tower, Guild ou Firm rodando (o Qigong nao entra no meio).
let dailyBusy = false;

async function runOncePerDay(id: string, label: string, fn: () => Promise<boolean>): Promise<void> {
  if (!isChecked(id)) return;
  if (activitiesDone()[id] === gameDay()) {
    const key = `${id}:${gameDay()}`;
    if (!skipLogged.has(key)) log(`${label} ja concluido hoje (o dia do jogo vira as 18:00); marque de novo pra repetir.`);
    skipLogged.add(key);
    return;
  }
  dailyBusy = true;
  try {
    if (await fn()) markDone(id);
    else dailyRetryAt = Date.now() + DAILY_RETRY_MS;
  } finally {
    dailyBusy = false;
  }
}

// Virada do dia do jogo (18:00) com o bot ligado: as diarias so rodavam no
// Iniciar bot ou numa reconexao (em 2026-11-08 nada rodou na virada). Faz o
// mesmo do Iniciar bot: para o loop do Treino (a caca do jogo segue ligada),
// roda as pendentes e religa o Treino.
let dailyDay = gameDay();
async function maybeRunDailies(): Promise<void> {
  const day = gameDay();
  if (!polling || activitiesRunning || contBusy || watchdogBusy || loggingIn) return;
  let retry = false;
  if (day !== dailyDay) {
    dailyDay = day;
    dailyTries = 0;
  } else if (dailyRetryAt === 0 || Date.now() < dailyRetryAt || dailyTries >= DAILY_MAX_TRIES) return;
  else retry = true;
  dailyRetryAt = 0;
  const all: [string, string, () => Promise<boolean>][] = [
    ["act-tower", "Demon Locking Tower", runTowerActivity],
    ["act-guild", "Guild utilities", runGuildActivity],
    ["act-firm", "Firm", runFirmActivity],
  ];
  const ids = dueDailies(all.map(([id]) => id), isChecked, activitiesDone(), day);
  const due = all.filter(([id]) => ids.includes(id));
  if (!due.length) return;
  if (retry) dailyTries++;
  activitiesRunning = true;
  contBusy = true; // o Continental nao entra no meio
  const resume = trainRunning;
  try {
    if (resume) {
      log(`${retry ? `nova tentativa (${dailyTries}/${DAILY_MAX_TRIES})` : "dia do jogo virou"}: pausando o Treino (caca segue ligada) pra rodar ${due.map(([, l]) => l).join(", ")}.`);
      if (!(await stopTrainLoop())) {
        log("o Treino nao parou a tempo; diarias ficam pro proximo minuto.");
        dailyDay = day - 1;
        return;
      }
    }
    for (const [id, label, fn] of due) {
      if (!polling) break;
      await runOncePerDay(id, label, fn);
    }
    actChestNextAt = 0; // as diarias dao pontos: confere os baus no proximo minuto
  } finally {
    activitiesRunning = false;
    contBusy = false;
    // Religa mesmo se a espera estourou acima.
    if (resume) resumeTrainLater("das diarias");
  }
}

// Roda as atividades marcadas ao Iniciar bot. So comeca com o char EM MUNDO
// (regra). Tower e Continental primeiro (one-shot), depois Treino (toggle).
// O Treino sobe fora do activitiesRunning: com ele preso ao loop do Treino, a virada
// das 18:00 (maybeRunDailies) so rodava depois da primeira pausa do Continental.
async function runEnabledActivities(): Promise<void> {
  // Evita rodar em dobro (watchdog + Iniciar bot). Com o Treino ja rodando, as
  // diarias pendentes ficam pro maybeRunDailies, que pausa o loop antes.
  if (activitiesRunning || trainRunning) return;
  if (!isChecked("act-tower") && !isChecked("act-cont") && !isChecked("act-guild") && !isChecked("act-firm") && !isChecked("act-train")) return;
  activitiesRunning = true;
  try {
    log("aguardando o char entrar em mundo...");
    const inWorld = await waitInWorld();
    if (!inWorld || !polling) {
      log("char nao entrou em mundo; atividades nao iniciadas.");
      return;
    }
    log("char em mundo: iniciando atividades ativas.");
    await runOncePerDay("act-tower", "Demon Locking Tower", runTowerActivity);
    if (!polling) return; // o bot foi parado durante a tower
    // Com o Treino marcado o Continental fica pra agenda (rola no ponto).
    if (!isChecked("act-train")) await maybeRunContinental();
    if (!polling) return;
    await runOncePerDay("act-guild", "Guild utilities", runGuildActivity);
    if (!polling) return;
    await runOncePerDay("act-firm", "Firm", runFirmActivity);
    actChestNextAt = 0;
  } finally {
    activitiesRunning = false;
  }
  if (polling && isChecked("act-train")) await runTrainActivity(true);
}

async function stopActivities(): Promise<void> {
  await window.sro.stopLogin();
  await window.sro.stopTower();
  await window.sro.stopContinental();
  await window.sro.stopFirm();
  await window.sro.stopGuild();
  if (isChecked("act-train")) await runTrainActivity(false);
}

// Toggle de um checkbox "Ativa" com o bot rodando: marcar roda a atividade de
// novo (so com o char em mundo); desmarcar para (so o Treino tem o que parar).
async function onActivityToggle(id: string): Promise<void> {
  if (!polling) return; // so age com o bot iniciado
  const on = isChecked(id);
  if (id === "act-train") {
    if (!on) {
      await runTrainActivity(false);
      return;
    }
    if (await waitInWorld()) {
      if (polling) await runTrainActivity(true);
    }
  } else if (id === "act-tower" && on) {
    if (await waitInWorld()) {
      if (polling && (await runTowerActivity())) markDone("act-tower");
    }
  } else if (id === "act-cont" && on) {
    if (await waitInWorld()) {
      if (polling) setContNext((await runContinentalSafely()) ? CONT_EVERY_MS : CONT_RETRY_MS);
    }
  } else if (id === "act-firm" && on) {
    if (await waitInWorld()) {
      if (polling && (await runFirmActivity())) markDone("act-firm");
    }
  } else if (id === "act-actchest" && on) {
    actChestNextAt = 0;
    void maybeRunActChests();
  } else if (id === "act-freebies" && on) {
    freebiesNextAt = 0;
    void maybeRunFreebies();
  } else if (id === "act-guild" && on) {
    if (await waitInWorld()) {
      if (polling && (await runGuildActivity())) markDone("act-guild");
    }
  }
}

// Watchdog: com o bot rodando e o jogo marcado como aberto, se o processo do
// jogo cair, reabre (injeta + sobe + loga via auto-login) e retoma as atividades.
// Uma checagem por vez: com o adb lento a pergunta passa dos 5 s do ciclo e
// duas checagens reabriam o jogo juntas (visto 2026-11-07 21:47: duas injecoes).
let watchdogChecking = false;

async function watchdog(): Promise<void> {
  if (watchdogChecking) return;
  watchdogChecking = true;
  try {
    await watchdogOnce();
  } finally {
    watchdogChecking = false;
  }
}

async function watchdogOnce(): Promise<void> {
  if (!polling || !gameOpen || watchdogBusy) return;
  let fg: boolean;
  let lost = false;
  let stalled = false;
  try {
    fg = await window.sro.gameForeground();
    // Conexao caida: o jogo segue aberto e em primeiro plano, mas parado.
    const conn = fg ? await window.sro.connectionLost() : "";
    if (conn === "kicked") {
      // Outro aparelho entrou na conta: relogar derrubaria quem esta la.
      log("a conta entrou em outro aparelho (\"logged in on another device\"): bot parado, sem relogar. Clique em Iniciar bot pra voltar.");
      stopPolling();
      setBotBtn();
      void stopActivities();
      return;
    }
    lost = conn === "lost";
    if (fg && !lost && trainRunning && Date.now() - liveChangedAt >= STALL_RESTART_MS) {
      log(`EXP, HP e posicao parados ha ${Math.round((Date.now() - liveChangedAt) / 60000)} min com o treino ligado: jogo travado ou sem conexao.`);
      stalled = true;
    }
  } catch (e) {
    log("[wd] checagem de foreground falhou: " + String(e));
    return; // nao deu pra checar; tenta no proximo ciclo
  }
  if (fg && !lost && !stalled) return; // jogo em primeiro plano e conectado, nada a fazer
  watchdogBusy = true;
  if (lost || stalled) {
    connDrops.push(Date.now());
    showDrops();
  }
  await reopenGame(lost ? "conexao com o servidor caiu (Connection failed); reiniciando o jogo..."
    : stalled ? "jogo congelado; reiniciando o jogo..."
    : "jogo saiu de primeiro plano; reabrindo...", lost || stalled);
}

// Reinicia (ou traz pra frente) o jogo e retoma as atividades.
async function reopenGame(msg: string, restart = true): Promise<void> {
  watchdogBusy = true;
  log(msg);
  setConn("wait", "reabrindo jogo...");
  try {
    const r = await window.sro.reopen(restart);
    liveChangedAt = Date.now(); // conta de novo a partir da reabertura
    if (r.ok) {
      setConn("on", "jogo reaberto :27105");
      log(`jogo reaberto (${r.mode ?? ""}); retomando atividades (aguarda in-world).`);
      void runEnabledActivities();
    } else {
      setConn("off", "reabrir falhou");
      log("falha ao reabrir: " + (r.erro ?? "erro"));
    }
  } finally {
    watchdogBusy = false;
  }
}

const $ = (id: string) => document.getElementById(id)!;

function log(msg: string): void {
  const el = $("log");
  const t = new Date().toLocaleTimeString();
  el.textContent = `[${t}] ${msg}\n` + el.textContent;
  // Espelha no stdout do main pra dar pra observar o watchdog de fora.
  try { window.sro.uiLog?.(msg); } catch { /* ignora */ }
  // Eventos que interessam ao historico (morte, queda, ponto, time, baus).
  const ev = eventFromLog(msg);
  if (ev) void window.sro.histEvent?.({ ts: Date.now(), ...ev }).catch(() => undefined);
}

// ---- EXP por atividade (o guia oficial nao diz quanto cada uma da) ----

async function expPoint(): Promise<ExpPoint | undefined> {
  const p = await window.sro.player().catch(() => undefined);
  if (!p?.ok || typeof p.level !== "number" || typeof p.exp !== "number") return undefined;
  return { level: p.level, exp: unsignedExp(p.exp), maxExp: unsignedExp(typeof p.maxExp === "number" ? p.maxExp : 0) };
}

async function measureExp(label: string, fn: () => Promise<boolean>): Promise<boolean> {
  const before = await expPoint();
  const t0 = Date.now();
  const training = trainRunning;
  const ok = await fn();
  const after = await expPoint();
  if (before && after) log(activityExpLine(label, before, after, (Date.now() - t0) / 60000, training || trainRunning));
  return ok;
}

const runFirmActivity = (): Promise<boolean> => measureExp("Firm", runFirmActivityInner);
const runGuildActivity = (): Promise<boolean> => measureExp("Guild utilities", runGuildActivityInner);
const runTowerActivity = (): Promise<boolean> => measureExp("Demon Locking Tower", runTowerActivityInner);
const runContinentalActivity = (): Promise<boolean> => measureExp("Continental Exploration", runContinentalActivityInner);

// ---- Mochila (aviso de cheia) ----

let bagWatch: BagWatch = {};

async function checkBag(): Promise<void> {
  const b = await window.sro.bag();
  const level = bagLevel(b.empty);
  if (level && b.empty !== undefined)
    $("p-bag").textContent = b.used !== undefined ? `${b.empty} de ${b.empty + b.used}` : String(b.empty);
  const r = bagStep(bagWatch, level);
  bagWatch = r.watch;
  if (!r.changed || !bagWatch.shown || b.empty === undefined) return;
  const text = bagText(bagWatch.shown, b.empty);
  const pill = $("bag-alert");
  pill.classList.toggle("hidden", bagWatch.shown === "ok");
  pill.textContent = bagWatch.shown === "full" ? `mochila cheia (${b.empty})` : `mochila ${b.empty} livres`;
  pill.title = text;
  if (bagWatch.shown !== "ok" || r.notify) log(text);
  if (r.notify) {
    try {
      new Notification("SRO Bot: mochila", { body: text });
    } catch {
      /* sem notificacao do sistema: fica o selo e o log */
    }
  }
}

// ---- Alarme de EXP/h (training time x10 acabando sem ninguem ver) ----

let ratePoints: RatePoint[] = [];
let rateWatch: ExpWatch = { low: false };

async function checkExpRate(): Promise<void> {
  const p = await window.sro.player().catch(() => undefined);
  if (!p?.ok || typeof p.level !== "number" || typeof p.exp !== "number") return;
  const now = Date.now();
  ratePoints.push({ ts: now, level: p.level, exp: p.exp, maxExp: typeof p.maxExp === "number" ? p.maxExp : 0, training: trainRunning && !p.dead });
  ratePoints = ratePoints.filter((x) => x.ts >= now - EXP_KEEP_MS);
  const r = expWatchStep(rateWatch, ratePoints, now);
  rateWatch = r.watch;
  const pill = $("exp-alert");
  if (r.notify) {
    const text = expDropText(r.notify.recent, r.notify.ref);
    pill.title = text;
    pill.classList.remove("hidden");
    log(text);
    try {
      new Notification("SRO Bot: EXP/h", { body: text });
    } catch {
      /* sem notificacao do sistema: fica o selo e o log */
    }
  }
  if (r.cleared) {
    pill.classList.add("hidden");
    log("EXP/h voltou ao normal.");
  }
}

// ---- Conta do jogo (ID e senha pro login do SDK) ----

function showCred(has: boolean, msg?: string): void {
  $("cred-status").textContent = msg ?? (has ? "ID e senha salvos (criptografados)." : "nenhum salvo.");
}

async function wireCred(): Promise<void> {
  const id = $("cred-id") as HTMLInputElement;
  const pwd = $("cred-pwd") as HTMLInputElement;
  $("btn-cred-save").addEventListener("click", async () => {
    if (!id.value.trim() || !pwd.value) return showCred(false, "preencha o ID e a senha.");
    const r = await window.sro.credSet(id.value, pwd.value);
    pwd.value = "";
    id.value = "";
    showCred(r.has, r.ok ? undefined : "nao salvou: " + (r.erro ?? "erro"));
  });
  $("btn-cred-clear").addEventListener("click", async () => {
    const r = await window.sro.credSet("", "");
    showCred(r.has, r.ok ? "apagado." : "nao apagou: " + (r.erro ?? "erro"));
  });
  showCred((await window.sro.credGet()).has);
}

// ---- Historico (Farm & Hunting) ----

const fmtNum = (n: number) => n.toLocaleString("pt-BR");

async function refreshHistory(): Promise<void> {
  const hours = parseInt(($("hist-hours") as HTMLSelectElement).value, 10) || 24;
  const h = await window.sro.histSummary(hours);
  const tbody = $("hist-areas");
  tbody.innerHTML = "";
  if (!h.areas.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-xs text-muted">sem dados ainda (${h.samples} amostra(s); grava 1 por minuto com o bot rodando)</td></tr>`;
  }
  for (const a of h.areas) {
    const tr = document.createElement("tr");
    for (const v of [a.area, `${Math.floor(a.minutes / 60)}h${String(a.minutes % 60).padStart(2, "0")}`, fmtNum(a.expPerHour),
      a.minHpPct !== undefined ? `${a.minHpPct}%` : "-", String(a.deaths)]) {
      const td = document.createElement("td");
      td.textContent = v;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  $("hist-events").textContent = h.events.length
    ? h.events.map((e) => `${new Date(e.ts).toLocaleTimeString()} [${e.kind}] ${e.text}`).join("\n")
    : "-";
}

function setConn(state: "on" | "off" | "wait", text: string): void {
  const dot = $("conn-dot");
  const txt = $("conn-text");
  dot.className =
    "w-2 h-2 rounded-full " +
    (state === "on" ? "bg-ok" : state === "wait" ? "bg-warn" : "bg-muted");
  txt.textContent = text;
}

function setInstStatus(text: string, cls: string): void {
  const el = $("inst-status");
  el.textContent = text;
  el.className = "pill " + cls;
}

// Limpa os vitais na tela (char fora de mundo): evita mostrar valor estagnado.
function clearVitals(): void {
  $("p-name").textContent = "-";
  $("p-initial").textContent = "?";
  $("p-level").textContent = "-";
  for (const id of ["p-x", "p-y", "p-z"]) $(id).textContent = "-";
  for (const [bar, txt] of [
    ["p-hp", "p-hp-txt"],
    ["p-mp", "p-mp-txt"],
  ]) {
    ($(bar) as HTMLElement).style.width = "0%";
    $(txt).textContent = "-";
  }
  ($("p-exp") as HTMLElement).style.width = "0%";
  // O loop do Treino segue rodando com o char fora de mundo por um instante (viagem,
  // troca de cena): a etiqueta apagava aqui e nao acendia mais.
  setAf(trainRunning);
}

function renderPlayer(p: PlayerState): void {
  $("p-raw").textContent = JSON.stringify(p, null, 2);
  if (!p.ok) {
    $("p-sub").textContent = p.erro ?? "sem leitura";
    setInstStatus("aguardando", "bg-ink-600 text-warn");
    clearVitals();
    return;
  }
  // O pill do Treino reflete o clique do botao (intencao do bot). Nao uso o
  // autoPlayOn do engine aqui: a leitura dele oscila e faria o pill piscar.
  if (p.dead) setInstStatus("morto", "bg-ink-600 text-danger");
  else if (p.inCombat) setInstStatus("em combate", "bg-ink-600 text-warn");
  else setInstStatus("online", "bg-ink-600 text-ok");
  const name = p.name && p.name.length ? p.name : "-";
  $("p-name").textContent = name;
  $("p-initial").textContent = name !== "-" ? name[0].toUpperCase() : "?";
  $("p-sub").textContent = `ptr ${p.player ?? "-"}`;
  const c = p.corrected ?? [0, 0, 0];
  $("p-x").textContent = c[0].toFixed(1);
  $("p-y").textContent = c[1].toFixed(1);
  $("p-z").textContent = c[2].toFixed(1);
  $("p-level").textContent = p.level != null ? String(p.level) : "-";
  const exp = p.exp ?? 0;
  const maxExp = p.maxExp ?? 0;
  const pct = maxExp > 0 ? Math.min(100, (exp / maxExp) * 100) : 0;
  ($("p-exp") as HTMLElement).style.width = `${pct.toFixed(1)}%`;

  const bar = (cur: number, max: number, barId: string, txtId: string) => {
    const w = max > 0 ? Math.min(100, (cur / max) * 100) : 0;
    ($(barId) as HTMLElement).style.width = `${w.toFixed(1)}%`;
    $(txtId).textContent = max > 0 ? `${cur}/${max}` : "-";
  };
  bar(p.hp ?? 0, p.maxHp ?? 0, "p-hp", "p-hp-txt");
  bar(p.mp ?? 0, p.maxMp ?? 0, "p-mp", "p-mp-txt");
  updateStats(p);
}

// ---- Estatisticas de sessao (derivadas do polling) ----

interface Stats {
  start: number;
  samples: number;
  startLevel: number;
  lastLevel: number;
  lastExp: number;
  lastMaxExp: number;
  totalExp: number;
  distance: number;
  lastPos?: [number, number, number];
  deaths: number;
  lastDead: boolean;
  combatMs: number;
  lastTime: number;
  cur?: PlayerState;
}
let stats: Stats | null = null;

function resetStats(): void {
  stats = {
    start: Date.now(),
    samples: 0,
    startLevel: 0,
    lastLevel: 0,
    lastExp: 0,
    lastMaxExp: 0,
    totalExp: 0,
    distance: 0,
    deaths: 0,
    lastDead: false,
    combatMs: 0,
    lastTime: 0,
  };
  renderStats();
}

function updateStats(p: PlayerState): void {
  if (!stats) resetStats();
  const s = stats!;
  s.samples++;
  s.cur = p;
  const exp = p.exp ?? 0;
  const maxExp = p.maxExp ?? 0;
  const level = p.level ?? 0;
  if (s.samples === 1) {
    s.startLevel = level;
    s.lastLevel = level;
    s.lastExp = exp;
    s.lastMaxExp = maxExp;
  } else {
    if (level === s.lastLevel) {
      if (exp >= s.lastExp) s.totalExp += exp - s.lastExp;
    } else if (level > s.lastLevel) {
      // ganhou nivel: exp ate o fim do nivel anterior + exp do novo
      s.totalExp += Math.max(0, s.lastMaxExp - s.lastExp) + exp;
    }
    s.lastLevel = level;
    s.lastExp = exp;
    s.lastMaxExp = maxExp;
  }
  const pos = p.corrected;
  if (pos && s.lastPos) {
    const d = Math.hypot(pos[0] - s.lastPos[0], pos[2] - s.lastPos[2]);
    if (d < 500) s.distance += d; // ignora teleporte/troca de mapa
  }
  if (pos) s.lastPos = pos;

  // mortes (transicao vivo -> morto) e tempo em combate
  const now = Date.now();
  if (p.dead && !s.lastDead) s.deaths++;
  s.lastDead = !!p.dead;
  if (s.lastTime && p.inCombat) {
    const dt = now - s.lastTime;
    if (dt < 10000) s.combatMs += dt; // ignora gaps grandes
  }
  s.lastTime = now;

  renderStats();
}

function fmtDur(ms: number): string {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function renderStats(): void {
  if (!stats) {
    return;
  }
  const s = stats;
  const upMs = Date.now() - s.start;
  const upH = upMs / 3600000;
  const rate = upH > 0 ? s.totalExp / upH : 0;
  const exp = s.cur?.exp ?? 0;
  const maxExp = s.cur?.maxExp ?? 0;
  const pct = maxExp > 0 ? (exp / maxExp) * 100 : 0;
  const expPerSec = upMs > 0 ? s.totalExp / (upMs / 1000) : 0;
  const remain = Math.max(0, maxExp - exp);
  $("s-uptime").textContent = fmtDur(upMs);
  $("s-exprate").textContent = Math.round(rate).toLocaleString() + "/h";
  $("s-eta").textContent = expPerSec > 0 ? fmtDur((remain / expPerSec) * 1000) : "-";
  $("s-levels").textContent = String((s.cur?.level ?? s.startLevel) - s.startLevel);
  $("s-exp").textContent = `${pct.toFixed(2)}%`;
  $("s-expgain").textContent = Math.round(s.totalExp).toLocaleString();
  $("s-dist").textContent = Math.round(s.distance).toLocaleString();
  $("s-samples").textContent = String(s.samples);
  $("s-deaths").textContent = String(s.deaths);
  $("s-combat").textContent = s.combatMs > 0 ? fmtDur(s.combatMs) : "0s";
  $("s-hp").textContent = s.cur?.maxHp ? `${s.cur.hp}/${s.cur.maxHp}` : "-";
  $("s-mp").textContent = s.cur?.maxMp ? `${s.cur.mp}/${s.cur.maxMp}` : "-";
}

let polling = false;
let timer: number | undefined;
let loggingIn = false;
let gameOpen = false;
let watchdogBusy = false;
let lastWatchdog = 0;
let activitiesRunning = false;
let outOfWorldSince = 0; // 0 = em mundo
// O loading entre andares da torre tira o char de mundo por 5 a 7 s; logout de
// verdade nao volta sozinho.
const LOGIN_AFTER_OUT_MS = 15000;

// Rotulos dos botoes conforme o estado (toggle).
function setGameBtn(): void {
  ($("btn-game") as HTMLButtonElement).textContent = gameOpen ? "Fechar jogo" : "Abrir jogo";
}
function setBotBtn(): void {
  ($("btn-bot") as HTMLButtonElement).textContent = polling ? "Parar bot" : "Iniciar bot";
}

// Auto-login automatico: se o checkbox estiver marcado e o char estiver fora de
// mundo, dispara o login. O guard evita reentrar a cada leitura (polling de 1s).
// Falhas seguidas do auto-login. O cliente congelado no voo do teleporte entre
// mapas (visto 2026-11-07 07:18, 09:36 e 09:45: tela parada no ceu, "nada
// visivel") nunca volta sozinho; depois de LOGIN_FAILS_RESTART falhas o vigia
// reinicia o jogo. A espera do login da conta nao conta: o prazo dela anda junto.
const LOGIN_FAILS_RESTART = 2;
let loginFails = 0;

async function maybeAutoLogin(): Promise<void> {
  const chk = document.getElementById("chk-login") as HTMLInputElement | null;
  if (!chk?.checked || loggingIn) return;
  loggingIn = true;
  log("auto-login: char fora de mundo, logando...");
  let ok = false;
  try {
    const r = await window.sro.autoLogin();
    ok = r.ok;
    log(r.ok ? "auto-login: em mundo." : "auto-login nao concluiu.");
  } catch (e) {
    log("auto-login falhou: " + String(e));
  } finally {
    loggingIn = false;
  }
  loginFails = ok ? 0 : loginFails + 1;
  if (loginFails >= LOGIN_FAILS_RESTART && polling && gameOpen && !watchdogBusy) {
    loginFails = 0;
    await reopenGame(`auto-login falhou ${LOGIN_FAILS_RESTART} vezes seguidas (cliente travado?); reiniciando o jogo...`);
  }
}

// Jogo travado ou desconectado sem aviso ("Connecting..." infinito, visto ao
// vivo no char principal): com o Treino rodando, EXP, HP e posicao parados por tanto tempo
// reiniciam o jogo. So EXP parado nao basta: em 2026-11-07 06:13 o char principal ficou
// preso no ponto apanhando (HP mudando, servidor vivo), o reinicio deixou o char
// sozinho no meio dos monstros e ele morreu. Preso e com o jogo vivo e o Treino
// que resolve (desliga e religa a caca, depois troca de ponto).
const STALL_RESTART_MS = 8 * 60 * 1000;
let liveSeen = "";
let liveChangedAt = Date.now();

// EXP, HP e posicao (metro a metro): muda quando o servidor manda algo.
function liveKey(p: PlayerState): string {
  const c = p.corrected ?? [0, 0, 0];
  return `${p.exp}|${p.hp}|${Math.round(c[0])}|${Math.round(c[2])}`;
}

async function readOnce(): Promise<void> {
  try {
    const p = await window.sro.player();
    renderPlayer(p);
    if (p.ok && liveKey(p) !== liveSeen) {
      liveSeen = liveKey(p);
      liveChangedAt = Date.now();
    }
    if (p.ok) outOfWorldSince = 0;
    else if (!outOfWorldSince) outOfWorldSince = Date.now();
    else if (Date.now() - outOfWorldSince >= LOGIN_AFTER_OUT_MS) void maybeAutoLogin();
  } catch (e) {
    log("erro ao ler: " + String(e));
  }
}

function startPolling(): void {
  liveChangedAt = Date.now();
  polling = true;
  if (!stats) resetStats();
  const loop = async () => {
    if (!polling) return;
    await readOnce();
    if (Date.now() - lastWatchdog >= 5000) {
      lastWatchdog = Date.now();
      void watchdog(); // nao bloqueia o loop; reabre o jogo se tiver caido
    }
    timer = window.setTimeout(loop, 1000);
  };
  loop();
  log("leitura iniciada (1s)");
}

function stopPolling(): void {
  polling = false;
  if (timer) window.clearTimeout(timer);
  log("leitura parada");
}

function wire(): void {
  // Botao do JOGO: abre (emulador + injeta engine + sobe o jogo) ou, se ja
  // estiver aberto, fecha (devolve as libs ao que estavam antes, md5 conferido).
  $("btn-game").addEventListener("click", async () => {
    const btn = $("btn-game") as HTMLButtonElement;
    btn.disabled = true;
    if (!gameOpen) {
      setConn("wait", "abrindo jogo...");
      log("abrindo emulador, injetando engine e subindo o jogo...");
      const r = await window.sro.inject();
      if (r.ok) {
        gameOpen = true;
        setConn("on", "jogo aberto :27105");
        log("jogo aberto. logue (ou marque Auto-login) e clique em Iniciar bot.");
      } else {
        setConn("off", "falhou");
        log("abrir jogo falhou: " + (r.erro ?? "erro"));
      }
    } else {
      if (polling) { stopPolling(); setBotBtn(); }
      setConn("wait", "fechando jogo...");
      log("fechando o jogo e restaurando (md5)...");
      const r = await window.sro.restore();
      if (r.ok) {
        gameOpen = false;
        setConn("off", "jogo fechado");
        log("jogo fechado e restaurado ao estado original.");
      } else if (/offline|not found|no devices/i.test(r.erro ?? "")) {
        // Emulador fechado por fora: sem isso o botao ficava preso em "Fechar jogo".
        gameOpen = false;
        setConn("off", "emulador fechado");
        log("o emulador esta fechado, nada a restaurar agora. o jogo segue injetado ate a proxima vez que voce abrir e fechar o jogo pelo app.");
      } else {
        log("fechar/restaurar falhou: " + (r.erro ?? "erro"));
      }
    }
    setGameBtn();
    btn.disabled = false;
  });

  // Botao do BOT: inicia o monitoramento e roda as atividades marcadas (Ativa);
  // parar encerra tudo.
  $("btn-bot").addEventListener("click", () => {
    if (!polling) {
      if (!gameOpen) {
        log("abra o jogo primeiro (Abrir jogo).");
        return;
      }
      startPolling();
      setBotBtn();
      log("bot iniciado: rodando atividades ativas.");
      void runEnabledActivities();
    } else {
      stopPolling();
      void stopActivities();
      setBotBtn();
    }
  });

  // Checkbox de auto-login: persiste a preferencia; o disparo acontece no
  // polling quando o char esta fora de mundo (ver maybeAutoLogin).
  const chk = $("chk-login") as HTMLInputElement;
  try {
    chk.checked = localStorage.getItem("autologin") === "1";
  } catch {
    /* localStorage pode falhar em janela privada; ignora */
  }
  chk.addEventListener("change", () => {
    try {
      localStorage.setItem("autologin", chk.checked ? "1" : "0");
    } catch {
      /* ignora */
    }
    log(chk.checked ? "auto-login ligado." : "auto-login desligado.");
  });
  // Cada origem no main ja prefixa a sua ([login], [tower], [continental], [watchdog]).
  window.sro.onLog((m) => log(m));

  // Versao e atualizacao: o botao so aparece com a versao nova ja baixada; instalar
  // so com o clique (ver main/updater.ts).
  void window.sro.appVersion().then((v) => ($("app-version").textContent = `v${v}`));
  const showUpdate = (s: UpdateUiState) => {
    const btn = $("btn-update") as HTMLButtonElement;
    const ver = $("app-version");
    btn.classList.toggle("hidden", s.kind !== "ready");
    if (s.kind === "ready") btn.textContent = `Atualizar para v${s.version}`;
    ver.title = s.kind === "off" || s.kind === "error" ? s.reason ?? "" : s.kind === "downloading" ? `baixando v${s.version}${s.pct !== undefined ? ` (${s.pct}%)` : ""}` : "";
  };
  void window.sro.updateState().then(showUpdate);
  window.sro.onUpdate(showUpdate);
  $("btn-update").addEventListener("click", async () => {
    const btn = $("btn-update") as HTMLButtonElement;
    btn.disabled = true;
    // O app novo abre o jogo (so reconecta) e religa o bot se estavam ligados.
    if (!(await window.sro.updateInstall({ game: gameOpen, bot: polling }))) btn.disabled = false;
  });

  // Acabou de atualizar: volta como estava (Abrir jogo so reconecta com o char em
  // mundo; Iniciar bot so depois do jogo aberto).
  void window.sro.updateResume().then(async (r) => {
    if (!r || (!r.game && !r.bot)) return;
    log(`atualizado para ${$("app-version").textContent || "a versao nova"}: ${r.bot ? "reabrindo o jogo e religando o bot" : "reabrindo o jogo"}.`);
    if (!gameOpen) ($("btn-game") as HTMLButtonElement).click();
    const t0 = Date.now();
    while (!gameOpen && Date.now() - t0 < 180000) await new Promise((res) => setTimeout(res, 1000));
    if (!gameOpen) {
      log("o jogo nao abriu depois da atualizacao; abra e inicie o bot a mao.");
      return;
    }
    if (r.bot && !polling) ($("btn-bot") as HTMLButtonElement).click();
  });

  $("btn-once").addEventListener("click", readOnce);
  $("btn-stats-reset").addEventListener("click", resetStats);

  applyTrainUi(loadTrainConfig());
  for (const id of ["tr-deaths", "tr-potions", "tr-sw-few", "tr-sw-min", "tr-sw-radius", "tr-sw-deaths-on", "tr-sw-deaths",
    "tr-stop-level-on", "tr-stop-level", "tr-stop-exp", "tr-stop-gold-on", "tr-stop-gold", "tr-home-on", "tr-team-on", "tr-team-same", "tr-sw-hp-on", "tr-sw-hp", "tr-booster", "tr-buff-dano", "tr-buff-vip", "tr-berserk", "tr-devil", "tr-skills", "tr-sell", "tr-players"])
    $(id).addEventListener("change", saveTrainConfig);
  $("btn-tr-spot").addEventListener("click", async () => {
    const r = await window.sro.trainSpot();
    if (!r.ok || !r.spot) {
      log("salvar ponto falhou: " + (r.erro ?? "erro"));
      return;
    }
    trainSpots.push({ ...r.spot, range: 150 });
    saveTrainConfig();
    showTrainSpots();
    log(`ponto ${trainSpots.length} salvo: ${spotLabel(r.spot)}${r.spot.channel ? `, canal ${r.spot.channel}` : ""}`);
  });
  $("btn-tr-spot-clear").addEventListener("click", () => {
    trainSpots = [];
    saveTrainConfig();
    showTrainSpots();
    log("pontos de treino limpos.");
  });
  $("btn-tr-home").addEventListener("click", async () => {
    const r = await window.sro.trainSpot();
    if (!r.ok || !r.spot) {
      log("salvar cidade falhou: " + (r.erro ?? "erro"));
      return;
    }
    trainHome = { scene: r.spot.scene, x: r.spot.x, y: r.spot.y, z: r.spot.z };
    saveTrainConfig();
    showTrainSpots();
    log("cidade salva: " + spotLabel(trainHome));
  });
  $("btn-af-on").addEventListener("click", () => {
    log("ligando treino...");
    void runTrainActivity(true);
  });
  $("btn-af-off").addEventListener("click", async () => {
    log("parando treino...");
    await runTrainActivity(false);
    log("treino parado.");
  });

  // Checkboxes "Ativa" das atividades (persistidos): Iniciar bot roda as marcadas.
  wireActivityFlag("act-train", "act-train");
  wireActivityFlag("act-tower", "act-tower");
  wireActivityFlag("act-cont", "act-cont");
  wireActivityFlag("act-firm", "act-firm");
  wireActivityFlag("act-guild", "act-guild");
  wireActivityFlag("act-actchest", "act-actchest");
  wireActivityFlag("act-freebies", "act-freebies");
  wireActivityFlag("fb-donate", "fb-donate");
  wireActivityFlag("act-qigong", "act-qigong");
  applyQigongUi(loadQigongConfig());
  $("btn-qg-save").addEventListener("click", () => {
    saveQigongConfig();
    log("config do Qigong salva.");
  });
  // Convite de Qigong: some em 15 s.
  window.setInterval(() => void maybeAcceptQigong().catch(() => undefined), 4000);
  void window.sro.getSettings().then(showSettings);
  $("btn-st-save").addEventListener("click", async () => {
    if (gameOpen) {
      log("feche o jogo antes de trocar a configuracao.");
      return;
    }
    const v = await window.sro.setSettings(readSettingsUi());
    showSettings(v);
    log(v.warn ? `configuracao salva, mas ${v.warn}.` : "configuracao salva.");
  });
  $("btn-st-test").addEventListener("click", () => void testSettingsUi());
  void wireAi();
  $("btn-vpn-on").addEventListener("click", () => void vpnAction(() => window.sro.vpnEnable(lastVpn?.missing ?? [])));
  $("btn-vpn-off").addEventListener("click", () => void vpnAction(() => window.sro.vpnDisable()));
  $("btn-vpn-ping").addEventListener("click", () => void measureVpnPing());
  void refreshVpn();
  window.setInterval(() => void maybeRunDailies().then(() => maybeRunContinental()).then(() => maybeRunChests()).then(() => maybeRunActChests()).then(() => maybeRunFreebies()).then(() => maybeRequestQigong()), 60 * 1000);
  // Mochila: confere a cada 2 min com o bot rodando e o char em mundo.
  window.setInterval(() => {
    if (polling && !watchdogBusy && !loggingIn && outOfWorldSince === 0) void checkBag().catch(() => undefined);
  }, 2 * 60 * 1000);
  // Historico: uma amostra por minuto com o bot rodando.
  window.setInterval(() => {
    if (polling && !watchdogBusy && !loggingIn) {
      void window.sro.histTick(trainRunning).catch(() => false);
      void checkExpRate().catch(() => undefined);
    }
  }, 60 * 1000);
  // Tunel ligado mas mudo: o check reinicia (ou cai pra rota direta).
  window.setInterval(() => {
    if (polling && !vpnBusy) void window.sro.vpnHealth().then(() => refreshVpn());
  }, 2 * 60 * 1000);
  // IPs do jogo mudam com o servidor: confere de tempos em tempos com o bot rodando.
  window.setInterval(() => {
    if (polling && !vpnBusy) void refreshVpn();
  }, 5 * 60 * 1000);
  applyFirmUi(loadFirmConfig());
  $("btn-fm-save").addEventListener("click", () => {
    saveFirmConfig();
    log("config do Firm salva.");
  });
  applyGuildUi(loadGuildConfig());
  $("btn-gu-save").addEventListener("click", () => {
    saveGuildConfig();
    log("config do Guild utilities salva.");
  });

  // Demon Locking Tower: carrega a config salva, salvar e rodar (por metodo).
  applyTowerUi(loadTowerConfig());
  $("btn-dlt-save").addEventListener("click", () => {
    saveTowerConfig();
    log("config do Demon Locking Tower salva.");
  });

  // Continental Exploration: mesma ideia.
  applyContUi(loadContConfig());
  $("btn-ce-save").addEventListener("click", () => {
    saveContConfig();
    log("config do Continental Exploration salva.");
  });

  document.querySelectorAll<HTMLElement>(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("tab-active"));
      tab.classList.add("tab-active");
      const name = tab.dataset.tab!;
      for (const t of ["status", "stats", "activities", "tools", "ai"]) {
        $(`tab-${t}`).classList.toggle("hidden", t !== name);
      }
    });
  });
}

wire();
setConn("off", "desconectado");
log("pronto. Iniciar injeta e sobe o jogo (marque Auto-login pra logar sozinho). Parar restaura.");

export {};
