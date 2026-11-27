// Auto-login 100% por metodo (sem tap). Le o sub-estado da tela de login pelo
// engine (getv/GETP), decide UMA acao com nextLoginStep e manda o callsn
// correspondente, ate o char estar em mundo. Substitui a versao por screencap +
// toque (regra: nenhuma acao in-game por posicao de tela).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ACCOUNT_LOGIN_HINT_MS,
  awaitingAccountLogin,
  LOGIN_BUSY_PROBES,
  LOGIN_PROBES,
  type LoginProfile,
  type LoginSnapshot,
  PROFILE_PROBES,
  nextLoginStep,
  parseCharSlots,
  PKG_DOWNLOAD_MAX_MS,
  PKG_PROBES,
  pkgNameFromTitle,
  serverIdFromLabel,
} from "../controller/login";
import {
  ProgressEta,
  UPDATE_PHASE,
  UPDATE_PROBES,
  type UpdateSnapshot,
  describeProgress,
  floatFromBits,
  formatDuration,
  nextUpdateStep,
  updateActive,
  updateMakingProgress,
} from "../controller/update";
import { adbBin, gamePkg } from "./adbbin";
import { hasCredentials } from "./credentials";
import { sdkLogin } from "./sdklogin";
import { adbForward, queryPlayer, sendCommand } from "./engine";

const execFileP = promisify(execFile);

// Mesmo alvo repetido antes disso e ignorado: handlers de UI levam um frame ou
// mais pra trocar o painel, e chamar de novo no meio reseta o fluxo.
const SAME_ACTION_COOLDOWN_MS = 5000;

type Log = (msg: string) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Null = engine fora (jogo carregando antes do XMainClient, ou nao injetado).
async function readLoginSnapshot(host: string, port: number): Promise<LoginSnapshot | null> {
  const p = await queryPlayer(host, port);
  const s: LoginSnapshot = {
    inWorld: p.ok, loginView: false, selectChar: false, announcement: false,
    serverFrame: false, regionFrame: false, notify: false, queue: false, busy: false,
    pkgDlg: false, pkgDownloading: false,
  };
  if (s.inWorld) return s;
  let answered = 0;
  for (const pr of LOGIN_PROBES) {
    const r = await sendCommand(host, port, pr.tag, pr.body);
    if (r.ok === true) answered++;
    s[pr.key] = r.bool === true;
  }
  for (const pr of LOGIN_BUSY_PROBES) {
    const r = await sendCommand(host, port, pr.tag, pr.body);
    if (r.bool === true) s.busy = true;
  }
  if (!s.pkgDlg) s.pkgDownloading = false; // o campo fica true depois do dialogo fechar
  return answered > 0 ? s : null;
}

// Estado do launcher (XUpdater/XLoadingUI, Core.dll). Null = engine fora ou
// XUpdater sem resposta.
async function readUpdateSnapshot(host: string, port: number): Promise<UpdateSnapshot | null> {
  const ph = await sendCommand(host, port, "GETP", UPDATE_PROBES.phase);
  if (ph.ok !== true || typeof ph.int !== "number") return null;
  const s: UpdateSnapshot = { phase: ph.int };
  if (!updateActive(s.phase)) return s;
  const app = await sendCommand(host, port, "GETP", UPDATE_PROBES.appUpdate);
  s.appUpdate = app.bool === true;
  if (s.phase === UPDATE_PHASE.DOWNLOAD_BUNDLE || s.phase === UPDATE_PHASE.EXTRACT_BUNDLE) {
    const pv = await sendCommand(host, port, "GETP", UPDATE_PROBES.progress);
    if (typeof pv.int === "number") s.progress = floatFromBits(pv.int);
    const tb = await sendCommand(host, port, "GETP", UPDATE_PROBES.totalBytes);
    if (typeof tb.int === "number") s.totalBytes = tb.int >>> 0;
    const rt = await sendCommand(host, port, "GETP", UPDATE_PROBES.gameEta);
    if (typeof rt.int === "number") s.gameEtaS = floatFromBits(rt.int);
  }
  return s;
}

// Regiao e servidor, lidos com o painel "Let's go" na tela.
async function readProfile(host: string, port: number): Promise<LoginProfile> {
  const out: LoginProfile = {};
  for (const pr of PROFILE_PROBES) {
    const r = await sendCommand(host, port, "GETP", pr.body);
    if (r.ok !== true) continue;
    const v = pr.kind === "int" ? r.int : r.str;
    if (typeof v === "number" || typeof v === "string")
      (out as Record<string, unknown>)[pr.field] = v;
  }
  return out;
}

type ServerEntry = { id: number; name: string };

// Ids e nomes de XLoginDocument._server_dic (KEYS + ServerName de cada um).
async function readServers(host: string, port: number): Promise<ServerEntry[]> {
  const r = await sendCommand(host, port, "KEYS", "XLoginDocument _server_dic");
  const keys = Array.isArray(r.keys) ? (r.keys as number[]) : [];
  const out: ServerEntry[] = [];
  for (const id of keys) {
    const n = await sendCommand(host, port, "GETP", `XLoginDocument _server_dic get_Item:${id} ServerName`);
    if (typeof n.str === "string" && n.str) out.push({ id, name: n.str });
  }
  return out;
}

async function readServerLabel(host: string, port: number): Promise<string> {
  const r = await sendCommand(host, port, "GETP", "XLoginView m_uiBehaviour m_CurrentServer GetText");
  return typeof r.str === "string" ? r.str : "";
}

// Labels crus dos slots da tela de char.
async function readCharSlots(host: string, port: number): Promise<string[]> {
  const n = await sendCommand(host, port, "GETP", "XSelectCharView m_selectCharUIMgr get_Length");
  const len = typeof n.int === "number" ? Math.min(n.int, 16) : 0;
  const out: string[] = [];
  for (let i = 0; i < len; i++) {
    const r = await sendCommand(
      host, port, "GETP", `XSelectCharView m_selectCharUIMgr [${i}] label_name GetText`,
    );
    out.push(typeof r.str === "string" ? r.str : "");
  }
  return out;
}

function describe(s: LoginSnapshot): string {
  const on = (Object.keys(s) as (keyof LoginSnapshot)[]).filter((k) => s[k] === true);
  return on.length ? on.join(",") : "nada visivel";
}

// Parar bot cancela o login em andamento: sem isso ele seguia ate o prazo (sem
// limite enquanto espera a atualizacao ou o login da conta) e agia sozinho.
// Login da conta com o ID salvo (tela nativa do SDK): espera um pouco a tela
// assentar, tenta ate 3 vezes, uma por minuto (o erro LBATx2 do SDK passa).
const SDK_FIRST_MS = 5000;
const SDK_RETRY_MS = 60000;
const SDK_MAX_TRIES = 3;

let loginGen = 0;
export function stopAutoLogin(): void {
  loginGen++;
}

export async function autoLogin(
  serial: string,
  host: string,
  port: number,
  doLaunch: boolean,
  log: Log = () => {},
  timeoutMs = 240000,
  target: LoginProfile = {},
): Promise<{ ok: boolean; profile: LoginProfile }> {
  await execFileP(adbBin(), ["connect", serial], { timeout: 30000 }).catch(() => {});
  if (doLaunch) {
    log("iniciando o jogo...");
    await execFileP(adbBin(), [
      "-s", serial, "shell", "monkey", "-p", gamePkg(), "-c", "android.intent.category.LAUNCHER", "1",
    ], { timeout: 30000 }).catch(() => {});
  }
  await adbForward(serial, port).catch(() => {});
  // Prazo do login. Enquanto o jogo baixa/extrai uma atualizacao o prazo anda
  // junto: um pacote de 500 MB leva minutos e nao e travamento.
  let deadline = Date.now() + timeoutMs;
  let lastState = "";
  let lastAction = "";
  let lastActionAt = 0;
  // So o que foi lido NESTE login; o main junta com o salvo (mergeProfile).
  let profile: LoginProfile = {};
  let servers: ServerEntry[] = [];
  let serversRegion: number | undefined;
  // Atualizacao: inicio (pra medir ate a tela de notificacoes), fase anterior e
  // estimativa por velocidade. Log de progresso a cada 15 s.
  let updateStartedAt = 0;
  let updatePhase = -1;
  let eta = new ProgressEta();
  let lastProgressLog = 0;
  // Login da conta pendente: desde quando e se ja avisou.
  let accountWaitSince = 0;
  let accountHinted = false;
  // Login da conta com o ID salvo: tentativas e quando foi a ultima.
  let sdkTries = 0;
  let sdkLastAt = 0;
  // Pacote do mapa: ultimo progresso lido e quando logou.
  let pkgProgress = "";
  let pkgLogAt = 0;
  let pkgSince = 0;
  const gen = loginGen;
  while (Date.now() < deadline) {
    if (gen !== loginGen) {
      log("login parado.");
      return { ok: false, profile };
    }
    const u = await readUpdateSnapshot(host, port);
    if (u && updateActive(u.phase)) {
      const now = Date.now();
      if (!updateStartedAt) {
        updateStartedAt = now;
        log("atualizacao do jogo detectada.");
      }
      if (u.phase !== updatePhase) {
        updatePhase = u.phase;
        eta = new ProgressEta();
        lastProgressLog = 0;
      }
      if (updateMakingProgress(u.phase)) deadline = now + timeoutMs;
      if (u.progress !== undefined) eta.add(now, u.progress);
      const step = nextUpdateStep(u);
      if (step.kind === "fail") {
        log(`atualizacao: ${step.reason}`);
        return { ok: false, profile };
      }
      if (step.kind === "act") {
        if (step.body !== lastAction || now - lastActionAt >= step.cooldownMs) {
          if (step.body.includes("OnUpdateAssetConfirmCallBack") && u.totalBytes === undefined) {
            const tb = await sendCommand(host, port, "GETP", UPDATE_PROBES.totalBytes);
            if (typeof tb.int === "number" && tb.int)
              log(`atualizacao: pacote de ${Math.round((tb.int >>> 0) / (1024 * 1024))} MB`);
          }
          log(`atualizacao: ${step.name}`);
          await sendCommand(host, port, "SKIL", step.body);
          lastAction = step.body;
          lastActionAt = now;
        }
        await sleep(2500);
        continue;
      }
      if (step.kind === "wait") {
        const line = describeProgress(u, eta);
        const st = `atualizacao: ${step.reason}`;
        if (st !== lastState || (u.progress !== undefined && now - lastProgressLog >= 15000)) {
          log(u.progress !== undefined ? `atualizacao: ${line}` : st);
          lastState = st;
          lastProgressLog = now;
        }
        await sleep(2000);
        continue;
      }
    }
    const s = await readLoginSnapshot(host, port);
    if (!s) {
      if (lastState !== "engine fora") log("login: aguardando o engine...");
      lastState = "engine fora";
      await sleep(2000);
      continue;
    }
    const st = describe(s);
    if (st !== lastState) {
      log(`login: ${st}`);
      lastState = st;
    }
    if (awaitingAccountLogin(s)) {
      // Esperando a pessoa logar a conta: o prazo anda junto, como na atualizacao.
      const now = Date.now();
      if (!accountWaitSince) accountWaitSince = now;
      deadline = now + timeoutMs;
      if (hasCredentials() && sdkTries < SDK_MAX_TRIES && now - accountWaitSince >= SDK_FIRST_MS
        && now - sdkLastAt >= SDK_RETRY_MS) {
        sdkTries++;
        sdkLastAt = now;
        log(`a conta nao esta logada: entrando com o ID salvo (tentativa ${sdkTries}/${SDK_MAX_TRIES}).`);
        const r = await sdkLogin(serial, log).catch((e) => {
          log("login da conta: falhou ao ler a tela (" + String(e).slice(0, 120) + ").");
          return "error" as const;
        });
        if (r === "none") log("login da conta: a tela de login do SDK nao apareceu.");
        if (r === "badcred") {
          // Senha errada repetida pode bloquear a conta: para aqui.
          sdkTries = SDK_MAX_TRIES;
          log("login da conta: o SDK recusou o ID ou a senha salvos; parei de tentar pra nao bloquear a conta. Confira em Ferramentas > Conta do jogo.");
        }
        await sleep(3000);
        continue;
      }
      if (!accountHinted && now - accountWaitSince >= ACCOUNT_LOGIN_HINT_MS && (!hasCredentials() || sdkTries >= SDK_MAX_TRIES)) {
        log(hasCredentials()
          ? "a conta continua deslogada depois de 3 tentativas com o ID salvo: confira o ID e a senha (Ferramentas) ou faca o login na janela do emulador."
          : "a conta nao esta logada neste emulador: faca o login (Google, ID ou Convidado) na janela do emulador, ou salve o ID e a senha em Ferramentas. o bot continua sozinho depois.");
        accountHinted = true;
      }
    } else {
      accountWaitSince = 0;
    }
    if (updateStartedAt && (s.loginView || s.announcement || s.inWorld)) {
      // Fim da atualizacao: o login carregou (a tela de notificacoes vem junto).
      log(`atualizacao concluida em ${formatDuration((Date.now() - updateStartedAt) / 1000)}, login na tela.`);
      updateStartedAt = 0;
    }
    if ((s.serverFrame || s.regionFrame) && !s.announcement) {
      const reg = await sendCommand(host, port, "GETP", "XLoginDocument _last_region_id");
      s.regionId = typeof reg.int === "number" ? reg.int : undefined;
    }
    if (s.serverFrame && !s.announcement && !s.regionFrame) {
      // A lista de servidores e da regiao: relê quando ela muda.
      if (s.regionId !== serversRegion) servers = [];
      serversRegion = s.regionId;
      if (!servers.length) servers = await readServers(host, port);
      s.serverId = serverIdFromLabel(await readServerLabel(host, port), servers);
      // Servidor pedido so pelo nome (char "Nome@Servidor"): o id sai da lista.
      if (target.serverId === undefined && target.serverName) {
        const id = serverIdFromLabel(target.serverName, servers);
        if (id !== undefined) target = { ...target, serverId: id };
      }
    }
    if (s.selectChar) {
      const slots = parseCharSlots(await readCharSlots(host, port));
      s.chars = slots.names;
      s.selectedChar = slots.selected;
      s.charInfoIdx = [];
      for (let i = 0; i < slots.names.length; i++) {
        const r = await sendCommand(host, port, "GETP", `XSelectCharView ConvertSlotToInfoIdx:${i}`);
        s.charInfoIdx.push(typeof r.int === "number" ? r.int : -1);
      }
      const sel = await sendCommand(host, port, "GETP", "XSelectCharView _doc _currentSelectedIndex");
      s.selectedInfo = sel.ok === true && typeof sel.int === "number" ? sel.int : undefined;
    }
    if (s.pkgDlg && s.pkgDownloading) {
      // Pacote do mapa baixando: o prazo anda o download inteiro, ate o teto.
      const now = Date.now();
      if (!pkgSince) pkgSince = now;
      if (now - pkgSince < PKG_DOWNLOAD_MAX_MS) deadline = now + timeoutMs;
      const pr = await sendCommand(host, port, "GETP", PKG_PROBES.progress);
      const pct = typeof pr.str === "string" ? pr.str : "";
      if (pct !== pkgProgress) {
        if (!pkgProgress || now - pkgLogAt >= 15000) {
          const t = await sendCommand(host, port, "GETP", PKG_PROBES.title);
          const map = typeof t.str === "string" ? pkgNameFromTitle(t.str) : undefined;
          log(`pacote do mapa${map ? ` ${map}` : ""}: ${pct || "?"}`);
          pkgLogAt = now;
        }
        pkgProgress = pct;
      }
    } else {
      pkgProgress = "";
      pkgSince = 0;
    }
    const step = nextLoginStep(s, target);
    if (step.kind === "done") {
      const p = await queryPlayer(host, port);
      if (p.name) profile = { ...profile, charName: p.name };
      log("em mundo. login completo.");
      return { ok: true, profile };
    }
    if (step.kind === "act") {
      // Perfil lido logo antes do Let's go, ja com o servidor certo na tela.
      if (step.body.includes("OnEnterToSelectCharClicked"))
        profile = { ...profile, ...(await readProfile(host, port)), serverId: s.serverId };
      const now = Date.now();
      const cooldown = step.cooldownMs ?? SAME_ACTION_COOLDOWN_MS;
      if (step.body !== lastAction || now - lastActionAt >= cooldown) {
        log(`login: ${step.name}`);
        await sendCommand(host, port, "SKIL", step.body);
        lastAction = step.body;
        lastActionAt = now;
      }
      await sleep(2500);
      continue;
    }
    await sleep(1500);
  }
  log("timeout: nao chegou ao mundo.");
  return { ok: false, profile };
}
