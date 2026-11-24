// Missoes do XTaskDocument: o que o Firm e a missao principal tem em comum.
// Leitura da lista de missoes, os comandos DoTask/OperateTask, a viagem ate o NPC
// (ir, confirmar a viagem paga, chegar) e a guarda pra parar a caca so com o char
// seguro. Logica pura e leituras; ver DISCOVERY.md, secoes "Firm" e "Missao principal".

import type { EngineQuery } from "./tower";

// KKSG.TaskStatus
export const TASK_CAN_TAKE = 1;
export const TASK_TAKEN = 2;
export const TASK_FINISH = 3;
export const TASK_OVER = 4;
// KKSG.TaskOPEnum
export const TASK_OP_TAKE = 1;
export const TASK_OP_DONE = 2;
export const TASK_OP_FINISH = 3;
// XTaskType
export const TASK_TYPE_MAIN = 1;

export const TASK_LIST = "XTaskDocument get_TaskRecord m_TaskList";

// Ir ate o NPC/objetivo da missao pelo proprio jogo (o mesmo do clique na missao).
export function doTaskBody(id: number): string {
  return `callsi XTaskDocument DoTask 2 ${Math.floor(id)} 1`;
}

export function operateTaskBody(id: number, op: number): string {
  return `callsi XTaskDocument OperateTask 2 ${Math.floor(id)} ${Math.floor(op)}`;
}

async function readInt(q: EngineQuery, body: string, dflt = -1): Promise<number> {
  const r = await q("GETP", body);
  return r.ok === true && typeof r.int === "number" ? r.int : dflt;
}

// m_Status da missao `id` na lista (-1 = nao esta la).
export async function findTaskStatus(q: EngineQuery, id: number, max = 32): Promise<number> {
  const n = Math.min(await readInt(q, `${TASK_LIST} get_Count`, 0), max);
  for (let i = 0; i < n; i++) {
    if ((await readInt(q, `${TASK_LIST} get_Item:${i} m_ID`)) === id) return readInt(q, `${TASK_LIST} get_Item:${i} m_Status`);
  }
  return -1;
}

export async function readNavigating(q: EngineQuery): Promise<boolean> {
  return (await q("GETP", "XTaskDocument get_IsNavigating")).bool === true;
}

// ---- Viagem ate o NPC/objetivo ----

export interface TravelProgress {
  gotoSentAt: number;
  teleports: number; // confirmacoes de viagem mandadas
  teleportAt: number;
  arrivedAt: number; // primeira leitura na cena do destino depois do "ir" (0 = ainda nao)
  lastPos?: number[];
  movedAt: number; // ultima leitura em que o char andou (0 = nunca)
}

export function newTravel(): TravelProgress {
  return { gotoSentAt: 0, teleports: 0, teleportAt: 0, arrivedAt: 0, movedAt: 0 };
}

export interface TravelSnapshot {
  scene: number;
  navigating: boolean; // o jogo esta levando o char pela missao
  pos?: number[]; // CONN corrected [x, altura, z]
}

// Textos da viagem: dest "o Leebaek", at "no Leebaek", map "Jangan", toMap "a Jangan".
export interface TravelLabels {
  dest: string;
  at: string;
  map: string;
  toMap: string;
}

export const GOTO_MAX_MS = 5 * 60 * 1000;
// Depois de chegar na cena o char ainda anda ate o NPC (o IsNavigating ficou falso
// nesse trecho ao vivo no Firm): espera antes de agir.
export const ARRIVE_SETTLE_MS = 10000;
// O DoTask fora da cena abre o mapa com a viagem e nao anda: confirma depois disso.
export const TELEPORT_AFTER_MS = 6000;
export const TELEPORT_COOLDOWN_MS = 15000;
export const MAX_TELEPORTS = 2;
// Longe da borda o jogo anda ate ela (TeleportDocument.HandleTeleportWithGate) com
// o IsNavigating falso. Andando (mais que MOVE_MIN_M desde a ultima leitura, ha
// menos de MOVE_GRACE_MS), conta como viagem em curso (Firm, 2026-11-09 18:01).
export const MOVE_MIN_M = 2;
export const MOVE_GRACE_MS = 8000;
export const TELEPORT_BODY = "callsn MiniMapView OnClickButtonInternationalMapTeleport 1";

const inScene = (scene: number, target: number) => target <= 0 || scene === target;

// Acompanha posicao e chegada. targetScene <= 0 = qualquer cena serve.
export function trackTravel<T extends TravelProgress>(p: T, s: TravelSnapshot | null, now: number, targetScene: number): T {
  if (s?.pos && p.gotoSentAt > 0) {
    const moved = p.lastPos !== undefined && Math.hypot(s.pos[0] - p.lastPos[0], s.pos[2] - p.lastPos[2]) > MOVE_MIN_M;
    p = { ...p, lastPos: s.pos, movedAt: moved ? now : p.movedAt };
  }
  if (!s || p.gotoSentAt === 0 || p.arrivedAt !== 0 || !inScene(s.scene, targetScene)) return p;
  return { ...p, arrivedAt: now };
}

export type TravelOutcome =
  | { kind: "wait"; reason: string }
  | { kind: "fail"; reason: string }
  | { kind: "teleport"; name: string; body: string }
  | { kind: "arrived" };

// Depois do "ir" (gotoSentAt > 0): espera, confirma a viagem paga ou declara chegada.
export function travelStep(s: TravelSnapshot, targetScene: number, p: TravelProgress, allowTeleport: boolean, now: number, lb: TravelLabels): TravelOutcome {
  if (now - p.gotoSentAt >= GOTO_MAX_MS) return { kind: "fail", reason: `nao chegou ate ${lb.dest}` };
  if (s.navigating) return { kind: "wait", reason: `indo ate ${lb.dest}` };
  const away = !inScene(s.scene, targetScene);
  if (away && p.movedAt > p.gotoSentAt && now - p.movedAt < MOVE_GRACE_MS)
    return { kind: "wait", reason: `andando ate a borda do mapa pra viajar ${lb.toMap}` };
  if (away) {
    if (now - p.gotoSentAt < TELEPORT_AFTER_MS || (p.teleportAt > 0 && now - p.teleportAt < TELEPORT_COOLDOWN_MS))
      return { kind: "wait", reason: "esperando a viagem" };
    if (p.teleports >= MAX_TELEPORTS) return { kind: "fail", reason: `a viagem ate ${lb.map} nao saiu` };
    if (!allowTeleport) return { kind: "fail", reason: `precisa viajar ate ${lb.map} e a viagem paga esta desligada` };
    return { kind: "teleport", name: `confirmar a viagem ate ${lb.dest} (gold)`, body: TELEPORT_BODY };
  }
  if (p.arrivedAt === 0 || now - p.arrivedAt < ARRIVE_SETTLE_MS) return { kind: "wait", reason: `chegando ${lb.at}` };
  return { kind: "arrived" };
}

export function afterTeleport<T extends TravelProgress>(p: T, now: number): T {
  return { ...p, teleports: p.teleports + 1, teleportAt: now };
}

// ---- Parar a caca so com o char seguro ----

// Parar a caca so fora de combate e sem monstro perto (a regra do "Parar bot",
// safeToStopHunt). Em 2026-11-07 21:00 o Firm desligou a caca em combate pra viajar
// e o char ficou ~40 s parado entre monstros. Esperando, a caca segue ligada;
// passou disso, a atividade fica pra depois.
export const UNSAFE_MAX_MS = 60 * 1000;
// Atacado no caminho com a caca desligada e HP abaixo disso: religa e desiste
// (mesma regra da ida pra cidade do Treino).
export const DEFEND_HP_PCT = 60;

export function trackUnsafe<T extends { unsafeSince: number }>(p: T, safeToLeave: boolean | undefined, now: number): T {
  if (safeToLeave === false && p.unsafeSince === 0) return { ...p, unsafeSince: now };
  if (safeToLeave !== false && p.unsafeSince !== 0) return { ...p, unsafeSince: 0 };
  return p;
}

// Null = pode parar a caca agora. `who` entra na mensagem ("Firm", "a missao principal").
export function stopHuntBlock(safeToLeave: boolean | undefined, unsafeSince: number, now: number, who: string): { kind: "wait" | "fail"; reason: string } | null {
  if (safeToLeave !== false) return null;
  if (unsafeSince > 0 && now - unsafeSince >= UNSAFE_MAX_MS)
    return { kind: "fail", reason: `em combate ou com monstro perto ha 1 min; ${who} fica pra depois (caca segue ligada)` };
  return { kind: "wait", reason: "esperando o char ficar seguro (fora de combate, HP alto, sem monstro perto) pra parar a caca" };
}

export function mustDefend(huntOff: boolean, inCombat: boolean | undefined, hpPct: number | undefined): boolean {
  return huntOff && inCombat === true && hpPct !== undefined && hpPct < DEFEND_HP_PCT;
}
