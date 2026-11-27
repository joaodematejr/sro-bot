import assert from "node:assert";
import { test } from "node:test";

import {
  buildTunnelConf,
  grantSddl,
  healthAction,
  HEALTH_RETRY_MS,
  gameServerIps,
  missingIps,
  noProbeText,
  parsePing,
  parseServiceState,
  probeIp,
  seedIps,
  tunnelGame,
  tunnelIps,
} from "../vpn";

// Perfil como o `wgcf generate` grava (chave de mentira).
const PROFILE = [
  "[Interface]",
  "PrivateKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  "Address = 172.16.0.2/32, 2606:4700:110:85c9::1/128",
  "DNS = 1.1.1.1, 1.0.0.1",
  "MTU = 1280",
  "[Peer]",
  "PublicKey = bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=",
  "AllowedIPs = 0.0.0.0/0, ::/0",
  "Endpoint = engage.cloudflareclient.com:2408",
].join("\n");

test("config do tunel: so os IPs do jogo, sem DNS, keepalive e endpoint fixo", () => {
  const conf = buildTunnelConf(PROFILE, ["54.169.246.199", "13.250.144.245", "54.169.246.199"]);
  assert.match(conf, /^AllowedIPs = 54\.169\.246\.199\/32, 13\.250\.144\.245\/32$/m);
  assert.match(conf, /^PersistentKeepalive = 15$/m);
  assert.match(conf, /^Endpoint = 162\.159\.192\.1:2408$/m);
  assert.doesNotMatch(conf, /DNS/);
  assert.doesNotMatch(conf, /0\.0\.0\.0\/0/);
  assert.match(conf, /PrivateKey = A+=/);
  assert.deepEqual(tunnelIps(conf), ["54.169.246.199", "13.250.144.245"]);
  assert.throws(() => buildTunnelConf("[Interface]\n", ["1.2.3.4"]));
});

test("IPs do jogo pelo /proc/net/tcp: so do uid, estabelecidos, fora de HTTP(S)", () => {
  // Linhas reais da SROTeste (uid 10060) em 2026-11-07, encurtadas.
  const tcp = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0F02000A:A1B2 C7F6A936:27E0 01 00000000:00000000 00:00000000 00000000 10060        0 1",
    "   1: 0F02000A:A1B3 28716F22:01BB 01 00000000:00000000 00:00000000 00000000 10060        0 2",
    "   2: 0F02000A:A1B4 F59032D0:61A9 06 00000000:00000000 00:00000000 00000000 10060        0 3",
    "   3: 0F02000A:A1B5 0100007F:6A21 01 00000000:00000000 00:00000000 00000000 10060        0 4",
    "   4: 0F02000A:A1B6 0A0B0C0D:27E0 01 00000000:00000000 00:00000000 00000000 10061        0 5",
    "   5: 0000000000000000FFFF00000F02000A:A1B7 0000000000000000FFFF0000F59032D0:61A9 01 00000000:00000000 00:00000000 00000000 10060 0 6",
  ].join("\n");
  // C7F6A936 = 54.169.246.199:10208; F59032D0 = 208.50.144.245 no tcp6 (25001).
  assert.deepEqual(gameServerIps(tcp, 10060), ["208.50.144.245", "54.169.246.199"]);
  assert.deepEqual(gameServerIps(tcp, 99999), []);
});

test("IPs fora do tunel", () => {
  assert.deepEqual(missingIps(["54.169.246.199"], ["54.169.246.199", "18.140.1.2"]), ["18.140.1.2"]);
  assert.deepEqual(missingIps([], []), []);
});

test("estado do servico pelo sc query", () => {
  assert.equal(parseServiceState("        STATE              : 4  RUNNING \n"), "running");
  assert.equal(parseServiceState("        STATE              : 1  STOPPED \n"), "stopped");
  // Windows em pt-BR (visto ao vivo): o TIPO tambem tem ": 10  WIN32..." e nao conta.
  const pt = "NOME_DO_SERVI�O: WireGuardTunnel$srobot \n    TIPO                       : 10  WIN32_OWN_PROCESS  \n" +
    "    ESTADO                     : 4  RUNNING \n";
  assert.equal(parseServiceState(pt), "running");
  assert.equal(parseServiceState("[SC] EnumQueryServicesStatus:OpenService FALHA 1060:"), "missing");
});

test("ping do Windows: media e perda, sem depender do idioma", () => {
  const pt = [
    "Resposta de 54.169.246.199: bytes=32 tempo=329ms TTL=48",
    "    Pacotes: Enviados = 5, Recebidos = 5, Perdidos = 0 (0% de",
    "    M�nimo = 329ms, M�ximo = 334ms, M�dia = 330ms",
  ].join("\n");
  assert.deepEqual(parsePing(pt), { lossPct: 0, avgMs: 330 });
  const en = "Packets: Sent = 5, Received = 4, Lost = 1 (20% loss),\n Minimum = 398ms, Maximum = 796ms, Average = 425ms";
  assert.deepEqual(parsePing(en), { lossPct: 20, avgMs: 425 });
  assert.deepEqual(parsePing("Packets: Sent = 5, Received = 0, Lost = 5 (100% loss),"), { lossPct: 100, avgMs: undefined });
});

test("permissao do servico: so start/stop/consulta pro usuario, antes da SACL", () => {
  // SDDL real do WireGuardTunnel$srobot (sem SACL).
  const sd = "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCLCSWLOCRRC;;;IU)";
  const sid = "S-1-5-21-111-222-333-1001";
  assert.equal(grantSddl(sd, sid), sd + "(A;;RPWPLCRC;;;S-1-5-21-111-222-333-1001)");
  assert.equal(grantSddl(grantSddl(sd, sid), sid), grantSddl(sd, sid)); // nao repete
  // Visto ao vivo: o Windows grava a regra como LCRPWPRC; nao duplica.
  const real = sd + "(A;;LCRPWPRC;;;S-1-5-21-111-222-333-1001)";
  assert.equal(grantSddl(real, sid), real);
  assert.equal(grantSddl("D:(A;;CC;;;SY)S:(AU;FA;CC;;;WD)", sid), "D:(A;;CC;;;SY)(A;;RPWPLCRC;;;S-1-5-21-111-222-333-1001)S:(AU;FA;CC;;;WD)");
  assert.throws(() => grantSddl(sd, "x;;;BA"));
});

test("saude do tunel: mudo reinicia, sem internet nao mexe, parado pelo check tenta de novo", () => {
  assert.equal(healthAction("running", true, true, 0, 0), "none");
  assert.equal(healthAction("running", false, true, 0, 0), "restart");
  assert.equal(healthAction("running", false, false, 0, 0), "none");
  assert.equal(healthAction("stopped", false, true, 1000, 1000 + HEALTH_RETRY_MS - 1), "none");
  assert.equal(healthAction("stopped", false, true, 1000, 1000 + HEALTH_RETRY_MS), "retry");
  assert.equal(healthAction("stopped", false, true, 0, 99e9), "none"); // parado por outro motivo
  assert.equal(healthAction("missing", false, true, 1, 99e9), "none");
});

test("IPs fixos por versao do jogo", () => {
  assert.deepEqual(seedIps("global"), ["13.250.144.245", "54.169.246.199"]);
  // Europa: nenhum IP conhecido antes de o servidor abrir.
  assert.deepEqual(seedIps("eu"), []);
});

test("IP do ping e do check do tunel: sempre da versao escolhida e nunca o center", () => {
  // Global sem jogo conectado: o servidor de jogo fixo (o center so atende no login).
  assert.equal(probeIp("global", []), "54.169.246.199");
  // Global conectado em outro servidor: a conexao viva vem primeiro.
  assert.equal(probeIp("global", ["13.250.144.245", "18.140.1.2"]), "18.140.1.2");
  // Europa sem jogo conectado: nenhum IP (nunca cai num IP da Global).
  assert.equal(probeIp("eu", []), undefined);
  assert.equal(probeIp("eu", [], { inTunnel: ["13.250.144.245", "54.169.246.199"] }), undefined);
  // Europa conectada: o IP que o jogo usa.
  assert.equal(probeIp("eu", ["3.120.0.10"]), "3.120.0.10");
  // Check do tunel: so IP que esta no tunel (fora dele o ping vai direto).
  assert.equal(probeIp("eu", ["3.120.0.10"], { inTunnel: ["54.169.246.199"] }), undefined);
  assert.equal(probeIp("eu", ["3.120.0.10", "3.120.0.11"], { inTunnel: ["3.120.0.11"] }), "3.120.0.11");
  // Global com o servidor fixo fora do tunel (ex.: tunel montado na Europa).
  assert.equal(probeIp("global", [], { inTunnel: ["3.120.0.10"] }), undefined);
  assert.equal(probeIp("global", ["18.140.1.2"], { inTunnel: ["13.250.144.245", "54.169.246.199"] }), "54.169.246.199");
  assert.match(noProbeText("eu"), /sem IP do servidor da Europa/);
});

test("tunel mudo na Europa: o check acha IP mesmo sem conexao viva do jogo", () => {
  // Achado da revisao (2026-11-27): com o WARP mudo a conexao do jogo cai (SYN_SENT,
  // fora do seen) e a Europa nao tem IP fixo. O tunel montado pela Europa so tem IP dela.
  const tun = ["3.120.0.10", "3.120.0.11"];
  assert.equal(probeIp("eu", [], { inTunnel: tun, tunnelGame: "eu" }), "3.120.0.10");
  // O ultimo IP vivo visto vem antes dos outros do tunel.
  assert.equal(probeIp("eu", [], { inTunnel: tun, tunnelGame: "eu", last: "3.120.0.11" }), "3.120.0.11");
  // Ultimo IP que saiu do tunel nao vale.
  assert.equal(probeIp("eu", [], { inTunnel: ["3.120.0.10"], tunnelGame: "eu", last: "3.120.0.11" }), "3.120.0.10");
  // Conexao viva continua primeiro.
  assert.equal(probeIp("eu", ["3.120.0.11"], { inTunnel: tun, tunnelGame: "eu", last: "3.120.0.10" }), "3.120.0.11");
  // Tunel montado pela Global (ou conf antigo, sem marca): nunca testa a Europa por ele.
  assert.equal(probeIp("eu", [], { inTunnel: ["13.250.144.245", "54.169.246.199"], tunnelGame: "global" }), undefined);
  assert.equal(probeIp("eu", [], { inTunnel: ["18.140.1.2"] }), undefined);
  // Global com o fixo fora do tunel marcado: cai num IP do tunel dela, nunca no center.
  assert.equal(probeIp("global", [], { inTunnel: ["13.250.144.245", "18.140.1.2"], tunnelGame: "global" }), "18.140.1.2");
});

test("marca da versao no conf do tunel", () => {
  const conf = buildTunnelConf(PROFILE, ["3.120.0.10"], "eu");
  assert.ok(conf.startsWith("# sro-bot jogo=eu"));
  assert.equal(tunnelGame(conf), "eu");
  assert.deepEqual(tunnelIps(conf), ["3.120.0.10"]);
  assert.equal(tunnelGame(buildTunnelConf(PROFILE, ["54.169.246.199"], "global")), "global");
  // Conf antigo (sem marca).
  assert.equal(tunnelGame(buildTunnelConf(PROFILE, ["54.169.246.199"])), undefined);
});
