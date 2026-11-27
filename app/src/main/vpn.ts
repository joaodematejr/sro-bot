// Rota do jogo por VPN gratuita (WireGuard + WARP via wgcf). Instalar e remover
// o tunel pede administrador: um pedido do Windows (UAC) por acao, nunca sozinho.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildTunnelConf,
  gameServerIps,
  healthAction,
  missingIps,
  noProbeText,
  parsePing,
  parseServiceState,
  probeIp,
  seedIps,
  tunnelGame,
  type ServiceState,
  TUNNEL_NAME,
  tunnelIps,
  WG_SERVICE,
  WGCF_SHA256,
  WGCF_URL,
} from "../controller/vpn";
import { GAME_LABELS, type GameVersion } from "../controller/settings";
import { adbBin, gamePkg } from "./adbbin";

const execFileP = promisify(execFile);
type Log = (msg: string) => void;

const WIREGUARD_EXE = "C:\\Program Files\\WireGuard\\wireguard.exe";
const WHOAMI_EXE = "C:\\Windows\\System32\\whoami.exe";

let dir = "";

// Pasta de dados do app (conta do WARP, perfil e config do tunel).
export function setVpnDir(d: string): void {
  dir = d;
}

const file = (name: string) => path.join(dir, name);
const confPath = () => file(`${TUNNEL_NAME}.conf`);

export interface VpnStatus {
  wireguard: boolean; // WireGuard instalado
  account: boolean; // conta do WARP registrada
  service: ServiceState;
  ips: string[]; // IPs no tunel
  game?: GameVersion; // versao do jogo que montou o tunel (conf antigo: sem marca)
}

async function serviceState(): Promise<ServiceState> {
  try {
    const { stdout } = await execFileP("sc", ["query", WG_SERVICE], { timeout: 10000 });
    return parseServiceState(stdout);
  } catch (e) {
    // sc sai com erro quando o servico nao existe.
    const out = (e as { stdout?: string }).stdout ?? "";
    return parseServiceState(out);
  }
}

export async function vpnStatus(): Promise<VpnStatus> {
  let ips: string[] = [];
  let game: GameVersion | undefined;
  try {
    const conf = fs.readFileSync(confPath(), "utf8");
    ips = tunnelIps(conf);
    game = tunnelGame(conf);
  } catch {
    // sem tunel configurado
  }
  return {
    wireguard: fs.existsSync(WIREGUARD_EXE),
    account: fs.existsSync(file("wgcf-account.toml")),
    service: await serviceState(),
    ips,
    game,
  };
}

function sha256(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

// Baixa o wgcf da release oficial e confere o checksum publicado.
async function ensureWgcf(log: Log): Promise<string> {
  const exe = file("wgcf.exe");
  if (fs.existsSync(exe) && sha256(exe) === WGCF_SHA256) return exe;
  log("baixando o wgcf (open source) do GitHub...");
  const res = await fetch(WGCF_URL);
  if (!res.ok) throw new Error(`download do wgcf falhou (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (createHash("sha256").update(buf).digest("hex") !== WGCF_SHA256) throw new Error("checksum do wgcf nao confere");
  fs.writeFileSync(exe, buf);
  return exe;
}

// Conta gratuita do WARP (uma vez) e o perfil WireGuard dela.
async function ensureProfile(log: Log): Promise<string> {
  const exe = await ensureWgcf(log);
  if (!fs.existsSync(file("wgcf-account.toml"))) {
    log("registrando a conta gratuita do WARP...");
    await execFileP(exe, ["register", "--accept-tos"], { cwd: dir, timeout: 60000 });
  }
  if (!fs.existsSync(file("wgcf-profile.conf"))) {
    await execFileP(exe, ["generate"], { cwd: dir, timeout: 60000 });
  }
  return fs.readFileSync(file("wgcf-profile.conf"), "utf8");
}

// Roda um script do PowerShell como administrador (abre o UAC) e espera.
async function elevated(lines: string[]): Promise<void> {
  const script = file("tunel.ps1");
  fs.writeFileSync(script, lines.join("\r\n") + "\r\n");
  const ps =
    `try { Start-Process -FilePath powershell -Verb RunAs -Wait -WindowStyle Hidden ` +
    `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','"${script}"' } ` +
    `catch { Write-Output 'UAC_RECUSADO'; exit 3 }`;
  try {
    await execFileP("powershell", ["-NoProfile", "-Command", ps], { timeout: 180000 });
  } catch (e) {
    const out = (e as { stdout?: string }).stdout ?? "";
    throw new Error(/UAC_RECUSADO/.test(out) ? "pedido de administrador recusado" : String(e));
  }
}

const uninstallLine = `& '${WIREGUARD_EXE}' /uninstalltunnelservice ${TUNNEL_NAME}; Start-Sleep -Seconds 2`;

// SID do usuario do Windows (pra dar a ele o direito de reiniciar o tunel).
async function userSid(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP(WHOAMI_EXE, ["/user", "/fo", "csv", "/nh"], { timeout: 10000 });
    return /"(S-1-[\d-]+)"/.exec(stdout)?.[1];
  } catch {
    return undefined;
  }
}

// Linhas do script de administrador depois de instalar: (1) da ao usuario o
// direito de iniciar/parar so este servico (mesma regra do grantSddl), pro check
// de saude reiniciar sem UAC; (2) se o tunel nasceu mudo, reinicia uma vez.
function afterInstallLines(sid: string | undefined, probe: string): string[] {
  const svc = `'${WG_SERVICE}'`;
  const grant = sid
    ? [
        `$sd = ((& sc.exe sdshow ${svc}) -join '').Trim()`,
        `$ace = '(A;;RPWPLCRC;;;${sid})'`,
        `if (-not $sd.Contains(';;;${sid})')) { $i = $sd.IndexOf('S:'); if ($i -ge 0) { $sd = $sd.Insert($i, $ace) } else { $sd = $sd + $ace }; & sc.exe sdset ${svc} $sd | Out-Null }`,
      ]
    : [];
  return [
    ...grant,
    `$ok = $false; for ($n = 0; $n -lt 4 -and -not $ok; $n++) { Start-Sleep -Seconds 5; $ok = Test-Connection -Count 2 -Quiet ${probe} }`,
    `if (-not $ok) { Restart-Service -Name ${svc} -Force }`,
  ];
}

// Liga a rota pela VPN com os IPs dados (mais os fixos da versao do jogo
// escolhida). Reinstala se ja existir. Sem nenhum IP (Europa antes de o bot ver
// a conexao do jogo) nao monta tunel vazio.
export async function vpnEnable(ips: string[], log: Log, game: GameVersion): Promise<VpnStatus> {
  if (!fs.existsSync(WIREGUARD_EXE)) throw new Error("WireGuard nao instalado (https://www.wireguard.com/install)");
  const all = [...new Set([...seedIps(game), ...ips])].sort();
  if (!all.length) throw new Error(`${noProbeText(game)}; depois clique em Ligar VPN de novo`);
  fs.mkdirSync(dir, { recursive: true });
  const profile = await ensureProfile(log);
  // IP do teste do tunel depois de instalar: da mesma versao (all nunca esta vazio).
  const probe = probeIp(game, ips, { inTunnel: all, tunnelGame: game }) ?? all[0];
  const before = await serviceState();
  const current = (await vpnStatus()).ips;
  // Mesmos IPs e tunel instalado: nao reinstala (a reinstalacao deixou o tunel
  // mudo por 17 min); so libera o reinicio automatico e conserta se estiver mudo.
  if (before !== "missing" && all.length === current.length && all.every((ip) => current.includes(ip))) {
    log("o tunel ja tem esses IPs; liberando o reinicio automatico (aceite o pedido de administrador do Windows)...");
    // Mesmos IPs: so regrava a copia local com a marca da versao (o servico usa
    // a copia instalada, que nao muda), pro check de saude saber de quem e o tunel.
    fs.writeFileSync(confPath(), buildTunnelConf(profile, all, game));
    await elevated([`Start-Service -Name '${WG_SERVICE}'`, ...afterInstallLines(await userSid(), probe)]);
    const st = await vpnStatus();
    log(st.service === "running" ? "VPN ligada; reinicio automatico liberado." : "o tunel nao subiu");
    return st;
  }
  fs.writeFileSync(confPath(), buildTunnelConf(profile, all, game));
  log(`instalando o tunel (${all.length} IPs do jogo); aceite o pedido de administrador do Windows...`);
  await elevated([
    ...(before === "missing" ? [] : [uninstallLine]),
    `& '${WIREGUARD_EXE}' /installtunnelservice '${confPath()}'`,
    ...afterInstallLines(await userSid(), probe),
  ]);
  for (let i = 0; i < 10 && (await serviceState()) !== "running"; i++) await new Promise((r) => setTimeout(r, 1000));
  const st = await vpnStatus();
  if (st.service !== "running") throw new Error("o tunel nao subiu");
  log(`VPN ligada: ${st.ips.join(", ")}`);
  return st;
}

export async function vpnDisable(log: Log): Promise<VpnStatus> {
  if ((await serviceState()) === "missing") return vpnStatus();
  log("removendo o tunel; aceite o pedido de administrador do Windows...");
  await elevated([uninstallLine]);
  const st = await vpnStatus();
  log(st.service === "missing" ? "VPN desligada: o jogo volta pela rota direta." : "o tunel nao saiu");
  return st;
}

// IPs que o jogo esta usando agora (lidos dentro do emulador) e os fora do tunel.
export async function gameIps(serial: string): Promise<{ seen: string[]; missing: string[] }> {
  const sh = async (cmd: string) =>
    (await execFileP(adbBin(), ["-s", serial, "shell", cmd], { timeout: 15000 })).stdout.replace(/\r/g, "");
  const dump = await sh(`dumpsys package ${gamePkg()} | grep userId=`);
  const uid = Number(/userId=(\d+)/.exec(dump)?.[1]);
  if (!uid) return { seen: [], missing: [] };
  const seen = gameServerIps(await sh("cat /proc/net/tcp /proc/net/tcp6"), uid);
  return { seen, missing: missingIps((await vpnStatus()).ips, seen) };
}

async function pingOk(ip: string): Promise<boolean> {
  try {
    await execFileP("ping", ["-n", "2", "-w", "2000", ip], { timeout: 15000 });
    return true; // o ping do Windows sai com erro quando nada responde
  } catch {
    return false;
  }
}

async function sc(cmd: "start" | "stop"): Promise<boolean> {
  try {
    await execFileP("sc", [cmd, WG_SERVICE], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fallbackAt = 0; // quando o check desligou o tunel (rota direta)

// Check de saude: tunel ligado e mudo reinicia (sem UAC, com o direito dado na
// instalacao); continua mudo, desliga (o jogo vai pela rota direta) e tenta de
// novo depois. Sem internet nao mexe em nada.
let noProbeLogged = "";
// Ultimo IP vivo (conexao do jogo no tunel) visto por versao: com o tunel mudo a
// conexao do jogo cai e some do `seen`, mas o servidor continua o mesmo.
const lastLive: Partial<Record<GameVersion, string>> = {};

// `seen`: conexoes vivas do jogo da versao escolhida (gameIps). O IP de teste e
// dessa versao e esta no tunel (ver probeIp); sem nenhum, nao testa nem mexe no tunel.
export async function vpnHealth(log: Log, game: GameVersion, seen: string[]): Promise<void> {
  const st = await vpnStatus();
  if (st.service === "missing") return;
  const probe = probeIp(game, seen, { inTunnel: st.ips, tunnelGame: st.game, last: lastLive[game] });
  if (probe && seen.includes(probe)) lastLive[game] = probe;
  if (!probe) {
    // Avisa uma vez por versao (o check roda a cada 2 min).
    if (noProbeLogged !== game) log(`check do tunel da ${GAME_LABELS[game]} parado: ${noProbeText(game)}.`);
    noProbeLogged = game;
    return;
  }
  noProbeLogged = "";
  const tunnelOk = st.service === "running" && (await pingOk(probe));
  const internetOk = tunnelOk || (await pingOk("1.1.1.1"));
  const act = healthAction(st.service, tunnelOk, internetOk, fallbackAt, Date.now());
  if (act === "none") {
    if (tunnelOk) fallbackAt = 0;
    return;
  }
  log(act === "restart" ? `tunel mudo (o servidor de jogo ${probe} nao responde por ele); reiniciando...` : "tentando o tunel de novo...");
  if (st.service === "running" && !(await sc("stop"))) {
    log("sem permissao pra reiniciar o tunel: clique uma vez em Atualizar IPs (pede administrador) pra liberar.");
    return;
  }
  await sleep(3000);
  if (!(await sc("start"))) {
    log("o tunel nao subiu de novo; o jogo segue pela rota direta.");
    fallbackAt = Date.now();
    return;
  }
  await sleep(15000);
  if (await pingOk(probe)) {
    fallbackAt = 0;
    log("tunel de volta.");
    return;
  }
  await sc("stop");
  fallbackAt = Date.now();
  log("o tunel continua mudo: desligado por enquanto, o jogo vai pela rota direta. Nova tentativa em 15 min.");
}

// Latencia e perda ate o servidor de jogo (pelo PC: com a VPN ligada, pelo tunel).
export async function pingIp(ip: string): Promise<{ avgMs?: number; lossPct?: number }> {
  try {
    const { stdout } = await execFileP("ping", ["-n", "5", ip], { timeout: 30000 });
    return parsePing(stdout);
  } catch (e) {
    return parsePing((e as { stdout?: string }).stdout ?? "");
  }
}
