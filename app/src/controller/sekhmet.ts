// Sekhmet War (World Boss) 100% por metodo e guiado por estado. Logica pura, sem
// IO; o main faz as leituras e manda os comandos.
//
// Ideia e primeiro mapeamento de um contribuidor (patch da 0.154.0, visto ao vivo
// por ele em 2026-11-17 e 18). Conferido no XMainClient.dll descompilado e ao vivo
// (so leitura, evento fechado) em 2026-11-19:
//   Aberto       -> XActivityDocument IsMulActivityOpening(XSys_Activity_WorldBoss 524):
//                   verdadeiro com a atividade em Open ou Prepare. O estado e um cache
//                   que o jogo so renova com a tela de atividades aberta; sem pedir
//                   (SendQueryGetMulActInfo) ele fica no "vai abrir" do login.
//                   Horario: todo dia 20:30 a 21:00 do servidor (UTC+8).
//   Arena        -> XScene get_SceneID == XGlobalConfig WorldBossSceneID (2200).
//   Entrar       -> XWorldBossDocument ReqEnterWorldBossScene (ReqEnterScene da
//                   cena 2200; o proprio metodo segura 1 s entre pedidos).
//   Buff         -> ReqEncourage (AddTempAttr type 0) e o botao de gold, custo
//                   XGlobalConfig WorldBossConsume (20.000). ReqEncourageTwo e o da
//                   guilda/Silk: nunca. Conta em _EncourageCount.
//   Fim          -> isEnd (o jogo zera ao entrar na arena e liga no fim, junto com
//                   o resultado; nunca o isWin, que fica da vitoria anterior). Sair =
//                   ReqQutiScene (o nome e do jogo), o mesmo do "continuar" da tela
//                   de resultado (XWorldBossResultView OnContinueClick).
//   Dados        -> ReqBattleInfo pede a vida do boss e o ranking da luta.

import type { EngineQuery } from "./tower";
import { LEAVE_TEAM_BODY } from "./guildboss";

export const SEKHMET_SCENE = 2200;
export const SYS_WORLD_BOSS = 524;

export const ENTER_SEKHMET_BODY = "calls XWorldBossDocument ReqEnterWorldBossScene 0";
export const ENCOURAGE_GOLD_BODY = "calls XWorldBossDocument ReqEncourage 0";
export const EXIT_SEKHMET_BODY = "calls XWorldBossDocument ReqQutiScene 0";
export const BATTLE_INFO_BODY = "calls XWorldBossDocument ReqBattleInfo 0";
export const REFRESH_ACTIVITIES_BODY = "calls XActivityDocument SendQueryGetMulActInfo 0";
// Pedido da lista de atividades ao servidor, no maximo 1 por minuto; perto do
// horario da Sekhmet (1 min antes ate o fim), a cada 5 s pra entrar logo.
export const REFRESH_ACTIVITIES_MS = 60_000;
export const REFRESH_ACTIVITIES_FAST_MS = 5_000;
export const SERVER_TZ_DEFAULT = 8;

// Minuto do dia no fuso do servidor esta em [inicio - 1, fim)? beginmin/endmin da
// lista sao minutos do dia no fuso do servidor (1230 = 20:30).
export function inActivityWindow(nowMs: number, tzHours: number, beginMin: number, endMin: number): boolean {
  if (!(endMin > beginMin)) return false;
  const m = (((Math.floor(nowMs / 60_000) + tzHours * 60) % 1440) + 1440) % 1440;
  return m >= beginMin - 1 && m < endMin;
}
export const HUNT_ON_BODY = '{"on":1}';
export { LEAVE_TEAM_BODY };

export const ENTER_RETRY_MS = 10_000;
export const ENTER_MAX_TRIES = 6;
export const EXIT_RETRY_MS = 10_000;
export const EXIT_MAX_TRIES = 6;
export const BUFF_RETRY_MS = 3_000;
// Pedidos sem a conta subir (gold acabou, servidor recusou): desiste.
export const BUFF_EXTRA_TRIES = 3;
// Limite de buffs aceito na config (o jogo recusa acima do dele).
export const BUFF_MAX = 10;

export interface SekhmetConfig {
  buffs?: number; // buffs de ataque por gold (0 = nenhum; padrao 0)
  autoFight?: boolean; // liga o auto-play dentro da arena (ligado se ausente)
}

export interface SekhmetSnapshot {
  inWorld: boolean;
  sceneId: number;
  inBossScene: boolean;
  open: boolean;
  inTeam: boolean;
  isEnd: boolean;
  bossHp?: number;
  encourageCount?: number;
  dead: boolean;
  autoPlay: boolean;
}

export interface SekhmetMemory {
  enterTries: number;
  lastEnterAt: number;
  leftTeam: boolean;
  buffTries: number;
  lastBuffAt: number;
  exitTries: number;
  lastExitAt: number;
}

export function newSekhmetMemory(): SekhmetMemory {
  return {
    enterTries: 0,
    lastEnterAt: -Infinity,
    leftTeam: false,
    buffTries: 0,
    lastBuffAt: -Infinity,
    exitTries: 0,
    lastExitAt: -Infinity,
  };
}

export type SekhmetStep =
  | { kind: "done"; reason: string }
  | { kind: "wait"; reason: string }
  | { kind: "act"; id: string; name: string; tag: string; body: string }
  | { kind: "fail"; reason: string }
  | { kind: "closed"; reason: string }; // evento fechado: nada a fazer agora (nem sair da party)

export function nextSekhmetStep(s: SekhmetSnapshot | null, cfg: SekhmetConfig, m: SekhmetMemory, now: number): SekhmetStep {
  if (!s) return { kind: "fail", reason: "engine fora" };
  if (!s.inWorld) return { kind: "wait", reason: "aguardando char entrar em mundo..." };

  if (s.inBossScene) {
    if (s.isEnd) {
      if (m.exitTries >= EXIT_MAX_TRIES) return { kind: "fail", reason: `nao saiu da arena depois de ${m.exitTries} pedidos` };
      if (now - m.lastExitAt < EXIT_RETRY_MS) return { kind: "wait", reason: "saindo da arena da Sekhmet War..." };
      return { kind: "act", id: "exit", name: "fim da Sekhmet War: saindo da arena", tag: "SKIL", body: EXIT_SEKHMET_BODY };
    }
    if (s.dead) return { kind: "wait", reason: "char abatido na arena da Sekhmet War; aguardando..." };
    if (cfg.autoFight !== false && !s.autoPlay)
      return { kind: "act", id: "hunt-on", name: "ligando o auto-play contra a Sekhmet", tag: "SKIL", body: HUNT_ON_BODY };
    const buff = buffStep(s, cfg, m, now);
    if (buff) return buff;
    return { kind: "wait", reason: "em batalha contra a Sekhmet..." };
  }

  // A saida da arena (fim da luta) quem ve e o main, com 2 leituras seguidas.
  if (!s.open) return { kind: "closed", reason: "Sekhmet War fechada agora" };

  if (s.inTeam) {
    if (!m.leftTeam)
      return { kind: "act", id: "leave-team", name: "saindo da party (a Sekhmet War e sozinha)", tag: "SKIL", body: LEAVE_TEAM_BODY };
    return { kind: "wait", reason: "esperando sair da party..." };
  }
  if (now - m.lastEnterAt < ENTER_RETRY_MS) return { kind: "wait", reason: "aguardando entrada na arena..." };
  if (m.enterTries >= ENTER_MAX_TRIES) return { kind: "fail", reason: `nao entrou na arena depois de ${m.enterTries} pedidos` };
  return {
    kind: "act",
    id: "enter",
    name: `entrando na arena da Sekhmet War${m.enterTries ? ` (tentativa ${m.enterTries + 1})` : ""}`,
    tag: "SKIL",
    body: ENTER_SEKHMET_BODY,
  };
}

export function buffStep(s: SekhmetSnapshot, cfg: SekhmetConfig, m: SekhmetMemory, now: number): SekhmetStep | null {
  const want = Math.min(Math.max(0, Math.floor(cfg.buffs ?? 0)), BUFF_MAX);
  if (want <= 0 || s.encourageCount === undefined || s.encourageCount >= want) return null;
  if (now - m.lastBuffAt < BUFF_RETRY_MS || m.buffTries >= want + BUFF_EXTRA_TRIES) return null;
  return {
    kind: "act", id: "buff", tag: "SKIL", body: ENCOURAGE_GOLD_BODY,
    name: `comprando buff de ataque por gold (${s.encourageCount + 1}/${want})`,
  };
}

export function afterSekhmetStep(m: SekhmetMemory, step: SekhmetStep, now: number): SekhmetMemory {
  if (step.kind !== "act") return m;
  if (step.id === "enter") return { ...m, enterTries: m.enterTries + 1, lastEnterAt: now };
  if (step.id === "leave-team") return { ...m, leftTeam: true };
  if (step.id === "buff") return { ...m, buffTries: m.buffTries + 1, lastBuffAt: now };
  if (step.id === "exit") return { ...m, exitTries: m.exitTries + 1, lastExitAt: now };
  return m;
}

const num = (r: Record<string, unknown>): number | undefined => (r.ok === true && typeof r.int === "number" ? r.int : undefined);

let lastRefreshAt = -Infinity;

// Pede ao servidor o estado atual das atividades (a resposta chega depois e vale
// pra proxima leitura).
export async function refreshActivities(q: EngineQuery, now = Date.now()): Promise<void> {
  const since = now - lastRefreshAt;
  if (since < REFRESH_ACTIVITIES_FAST_MS) return;
  if (since < REFRESH_ACTIVITIES_MS && !(await nearSekhmetTime(q, now))) return;
  lastRefreshAt = now;
  await q("SKIL", REFRESH_ACTIVITIES_BODY);
}

async function nearSekhmetTime(q: EngineQuery, now: number): Promise<boolean> {
  const info = `XActivityDocument GetMulActivityInfoBySystem:${SYS_WORLD_BOSS}`;
  const begin = num(await q("GETP", `${info} startTime`));
  const end = num(await q("GETP", `${info} endTime`));
  if (begin === undefined || end === undefined) return false;
  const tz = num(await q("GETP", "XServerTimeMgr _serverTimeZone")) ?? SERVER_TZ_DEFAULT;
  return inActivityWindow(now, tz, begin, end);
}

export async function sekhmetOpenNow(q: EngineQuery, now = Date.now()): Promise<boolean> {
  if (await inSekhmetArena(q)) return true;
  await refreshActivities(q, now).catch(() => undefined);
  return (await q("GETP", `XActivityDocument IsMulActivityOpening:${SYS_WORLD_BOSS}`)).bool === true;
}

// Char na arena da Sekhmet War (o Treino nao religa aqui dentro).
export async function inSekhmetArena(q: EngineQuery): Promise<boolean> {
  return num(await q("GETP", "XScene get_SceneID")) === SEKHMET_SCENE;
}

export async function readSekhmetSnapshot(q: EngineQuery): Promise<SekhmetSnapshot | null> {
  const conn = await q("CONN", "");
  const player = conn.player as Record<string, unknown> | undefined;
  if (!player) return null;
  const inWorld = player.ok === true;
  const sceneId = num(await q("GETP", "XScene get_SceneID")) ?? -1;
  const inBossScene = sceneId === SEKHMET_SCENE;
  const DOC = "XWorldBossDocument";
  return {
    inWorld,
    sceneId,
    inBossScene,
    open: inBossScene || (await q("GETP", `XActivityDocument IsMulActivityOpening:${SYS_WORLD_BOSS}`)).bool === true,
    inTeam: !inBossScene && (await q("GETP", "XTeamDocument get_bInTeam")).bool === true,
    isEnd: inBossScene && (await q("GETP", `${DOC} isEnd`)).bool === true,
    bossHp: inBossScene ? num(await q("GETP", `${DOC} _BossHP`)) : undefined,
    encourageCount: inBossScene ? num(await q("GETP", `${DOC} _EncourageCount`)) : undefined,
    dead: player.dead === true,
    autoPlay: player.autoPlayOn === true,
  };
}
