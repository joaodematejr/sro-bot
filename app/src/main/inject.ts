// Injecao/restauracao do engine pelo processo main do Electron, por adb direto
// (sem bash). Antes de injetar guarda o libmain.so que
// esta no aparelho (na pasta do app, por emulador) e no fechar devolve ele.
//   libmain.so = o nosso loader (o Android carrega este)
//   libcore.so = o libmain ORIGINAL do jogo; o loader faz dlopen dele
//   libsroengine.so = o engine
// Jogo limpo (sem libcore): o bot copia o original pra libcore e apaga no fechar.
// Com outro loader de terceiros: o libcore dele ja e o jogo e fica como esta.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { describeBase, type GameState, gameStateFromPidof, type LibBase, planInject } from "../controller/libstate";
import {
  backupDirName,
  type CheckResult,
  consolePath,
  focusedPackage,
  gameChecks,
  gamePackage,
  type GameVersion,
  LD_STALE_SERVICES,
  libDirFromPmPath,
  type MumuInstance,
  otherGame,
  type OtherGameOpen,
  otherGameOpen,
  parseMumuInfo,
  parseTasklist,
  shouldUnstickLd,
} from "../controller/settings";
import { adbBin, emulator, gamePkg } from "./adbbin";

const execFileP = promisify(execFile);

// O pacote do jogo vem da configuracao (gamePkg: Global ou Europa).

// engine/build fica dois niveis acima de app/dist.
const ENGINE_DIR = path.join(__dirname, "..", "..", "engine");
const ENGINE_SO = path.join(ENGINE_DIR, "build", "libsroengine.so");
const LOADER_SO = path.join(ENGINE_DIR, "build", "libsroloader.so");

// Onde ficam as bases guardadas. O main troca pra pasta de dados do app.
let backupRoot = path.join(ENGINE_DIR, "local-backup");

export function setBackupDir(dir: string): void {
  backupRoot = dir;
}

function deviceDir(serial: string): string {
  return path.join(backupRoot, backupDirName(serial, gamePkg()));
}

function loadBase(serial: string): LibBase | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(deviceDir(serial), "base.json"), "utf8")) as LibBase;
  } catch {
    return null;
  }
}

function saveBase(serial: string, b: LibBase): void {
  fs.mkdirSync(deviceDir(serial), { recursive: true });
  fs.writeFileSync(path.join(deviceDir(serial), "base.json"), JSON.stringify(b, null, 2));
}

function baseFile(serial: string): string {
  return path.join(deviceDir(serial), "libmain.base.so");
}

function localMd5(file: string): string {
  return createHash("md5").update(fs.readFileSync(file)).digest("hex");
}

export type Logger = (msg: string) => void;

// Com o emulador travado (Android sem terminar o boot) o `am` nunca volta:
// sem prazo, o bot inteiro ficava preso esperando.
const ADB_TIMEOUT_MS = 60000;

async function adb(serial: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP(adbBin(), ["-s", serial, ...args], { timeout: ADB_TIMEOUT_MS });
  return stdout.replace(/\r/g, "").trim();
}

// Modo de root, detectado UMA vez por processo. O LDPlayer quase sempre ja da o
// shell do adb como root (uid 0): nesse caso roda o comando direto, sem su.
// Senao tenta `adb root` e, por ultimo, cai pro `su -c` por comando. Antes a
// gente embrulhava TODO comando em `su -c '...'`, o que subia um su a cada
// chamada (lento e podia repetir o prompt de root). Agora detecta so uma vez.
let suMode: "direct" | "su" | null = null;
let rootProbe: Promise<void> | null = null;

async function isShellRoot(serial: string): Promise<boolean> {
  try {
    return (await adb(serial, ["shell", "id", "-u"])).trim() === "0";
  } catch {
    return false;
  }
}

async function probeRoot(serial: string): Promise<void> {
  if (await isShellRoot(serial)) {
    suMode = "direct";
    return;
  }
  try {
    await execFileP(adbBin(), ["-s", serial, "root"], { timeout: ADB_TIMEOUT_MS });
    await new Promise((r) => setTimeout(r, 800));
    await execFileP(adbBin(), ["connect", serial], { timeout: ADB_TIMEOUT_MS }).catch(() => undefined);
  } catch {
    /* adbd pode recusar rodar como root; segue pro su */
  }
  suMode = (await isShellRoot(serial)) ? "direct" : "su";
}

// Garante que o modo de root foi detectado (idempotente, uma probe so mesmo com
// varias chamadas concorrentes graças ao latch de promise).
async function ensureRoot(serial: string): Promise<void> {
  if (suMode) return;
  if (!rootProbe) rootProbe = probeRoot(serial);
  await rootProbe;
}

// Detecta de novo no comeco de cada operacao: o emulador reiniciado volta com o
// adbd como shell, e o "direct" guardado da sessao anterior fazia o cp pro
// /data/local/tmp falhar com Permission denied (primeira abertura a frio).
function resetRoot(): void {
  suMode = null;
  rootProbe = null;
}

// Programa de linha de comando do emulador configurado (ldconsole ou MuMuManager).
function emuConsolePath(): string | null {
  const e = emulator();
  const candidates = e.emulator === "ldplayer"
    ? [process.env.LDPLAYER_DIR ? path.join(process.env.LDPLAYER_DIR, "ldconsole.exe") : "", consolePath(e),
      path.join(e.ldplayerDir, "dnconsole.exe")]
    : [consolePath(e)];
  return candidates.find((c) => c && fs.existsSync(c)) ?? null;
}

// Estado da instancia no MuMu (nome, Android ligado, porta do adb).
async function mumuInfo(): Promise<MumuInstance | undefined> {
  const c = emuConsolePath();
  if (!c) return undefined;
  try {
    const { stdout } = await execFileP(c, ["info", "-v", String(emulator().instance)], { timeout: 20000 });
    return parseMumuInfo(stdout, emulator().instance);
  } catch {
    return undefined;
  }
}

// Processos rodando no Windows (nomes do tasklist).
async function runningProcesses(): Promise<Set<string>> {
  try {
    const { stdout } = await execFileP("tasklist", ["/FO", "CSV", "/NH"], { timeout: 15000 });
    return parseTasklist(stdout);
  } catch {
    return new Set();
  }
}

// Endereco do adb da instancia: no MuMu, a porta que ele informa; senao o padrao.
export async function resolveSerial(fallback: string): Promise<string> {
  if (emulator().emulator !== "mumu") return fallback;
  return (await mumuInfo())?.adbSerial ?? fallback;
}

async function deviceOnline(serial: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP(adbBin(), ["-s", serial, "get-state"], { timeout: ADB_TIMEOUT_MS });
    return stdout.trim() === "device";
  } catch {
    return false;
  }
}

// Jogo rodando (pidof), separando "fechado" de "adb sem resposta": o pidof sem
// processo sai com erro e, antes, erro do adb tambem virava "fechado". Com
// `|| echo none` o erro so sobra pra falha do adb.
export async function gameState(serial: string): Promise<GameState> {
  try {
    return gameStateFromPidof(await sue(serial, `pidof ${gamePkg()} || echo none`));
  } catch {
    return "unknown";
  }
}

// Checagem do ambiente pra tela de configuracao: LDPlayer, adb, emulador
// online, root e jogo instalado. Nao muda nada no aparelho.
export async function checkEnvironment(serial: string, instance: number): Promise<CheckResult[]> {
  resetRoot();
  const out: CheckResult[] = [];
  const e = emulator();
  const label = e.emulator === "mumu" ? "MuMu" : "LDPlayer";
  const console = emuConsolePath();
  if (!console) {
    out.push({ name: label, ok: false, detail: `${consolePath(e)} nao achado` });
  } else if (e.emulator === "mumu") {
    const info = await mumuInfo();
    out.push(info
      ? { name: label, ok: true, detail: `instancia ${instance} "${info.name}" ${info.started ? "aberta" : "fechada"}${info.adbSerial ? ` (adb ${info.adbSerial})` : ""}` }
      : { name: label, ok: false, detail: `instancia ${instance} nao existe (MuMuManager info)` });
  } else {
    try {
      const { stdout } = await execFileP(console, ["list2"], { timeout: 15000 });
      const line = stdout.split(/\r?\n/).find((l) => l.split(",")[0] === String(instance));
      const cols = line ? line.split(",") : [];
      out.push(line
        ? { name: label, ok: true, detail: `instancia ${instance} "${cols[1]}" ${cols[4] === "1" ? "aberta" : "fechada"}` }
        : { name: label, ok: false, detail: `instancia ${instance} nao existe (ldconsole list2)` });
    } catch (err) {
      out.push({ name: label, ok: false, detail: `ldconsole falhou: ${String(err).slice(0, 80)}` });
    }
  }
  try {
    const { stdout } = await execFileP(adbBin(), ["version"], { timeout: 15000 });
    out.push({ name: "adb", ok: true, detail: `${adbBin()} (${stdout.split(/\r?\n/)[0].trim()})` });
  } catch (e) {
    out.push({ name: "adb", ok: false, detail: `${adbBin()} nao roda: ${String(e).slice(0, 80)}` });
    return out;
  }
  await execFileP(adbBin(), ["connect", serial], { timeout: 15000 }).catch(() => undefined);
  const online = await deviceOnline(serial);
  out.push({ name: "emulador", ok: online, detail: online ? `${serial} online` : `${serial} nao responde (abra a instancia e ligue o ADB nas configuracoes do ${label})` });
  if (!online) return out;
  try {
    const id = await sue(serial, "id -u");
    out.push({ name: "root", ok: id.trim() === "0", detail: id.trim() === "0" ? `ok (${suMode})` : `sem root (ligue o root nas configuracoes do ${label})` });
  } catch {
    out.push({ name: "root", ok: false, detail: `sem root (ligue o root nas configuracoes do ${label})` });
  }
  // Os dois APKs (Global e Europa), dizendo qual o bot usa.
  const installed = async (g: GameVersion) =>
    (await adb(serial, ["shell", "pm", "path", gamePackage(g)]).catch(() => "")).includes("package:");
  out.push(...gameChecks(e.game, { global: await installed("global"), eu: await installed("eu") }));
  return out;
}

// A versao do jogo que NAO esta na configuracao esta aberta (na frente ou em
// segundo plano)? Leitura sem root (dumpsys e pidof rodam como o shell do adb),
// pra poder rodar de tempos em tempos sem subir su. undefined = nao, ou sem
// resposta do adb.
export async function otherGameState(serial: string): Promise<OtherGameOpen | undefined> {
  const sel = emulator().game;
  try {
    const focus = await adb(serial, ["shell", "dumpsys window | grep mCurrentFocus"]).catch(() => "");
    const pid = await adb(serial, ["shell", `pidof ${gamePackage(otherGame(sel))} || echo none`]);
    return otherGameOpen(sel, focusedPackage(focus), gameStateFromPidof(pid) === "running");
  } catch {
    return undefined;
  }
}

// Fecha o jogo sem mexer nas libs (o engine injetado volta no proximo start).
export async function stopGame(serial: string): Promise<void> {
  await sue(serial, `am force-stop ${gamePkg()}`);
}

// True se o jogo esta em PRIMEIRO PLANO (activity focada). Fechar o jogo no
// emulador manda ele pra background sem matar o processo, entao pidof nao basta:
// o watchdog checa o foreground.
export async function gameForeground(serial: string): Promise<boolean> {
  try {
    const out = await sue(serial, "dumpsys window | grep mCurrentFocus");
    return out.includes(gamePkg());
  } catch {
    return false;
  }
}

// Traz o jogo pra frente (ou relanca se o processo morreu; a lib injetada sobe
// o engine de novo). Leve: nao faz restore/inject.
export async function bringGameToFront(serial: string, log: Logger = () => {}): Promise<void> {
  log("trazendo o jogo pra frente...");
  await sue(serial, `monkey -p ${gamePkg()} -c android.intent.category.LAUNCHER 1`);
}

// Garante o emulador aberto. Se o device ja responde, nao faz nada. Senao tenta
// abrir pelo ldconsole (best-effort) e espera o device ficar online.
// Garante o emulador aberto. Se o device ja responde, nao faz nada. Senao abre a
// instancia pelo ldconsole/MuMuManager (best-effort) e espera o adb. Devolve o
// endereco final (no MuMu a porta so e conhecida com a instancia aberta).
export async function ensureEmulator(serial: string, log: Logger = () => {}): Promise<string> {
  const e = emulator();
  let target = await resolveSerial(serial);
  if (await deviceOnline(target)) {
    log("emulador ja aberto");
    return target;
  }
  const console = emuConsolePath();
  if (!console) {
    log(`${e.emulator === "mumu" ? "MuMuManager" : "ldconsole"} nao encontrado (confira a pasta na configuracao); abra o emulador manualmente`);
    return target;
  }
  log(`abrindo ${e.emulator === "mumu" ? "MuMu" : "LDPlayer"} instancia ${e.instance}...`);
  const args = e.emulator === "mumu"
    ? ["control", "-v", String(e.instance), "launch"]
    : ["launch", "--index", String(e.instance)];
  try {
    await execFileP(console, args, { timeout: 30000 });
  } catch {
    /* best-effort */
  }
  const launchedAt = Date.now();
  let unstuck = false;
  for (let i = 0; i < 120; i++) {
    target = await resolveSerial(target);
    try {
      await execFileP(adbBin(), ["connect", target], { timeout: ADB_TIMEOUT_MS });
    } catch {
      /* ainda subindo */
    }
    if (await deviceOnline(target)) {
      log(`emulador pronto (${target})`);
      return target;
    }
    if (shouldUnstickLd(e.emulator, await runningProcesses(), Date.now() - launchedAt, false, unstuck)) {
      unstuck = true;
      log("o LDPlayer nao subiu: encerrando os servicos presos (Ld9BoxSVC, VBoxNetNAT, VBoxNetDHCP) e abrindo de novo...");
      const args = LD_STALE_SERVICES.flatMap((n) => ["/IM", n]);
      await execFileP("taskkill", ["/F", ...args], { timeout: 20000 }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 3000));
      await execFileP(console, ["launch", "--index", String(e.instance)], { timeout: 30000 }).catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  log("emulador nao ficou pronto a tempo");
  return target;
}

// Roda um comando com privilegio de root. Detecta o modo uma vez (ver
// probeRoot): shell ja root roda direto; senao embrulha em `su -c '<cmd>'`.
async function sue(serial: string, cmd: string): Promise<string> {
  await ensureRoot(serial);
  if (suMode === "direct") {
    try {
      return await adb(serial, ["shell", cmd]);
    } catch (err) {
      // No boot o LDPlayer sobe o adbd como root por alguns segundos e depois o
      // reinicia como shell; a deteccao pode cair nessa janela. Sem root agora:
      // detecta de novo e repete o comando.
      if (!/Permission denied|Operation not permitted/i.test(String(err)) || (await isShellRoot(serial))) throw err;
      resetRoot();
      await ensureRoot(serial);
      if (suMode === "direct") return adb(serial, ["shell", cmd]);
    }
  }
  return adb(serial, ["shell", `su -c '${cmd}'`]);
}

async function md5(serial: string, remote: string): Promise<string> {
  const out = await sue(serial, `md5sum ${remote}`);
  return out.split(/\s+/)[0] ?? "";
}

async function exists(serial: string, remote: string): Promise<boolean> {
  return (await sue(serial, `[ -f ${remote} ] && echo 1 || echo 0`)).trim() === "1";
}

// Pasta das libs ARM do jogo. Pelo `pm path` (Android 9 e 11+, que poe um
// nivel aleatorio a mais em /data/app); se falhar, a busca antiga.
async function libDir(serial: string): Promise<string> {
  try {
    const dir = libDirFromPmPath(await adb(serial, ["shell", "pm", "path", gamePkg()]));
    if (dir && (await sue(serial, `[ -d ${dir} ] && echo 1 || echo 0`)).trim() === "1") return dir;
  } catch {
    /* cai na busca antiga */
  }
  const dir = await sue(serial, `ls -d /data/app/*${gamePkg()}*/lib/arm64`);
  if (!dir) throw new Error(`lib dir do ${gamePkg()} nao encontrado`);
  return dir;
}

// Dono/permissao/contexto SELinux de app pra uma lib no lib dir.
async function fixPerms(serial: string, dest: string): Promise<void> {
  await sue(serial, `chown system:system ${dest}`);
  await sue(serial, `chmod 755 ${dest}`);
  await sue(serial, `chcon u:object_r:apk_data_file:s0 ${dest}`);
}

// Empurra um arquivo local para /data/local/tmp e copia para o destino.
// execFile passa o caminho local como argumento (sem shell), entao nao ha
// conversao de path do MSYS.
async function pushInto(serial: string, local: string, dest: string, log: Logger): Promise<void> {
  const tmp = `/data/local/tmp/${path.basename(dest)}`;
  await adb(serial, ["push", local, tmp]);
  await sue(serial, `cp ${tmp} ${dest}`);
  await fixPerms(serial, dest);
  log(`ok: ${path.basename(dest)}`);
}

// Copia um arquivo do lib dir pro PC (o lib dir pode nao ser legivel pelo adb).
async function pullFrom(serial: string, remote: string, local: string): Promise<void> {
  const tmp = "/data/local/tmp/sro_base.so";
  await sue(serial, `cp ${remote} ${tmp}`);
  await sue(serial, `chmod 644 ${tmp}`);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  await adb(serial, ["pull", tmp, local]);
}

// Guarda o libmain.so atual como base. Confere o md5 da copia.
async function saveCurrentBase(serial: string, dir: string, mainMd5: string, log: Logger): Promise<LibBase> {
  const coreExisted = await exists(serial, `${dir}/libcore.so`);
  const coreMd5 = coreExisted ? await md5(serial, `${dir}/libcore.so`) : "";
  await pullFrom(serial, `${dir}/libmain.so`, baseFile(serial));
  if (localMd5(baseFile(serial)) !== mainMd5) throw new Error("copia do libmain original veio diferente");
  const b: LibBase = { libDir: dir, mainMd5, coreExisted, coreMd5, savedAt: new Date().toISOString() };
  saveBase(serial, b);
  log(`base guardada: ${describeBase(b)} (libmain ${mainMd5.slice(0, 8)})`);
  return b;
}

// Ja injetado e sem base guardada (injecao de versao antiga ou base apagada):
// o original do jogo e o libcore, entao a base vira "jogo limpo".
async function rebuildLegacyBase(serial: string, dir: string, log: Logger): Promise<LibBase> {
  const coreMd5 = await md5(serial, `${dir}/libcore.so`);
  await pullFrom(serial, `${dir}/libcore.so`, baseFile(serial));
  const b: LibBase = { libDir: dir, mainMd5: coreMd5, coreExisted: false, coreMd5: "", savedAt: new Date().toISOString() };
  saveBase(serial, b);
  log(`ja injetado sem base guardada; base reconstruida: ${describeBase(b)}`);
  return b;
}

// Injeta o engine. Guarda o que estava (se ainda nao for o nosso loader), monta
// o libcore se o jogo estiver limpo, empurra engine e loader e sobe o jogo.
export async function injectEngine(serial: string, log: Logger = () => {}): Promise<void> {
  resetRoot();
  const dir = await libDir(serial);
  log(`lib dir: ${dir} (root: ${suMode === "direct" ? "adb" : "su"})`);
  const ourMd5 = localMd5(LOADER_SO);
  const mainMd5 = await md5(serial, `${dir}/libmain.so`);
  const coreExists = await exists(serial, `${dir}/libcore.so`);
  log("parando o jogo...");
  await sue(serial, `am force-stop ${gamePkg()}`);

  const plan = planInject(dir, mainMd5, coreExists, ourMd5, loadBase(serial));
  if (plan.kind === "fresh") {
    await saveCurrentBase(serial, dir, mainMd5, log);
    if (plan.mode === "clean") {
      log("jogo limpo: copiando o libmain original pra libcore...");
      await sue(serial, `cp ${dir}/libmain.so ${dir}/libcore.so`);
      await fixPerms(serial, `${dir}/libcore.so`);
    }
  } else if (plan.kind === "legacy") {
    await rebuildLegacyBase(serial, dir, log);
  } else {
    log(`ja injetado; base guardada: ${describeBase(plan.base)}`);
  }

  log("empurrando engine e loader...");
  await pushInto(serial, ENGINE_SO, `${dir}/libsroengine.so`, log);
  await pushInto(serial, LOADER_SO, `${dir}/libmain.so`, log);

  log("subindo o jogo...");
  await sue(serial, `monkey -p ${gamePkg()} -c android.intent.category.LAUNCHER 1`);
  log("injetado. logue o char em mundo.");
}

// Devolve as libs ao que estava antes da injecao (base guardada), tira o engine
// e confere o md5.
// Le um arquivo que o engine grava na pasta do jogo (ex.: sro_objv.txt do OBJV).
// So nome simples, sem caminho.
export async function readGameFile(serial: string, name: string): Promise<string> {
  if (!/^[a-z_]+\.txt$/.test(name)) throw new Error("nome de arquivo invalido");
  return sue(serial, `cat /data/data/${gamePkg()}/files/${name}`);
}

export async function restoreGame(serial: string, log: Logger = () => {}): Promise<void> {
  resetRoot();
  const dir = await libDir(serial);
  log(`lib dir: ${dir}`);
  const ourMd5 = localMd5(LOADER_SO);
  const mainMd5 = await md5(serial, `${dir}/libmain.so`);
  log("parando o jogo...");
  await sue(serial, `am force-stop ${gamePkg()}`);
  if (mainMd5 !== ourMd5) {
    await sue(serial, `rm -f ${dir}/libsroengine.so`);
    log("nao estava injetado; nada a restaurar.");
    return;
  }
  let b = loadBase(serial);
  if (!b || b.libDir !== dir || !fs.existsSync(baseFile(serial))) b = await rebuildLegacyBase(serial, dir, log);

  log(`restaurando: ${describeBase(b)}...`);
  await pushInto(serial, baseFile(serial), `${dir}/libmain.so`, log);
  if (!b.coreExisted) await sue(serial, `rm -f ${dir}/libcore.so`);
  await sue(serial, `rm -f ${dir}/libsroengine.so`);

  const after = await md5(serial, `${dir}/libmain.so`);
  const coreNow = await exists(serial, `${dir}/libcore.so`);
  log(`libmain: ${after} | libcore: ${coreNow ? "presente" : "ausente"}`);
  if (after !== b.mainMd5 || coreNow !== b.coreExisted) throw new Error("md5 nao bate o esperado apos restaurar");
  log(`OK: restaurado (${describeBase(b)}).`);
}
