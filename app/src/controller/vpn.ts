// Rota do jogo por VPN gratuita: WireGuard (open source) com a conta gratuita
// do Cloudflare WARP gerada pelo wgcf (open source, MIT). Logica pura; o main
// baixa, registra, instala o servico e le os IPs do jogo.
//
// Tunel dividido: so os IPs do jogo (center SEA e servidor de jogo) entram no
// tunel. O resto do PC segue pela rota normal e o DNS nao muda.
//
// Visto em 2026-11-07: a rota direta Brasil-Asia oscilava de 400 para ~785 ms
// com perda em rajada (PC e emulador juntos) e o jogo caia a cada 3 a 6 min.
// Pelo WARP o servidor de jogo respondeu em 330 ms.

import { GAME_LABELS, type GameVersion } from "./settings";

export const TUNNEL_NAME = "srobot";
export const WG_SERVICE = `WireGuardTunnel$${TUNNEL_NAME}`;

export const WGCF_VERSION = "2.3.1";
export const WGCF_URL = `https://github.com/ViRb3/wgcf/releases/download/v${WGCF_VERSION}/wgcf_${WGCF_VERSION}_windows_amd64.exe`;
// checksums.txt da release v2.3.1.
export const WGCF_SHA256 = "e222fd9443d7cb3264d825a3e86967797fc9c938507c5d93e3cc21e4aed11dcc";

// engage.cloudflareclient.com: o IP fixo evita depender do DNS na subida do tunel.
export const WARP_ENDPOINT = "162.159.192.1:2408";

// IPs fixos por versao do jogo: entram no tunel sempre que ele e ligado com essa
// versao na configuracao. Os outros servidores entram quando o bot ve a conexao
// do jogo ("Atualizar IPs").
//   Global: center SEA (seacenter.n52srom.com, so atende no login) e o servidor
//           de jogo do servidor principal.
//   Europa: nenhum IP conhecido ate o servidor abrir (2026-11-30); os IPs vem da
//           conexao do jogo.
export const GAME_SEEDS: Record<GameVersion, { center?: string; seeds: string[] }> = {
  global: { center: "13.250.144.245", seeds: ["13.250.144.245", "54.169.246.199"] },
  eu: { seeds: [] },
};

export function seedIps(g: GameVersion): string[] {
  return GAME_SEEDS[g].seeds;
}

export interface ProbeOpts {
  inTunnel?: string[]; // so IPs no tunel (fora dele o ping vai direto e nao testa o tunel)
  tunnelGame?: GameVersion; // versao que montou o tunel (marca no conf)
  last?: string; // ultimo IP vivo visto dessa versao
}

// IP pra medir o caminho ate o servidor de jogo da versao escolhida (botao de
// ping e check de saude), nunca o center e nunca um IP de outra versao. Ordem:
// conexao viva do jogo; o ultimo IP vivo visto; um fixo da versao; e, com o
// tunel montado pela MESMA versao, um IP do tunel (o "Ligar VPN" so poe IPs da
// versao escolhida). O ultimo caso e o do tunel mudo na Europa: a conexao do
// jogo cai (fica em SYN_SENT, fora do `seen`) e a Europa nao tem IP fixo.
export function probeIp(g: GameVersion, seen: string[], o: ProbeOpts = {}): string | undefined {
  const center = GAME_SEEDS[g].center;
  const ok = (ip: string) => ip !== center && (!o.inTunnel || o.inTunnel.includes(ip));
  return (
    seen.find(ok) ??
    (o.last && ok(o.last) ? o.last : undefined) ??
    GAME_SEEDS[g].seeds.find(ok) ??
    (o.inTunnel && o.tunnelGame === g ? o.inTunnel.find(ok) : undefined)
  );
}

// Por que nao ha IP de teste (pro log e pra tela).
export function noProbeText(g: GameVersion): string {
  return `sem IP do servidor da ${GAME_LABELS[g]} ainda: entre no jogo (conectado ao servidor) pra o bot ver a conexao`;
}

// Conexao do jogo que nao e do jogo: CDN, anuncio, SDK (HTTP e HTTPS).
const NON_GAME_PORTS = new Set([80, 443]);

export type ServiceState = "running" | "stopped" | "missing";

// Saida do `sc query <servico>`: "STATE : 4  RUNNING" (em pt-BR, "ESTADO"). So
// o codigo do estado e igual em todo idioma.
export function parseServiceState(out: string): ServiceState {
  const m = /:\s*\d+\s+(RUNNING|START_PENDING|STOPPED|STOP_PENDING|PAUSED|PAUSE_PENDING|CONTINUE_PENDING)\b/.exec(out);
  if (!m) return "missing";
  return m[1] === "RUNNING" || m[1] === "START_PENDING" ? "running" : "stopped";
}

function isPrivate(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// IPv4 do /proc/net/tcp: 8 hex em ordem little endian ("C7F6A936" = 54.169.246.199).
// No tcp6 o IPv4 vem mapeado: 0000000000000000FFFF0000 + os mesmos 8 hex.
function hexToIpv4(hex: string): string | undefined {
  const h = hex.length === 32 && /^0{16}FFFF0{4}/i.test(hex) ? hex.slice(24) : hex;
  if (!/^[0-9a-f]{8}$/i.test(h)) return undefined;
  const bytes = [6, 4, 2, 0].map((i) => parseInt(h.slice(i, i + 2), 16));
  return bytes.join(".");
}

// IPs remotos do jogo com conexao estabelecida (estado 01), pelo uid do app.
export function gameServerIps(procNetTcp: string, uid: number): string[] {
  const ips = new Set<string>();
  for (const line of procNetTcp.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || f[3] !== "01" || Number(f[7]) !== uid) continue;
    const [hex, portHex] = f[2].split(":");
    const ip = hex && hexToIpv4(hex);
    if (!ip || isPrivate(ip) || NON_GAME_PORTS.has(parseInt(portHex, 16))) continue;
    ips.add(ip);
  }
  return [...ips].sort();
}

// Marca da versao do jogo que montou o tunel, gravada como comentario no conf
// (o WireGuard ignora linha com #). Conf antigo, sem marca: undefined.
const GAME_MARK = /^#\s*sro-bot jogo=(global|eu)\s*$/m;

export function tunnelGame(conf: string): GameVersion | undefined {
  return GAME_MARK.exec(conf)?.[1] as GameVersion | undefined;
}

// AllowedIPs do tunel ja instalado.
export function tunnelIps(conf: string): string[] {
  const m = /^AllowedIPs\s*=\s*(.+)$/m.exec(conf);
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim().replace(/\/32$/, "")).filter(Boolean);
}

// IPs do jogo que estao fora do tunel.
export function missingIps(tunnel: string[], seen: string[]): string[] {
  const have = new Set(tunnel);
  return seen.filter((ip) => !have.has(ip));
}

// Config do tunel a partir do perfil do wgcf: sem DNS (nao mexe no PC), so os
// IPs do jogo, keepalive (a conexao parada nao expira no NAT) e endpoint fixo.
export function buildTunnelConf(profile: string, ips: string[], game?: GameVersion): string {
  if (!/PrivateKey\s*=/.test(profile) || !/PublicKey\s*=/.test(profile)) throw new Error("perfil do wgcf invalido");
  const allowed = [...new Set(ips)].map((ip) => `${ip}/32`).join(", ");
  const out: string[] = game ? [`# sro-bot jogo=${game}`] : [];
  for (const line of profile.replace(/\r/g, "").split("\n")) {
    if (/^DNS\s*=/.test(line) || /^PersistentKeepalive\s*=/.test(line)) continue;
    if (/^AllowedIPs\s*=/.test(line)) {
      out.push(`AllowedIPs = ${allowed}`, "PersistentKeepalive = 15");
    } else if (/^Endpoint\s*=/.test(line)) {
      out.push(`Endpoint = ${WARP_ENDPOINT}`);
    } else {
      out.push(line);
    }
  }
  return out.join("\r\n").trim() + "\r\n";
}

// Permissao pro usuario iniciar, parar e consultar so o servico do tunel (sem
// UAC a cada reinicio): ACE "(A;;RPWPLCRC;;;<SID>)" na DACL, antes da SACL.
export function grantSddl(sddl: string, sid: string): string {
  const s = sddl.trim();
  if (!/^S-1-[\d-]+$/.test(sid)) throw new Error("SID invalido");
  const ace = `(A;;RPWPLCRC;;;${sid})`;
  // O Windows reordena os direitos (RPWPLCRC vira LCRPWPRC): confere pelo SID.
  if (s.includes(`;;;${sid})`)) return s;
  const sacl = s.indexOf("S:");
  return sacl >= 0 ? s.slice(0, sacl) + ace + s.slice(sacl) : s + ace;
}

// Tunel "ligado mas mudo" (visto em 2026-11-07: depois de reinstalar, o WARP nao
// fechou o handshake por 17 min; reiniciar o servico resolveu na hora).
export const HEALTH_RETRY_MS = 15 * 60 * 1000;
export type HealthAction = "none" | "restart" | "retry";

export function healthAction(
  service: ServiceState,
  tunnelOk: boolean,
  internetOk: boolean,
  fallbackAt: number,
  now: number,
): HealthAction {
  if (service === "running") return tunnelOk || !internetOk ? "none" : "restart";
  // Parado pelo proprio check (rota direta): tenta de novo de tempos em tempos.
  if (service === "stopped" && fallbackAt > 0 && now - fallbackAt >= HEALTH_RETRY_MS) return "retry";
  return "none";
}

// Saida do `ping -n N ip` do Windows: perda no "(N% ...)" e a media e o ultimo
// "= Nms" do resumo. Nao depende do idioma (o acento vem quebrado no cp850).
export function parsePing(out: string): { avgMs?: number; lossPct?: number } {
  const loss = /\((\d+)%/.exec(out);
  const ms = [...out.matchAll(/=\s*(\d+)\s*ms/g)];
  const summary = /(\d+)%/.test(out) && ms.length ? ms[ms.length - 1] : undefined;
  return {
    lossPct: loss ? Number(loss[1]) : undefined,
    avgMs: summary ? Number(summary[1]) : undefined,
  };
}
