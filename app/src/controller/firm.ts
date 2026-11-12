// Firm (tarefa diaria de guilda, interno GuildDailyTask) 100% por metodo:
// aceita a missao no Leebaek, entrega o que tem no inventario e pede ajuda a
// guilda no resto. Logica pura; quem chama faz as leituras com readFirmSnapshot.
//
// Mapeado ao vivo no char principal (2026-11-06; ver DISCOVERY.md, secao "Firm"):
//   Missao      -> XTaskDocument get_TaskRecord m_TaskList (XTaskInfo m_ID 2222,
//                  m_Status: 1 CanTake, 2 Taked). Ir ao NPC = DoTask(2222, 1); em
//                  outro mapa abre a viagem (1500 gold), confirmada por
//                  MiniMapView.OnClickButtonInternationalMapTeleport. Aceitar =
//                  OperateTask(2222, 1), que cria as 6 tarefas.
//   Tarefas     -> XGuildDailyTaskDocument _curGuildDailyTaskList (taskID,
//                  isRewarded, hasAsked); entregues = isRewarded (o _count caiu de
//                  1 pra 0 ao entregar, nao conta entregas); _askedNum.
//   Item        -> GetDailyTaskTableInfoByID:<id> conditionId [#0] / conditionNum;
//                  estoque XBagDocument GetItemCount:<item>,0; qualidade
//                  GetItemConf:<item> ItemQuality (o nome nao traduz).
//   Entregar    -> SendToGetMyTaskReward(1, taskID, 0): +3.749.251 EXP provado.
//   Ajuda       -> SendDailyTaskAskHelp(1, taskID) (3 por dia; nao exercitado).
//   Concluir    -> o "Submit" da janela (XGuildDailyTaskView.OnConfirmToSubmit):
//                  SendToGetMyTaskReward(2, 0, useItemPass), premio total do dia por
//                  numero de entregas, com EXP (item 4); libera com
//                  DailyTaskMinTotalTaskCount (3) entregues; get_IsRewarded = ja pego.
//                  Medido em 2026-11-10: cada entrega da ~3,75 a 4,3 M de EXP e o
//                  premio total ~5,5 M. useItemPass sempre 0.
// Nunca: "Instant Quest Completion" (item) nem trocar as tarefas (pode ser Silk).

import type { EngineQuery } from "./tower";
import { hpPercent, readEnemiesAround, safeToStopHunt } from "./train";

export const FIRM_QUEST_ID = 2222;
export const QUEST_CAN_TAKE = 1;
export const QUEST_TAKEN = 2;
export const FIRM_SCENE = 100001; // Jangan, onde fica o Leebaek
export const ASK_HELP_PER_DAY = 3;
// Entregas minimas pro premio total (XGlobalConfig DailyTaskMinTotalTaskCount, lido 3).
export const FIRM_TOTAL_MIN = 3;
export const FIRM_TOTAL_BODY = "callsi XGuildDailyTaskDocument SendToGetMyTaskReward 3 2 0 0";

export interface FirmConfig {
  stopAfter: number; // para com N entregues no dia (padrao 3)
  maxQuality: number; // entrega item de qualidade ate esta (2 = protege Tablet e Element)
  allowItems: number[]; // itemIDs liberados mesmo acima da qualidade
  askHelp: boolean; // pede ajuda a guilda no que nao da pra entregar
  allowTeleport: boolean; // aceita a viagem paga em gold ate o Leebaek
}

export const DEFAULT_FIRM_CONFIG: FirmConfig = {
  stopAfter: 3, maxQuality: 2, allowItems: [], askHelp: true, allowTeleport: true,
};

export interface FirmTask {
  taskId: number;
  rewarded: boolean;
  asked: boolean;
  itemId: number;
  need: number;
  have: number;
  quality: number;
}

export interface FirmSnapshot {
  inWorld: boolean;
  questStatus: number; // m_Status da missao 2222 (-1 = nao achou)
  scene: number;
  navigating: boolean; // o jogo esta levando o char pela missao
  pos?: number[]; // CONN corrected [x, altura, z]
  safeToLeave?: boolean; // fora de combate, HP alto e sem monstro perto (so lido antes de parar a caca)
  inCombat?: boolean;
  hpPct?: number;
  count: number; // entregues hoje (tarefas com isRewarded; o _count do documento nao e isso)
  askedNum: number;
  totalRewarded?: boolean; // premio total do dia ja pego (undefined = nao lido)
  inGuild?: boolean; // so lido quando a missao nao esta na lista
  tasks: FirmTask[];
}

export type FirmAction = "stophunt" | "goto" | "teleport" | "take" | "submit" | "ask" | "total" | "close" | "defend";

export type FirmStep =
  | { kind: "done"; reason: string }
  | { kind: "fail"; reason: string }
  | { kind: "wait"; reason: string }
  | { kind: "act"; id: FirmAction; name: string; tag: string; body: string; cooldownMs?: number };

function act(id: FirmAction, name: string, body: string, cooldownMs?: number, tag = "SKIL"): FirmStep {
  return { kind: "act", id, name, tag, body, cooldownMs };
}

export function canSubmit(t: FirmTask, cfg: FirmConfig): boolean {
  return !t.rewarded && t.have >= t.need && t.need > 0
    && (t.quality <= cfg.maxQuality || cfg.allowItems.includes(t.itemId));
}

export interface FirmProgress {
  huntStopped: boolean;
  gotoSentAt: number;
  teleports: number; // confirmacoes de viagem mandadas
  teleportAt: number;
  arrivedAt: number; // primeira leitura em Jangan depois do "ir" (0 = ainda nao)
  lastPos?: number[];
  movedAt: number; // ultima leitura em que o char andou (0 = nunca)
  unsafeSince: number; // desde quando esta em combate esperando pra parar a caca (0 = nao)
  defended: boolean; // religou a caca no caminho (atacado com HP baixo)
  takeSent: boolean;
  submitted: number[]; // taskIDs entregues nesta passada
  asked: number[];
  totalSent: boolean; // pediu o premio total nesta passada
}

export function newFirmProgress(): FirmProgress {
  return { huntStopped: false, gotoSentAt: 0, teleports: 0, teleportAt: 0, arrivedAt: 0, movedAt: 0, unsafeSince: 0, defended: false, takeSent: false, submitted: [], asked: [], totalSent: false };
}

// Conclui o dia (Submit) so com o servidor dizendo que o premio total nao foi pego.
function totalStep(s: FirmSnapshot, p: FirmProgress): FirmStep | null {
  if (s.totalRewarded !== false || s.count < FIRM_TOTAL_MIN || p.totalSent) return null;
  return act("total", `concluir o Firm (Submit): premio total de ${s.count} entrega(s)`, FIRM_TOTAL_BODY, 8000);
}

const totalNote = (s: FirmSnapshot, p: FirmProgress) =>
  s.totalRewarded ? ", premio total pego" : p.totalSent ? ", o servidor nao deu o premio total" : "";

const GOTO_COOLDOWN_MS = 60000;
// Depois de chegar em Jangan o char ainda anda ate o Leebaek (o IsNavigating da
// missao ficou falso nesse trecho ao vivo): espera antes de aceitar.
const ARRIVE_SETTLE_MS = 10000;
// O DoTask fora de Jangan abre o mapa com a viagem e nao anda: confirma depois disso.
const TELEPORT_AFTER_MS = 6000;
const TELEPORT_COOLDOWN_MS = 15000;
const MAX_TELEPORTS = 2;
// A viagem pra outro mapa nao e direta: longe da borda, o jogo anda ate ela
// (TeleportDocument.HandleTeleportWithGate) e o IsNavigating da missao fica falso.
// Em 2026-11-09 18:01 o char andou 290 m rumo a Jangan e o Firm desistiu em 38 s
// achando que a viagem nao saiu. Andando (mais que MOVE_MIN_M desde a ultima
// leitura, ha menos de MOVE_GRACE_MS), conta como viagem em curso.
const MOVE_MIN_M = 2;
const MOVE_GRACE_MS = 8000;
// Sem chegar no Leebaek nesse tempo desde o primeiro "ir": desiste.
export const GOTO_MAX_MS = 5 * 60 * 1000;
// Parar a caca so fora de combate e sem monstro perto (a regra do "Parar bot",
// safeToStopHunt). Em 2026-11-07 21:00 o Firm desligou a caca do char principal em combate pra
// viajar, a viagem nao saiu e ele ficou ~40 s parado entre monstros. Esperando,
// a caca segue ligada; passou disso, o Firm fica pra depois.
export const FIRM_UNSAFE_MAX_MS = 60 * 1000;
// Atacado no caminho com a caca desligada e HP abaixo disso: religa e desiste
// (mesma regra da ida pra cidade do Treino).
export const FIRM_DEFEND_HP_PCT = 60;

export function nextFirmStep(s: FirmSnapshot | null, cfg: FirmConfig, p: FirmProgress, now: number): FirmStep {
  if (!s) return { kind: "wait", reason: "engine fora" };
  if (!s.inWorld) return { kind: "wait", reason: "fora de mundo" };
  if (s.questStatus < 0) {
    if (s.totalRewarded) return { kind: "done", reason: "Firm de hoje ja entregue (premio do dia pego; a missao volta na virada do dia)" };
    if (s.inGuild === false) return { kind: "fail", reason: "char sem guilda: o Firm e uma missao da guilda" };
    return { kind: "fail", reason: "missao do Firm nao achada na lista" };
  }
  if (p.defended) return { kind: "fail", reason: `atacado com HP abaixo de ${FIRM_DEFEND_HP_PCT}% indo ao Leebaek; caca religada, Firm fica pra depois` };
  if (p.huntStopped && s.inCombat && s.hpPct !== undefined && s.hpPct < FIRM_DEFEND_HP_PCT)
    return act("defend", `atacado com HP abaixo de ${FIRM_DEFEND_HP_PCT}% indo ao Leebaek: religar a caca`, JSON.stringify({ on: 1 }));
  if (s.questStatus === QUEST_CAN_TAKE) {
    if (!p.huntStopped) {
      if (s.safeToLeave === false) {
        if (p.unsafeSince > 0 && now - p.unsafeSince >= FIRM_UNSAFE_MAX_MS)
          return { kind: "fail", reason: "em combate ou com monstro perto ha 1 min; Firm fica pra depois (caca segue ligada)" };
        return { kind: "wait", reason: "esperando o char ficar seguro (fora de combate, HP alto, sem monstro perto) pra parar a caca" };
      }
      return act("stophunt", "parar a caca pra ir ao Leebaek", JSON.stringify({ on: 0 }));
    }
    if (p.gotoSentAt === 0) return act("goto", "ir ate o Leebaek", `callsi XTaskDocument DoTask 2 ${FIRM_QUEST_ID} 1`);
    if (now - p.gotoSentAt >= GOTO_MAX_MS) return { kind: "fail", reason: "nao chegou no Leebaek" };
    if (s.navigating) return { kind: "wait", reason: "indo ate o Leebaek" };
    if (s.scene !== FIRM_SCENE && p.movedAt > p.gotoSentAt && now - p.movedAt < MOVE_GRACE_MS)
      return { kind: "wait", reason: "andando ate a borda do mapa pra viajar a Jangan" };
    if (s.scene !== FIRM_SCENE) {
      if (now - p.gotoSentAt < TELEPORT_AFTER_MS || (p.teleportAt > 0 && now - p.teleportAt < TELEPORT_COOLDOWN_MS))
        return { kind: "wait", reason: "esperando a viagem" };
      if (p.teleports >= MAX_TELEPORTS) return { kind: "fail", reason: "a viagem ate Jangan nao saiu" };
      if (!cfg.allowTeleport) return { kind: "fail", reason: "precisa viajar ate Jangan e a viagem paga esta desligada" };
      return act("teleport", "confirmar a viagem ate o Leebaek (gold)", "callsn MiniMapView OnClickButtonInternationalMapTeleport 1");
    }
    if (p.arrivedAt === 0 || now - p.arrivedAt < ARRIVE_SETTLE_MS) return { kind: "wait", reason: "chegando no Leebaek" };
    // Em Jangan: aceita (repete com prazo se nao pegar).
    if (!p.takeSent || now - p.gotoSentAt >= GOTO_COOLDOWN_MS)
      return act("take", "aceitar a missao do Firm", `callsi XTaskDocument OperateTask 2 ${FIRM_QUEST_ID} 1`, 8000);
    return { kind: "wait", reason: "esperando a missao aceitar" };
  }
  if (s.questStatus !== QUEST_TAKEN) return { kind: "done", reason: "Firm de hoje ja fechado" };
  if (!s.tasks.length) return { kind: "wait", reason: "esperando as tarefas do dia" };
  if (s.count >= cfg.stopAfter) return totalStep(s, p) ?? { kind: "done", reason: `${s.count} tarefa(s) entregue(s) hoje (meta ${cfg.stopAfter})${totalNote(s, p)}` };
  const ready = s.tasks.find((t) => canSubmit(t, cfg) && !p.submitted.includes(t.taskId));
  if (ready)
    return act("submit", `entregar ${ready.need}x item ${ready.itemId} (tarefa ${ready.taskId})`,
      `callsi XGuildDailyTaskDocument SendToGetMyTaskReward 3 1 ${ready.taskId} 0`, 5000);
  if (cfg.askHelp && s.askedNum < ASK_HELP_PER_DAY) {
    const stuck = s.tasks.find((t) => !t.rewarded && !t.asked && !canSubmit(t, cfg) && !p.asked.includes(t.taskId));
    if (stuck)
      return act("ask", `pedir ajuda a guilda (item ${stuck.itemId}, tem ${stuck.have}/${stuck.need})`,
        `callsi XGuildDailyTaskDocument SendDailyTaskAskHelp 2 1 ${stuck.taskId}`, 5000);
  }
  return totalStep(s, p) ?? { kind: "done", reason: `nada mais a entregar (${s.count} entregue(s) hoje)${totalNote(s, p)}` };
}

export function trackFirm(p: FirmProgress, s: FirmSnapshot | null, now: number): FirmProgress {
  if (s && !p.huntStopped) {
    if (s.safeToLeave === false && p.unsafeSince === 0) p = { ...p, unsafeSince: now };
    else if (s.safeToLeave !== false && p.unsafeSince !== 0) p = { ...p, unsafeSince: 0 };
  }
  if (s?.pos && p.gotoSentAt > 0) {
    const moved = p.lastPos !== undefined && Math.hypot(s.pos[0] - p.lastPos[0], s.pos[2] - p.lastPos[2]) > MOVE_MIN_M;
    p = { ...p, lastPos: s.pos, movedAt: moved ? now : p.movedAt };
  }
  if (!s || p.gotoSentAt === 0 || p.arrivedAt !== 0 || s.scene !== FIRM_SCENE) return p;
  return { ...p, arrivedAt: now };
}

export function afterFirmAction(p: FirmProgress, step: FirmStep, now: number, s: FirmSnapshot | null): FirmProgress {
  if (step.kind !== "act") return p;
  if (step.id === "stophunt") return { ...p, huntStopped: true };
  if (step.id === "defend") return { ...p, defended: true };
  if (step.id === "goto") return { ...p, gotoSentAt: now };
  if (step.id === "teleport") return { ...p, teleports: p.teleports + 1, teleportAt: now };
  if (step.id === "take") return { ...p, takeSent: true };
  if (step.id === "total") return { ...p, totalSent: true };
  const m = /tarefa (\d+)\)/.exec(step.name);
  if (step.id === "submit" && m) return { ...p, submitted: [...p.submitted, Number(m[1])] };
  if (step.id === "ask" && s) {
    const id = Number(/ (\d+)$/.exec(step.body)?.[1]);
    return { ...p, asked: [...p.asked, id] };
  }
  return p;
}

// Le o estado pelo engine. Null = engine fora.
export async function readFirmSnapshot(q: EngineQuery): Promise<FirmSnapshot | null> {
  const conn = await q("CONN", "");
  const player = conn.player as Record<string, unknown> | undefined;
  if (!player) return null;
  const num = async (body: string, dflt = -1) => {
    const r = await q("GETP", body);
    return r.ok === true && typeof r.int === "number" ? r.int : dflt;
  };
  const s: FirmSnapshot = {
    inWorld: player.ok === true, questStatus: -1, scene: -1, navigating: false,
    count: 0, askedNum: 0, tasks: [],
  };
  if (!s.inWorld) return s;
  const LIST = "XTaskDocument get_TaskRecord m_TaskList";
  const n = Math.min(await num(`${LIST} get_Count`, 0), 32);
  for (let i = 0; i < n; i++) {
    if ((await num(`${LIST} get_Item:${i} m_ID`)) === FIRM_QUEST_ID) {
      s.questStatus = await num(`${LIST} get_Item:${i} m_Status`);
      break;
    }
  }
  s.scene = await num("XScene get_SceneID");
  s.navigating = (await q("GETP", "XTaskDocument get_IsNavigating")).bool === true;
  if (Array.isArray(player.corrected)) s.pos = player.corrected as number[];
  // Antes de parar a caca pra ir ao Leebaek: so com o char seguro.
  s.inCombat = player.inCombat === true;
  s.hpPct = hpPercent(player.hp, player.maxHp);
  if (s.questStatus === QUEST_CAN_TAKE) s.safeToLeave = safeToStopHunt(s.inCombat, await readEnemiesAround(q, player.corrected), s.hpPct);
  const DOC = "XGuildDailyTaskDocument";
  // Sem a missao na lista: ou o Firm do dia ja foi entregue (o jogo tira a 2222
  // da lista depois do premio total ate a virada; 2026-11-12) ou o char nao tem guilda.
  if (s.questStatus < 0) {
    const total = await q("GETP", `${DOC} get_IsRewarded`);
    if (total.ok === true) s.totalRewarded = total.bool === true;
    const g = await q("GETP", "XGuildDocument get_InGuild");
    if (g.ok === true) s.inGuild = g.bool === true;
    return s;
  }
  if (s.questStatus !== QUEST_TAKEN) return s;
  s.askedNum = await num(`${DOC} _askedNum`, 0);
  const total = await q("GETP", `${DOC} get_IsRewarded`);
  if (total.ok === true) s.totalRewarded = total.bool === true;
  const tn = Math.min(await num(`${DOC} _curGuildDailyTaskList get_Count`, 0), 12);
  for (let i = 0; i < tn; i++) {
    const base = `${DOC} _curGuildDailyTaskList get_Item:${i}`;
    const taskId = await num(`${base} taskID`);
    if (taskId < 0) continue;
    const rewarded = (await q("GETP", `${base} isRewarded`)).bool === true;
    const asked = (await q("GETP", `${base} hasAsked`)).bool === true;
    const row = `${DOC} GetDailyTaskTableInfoByID:${taskId}`;
    const itemId = await num(`${row} conditionId [#0]`);
    const need = await num(`${row} conditionNum`, 0);
    const have = itemId > 0 ? await num(`XBagDocument GetItemCount:${itemId},0`, 0) : 0;
    const quality = itemId > 0 ? (await num(`XBagDocument GetItemConf:${itemId} ItemQuality`, 99)) & 0xff : 99;
    s.tasks.push({ taskId, rewarded, asked, itemId, need, have, quality });
  }
  s.count = s.tasks.filter((t) => t.rewarded).length;
  return s;
}
