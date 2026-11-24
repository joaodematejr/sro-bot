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
//   Roleta      -> a nota da cartela (get_CurScore, 0 a 4; 4 = a melhor) sobe com
//                  SendToRefreshTaskOp(DROT_Refresh 1, roleid do char), so enquanto
//                  houver giro gratis (_refresh_num; 3 por dia). Com 0 giros o botao
//                  do jogo manda DROT_BuyCount (3), que e pago: o bot nunca manda.
//                  Ideia e mapeamento de um contribuidor (2026-11-19); sem prova ao vivo.
// Nunca: "Instant Quest Completion" (item) nem comprar giro da roleta (pode ser Silk).

import type { EngineQuery } from "./tower";
import { hpPercent, readEnemiesAround, safeToStopHunt } from "./train";
import { roleId } from "./chat";
import {
  afterTeleport, DEFEND_HP_PCT, doTaskBody, findTaskStatus, GOTO_MAX_MS, mustDefend, newTravel, operateTaskBody,
  readNavigating, stopHuntBlock, TASK_CAN_TAKE, TASK_OP_TAKE, TASK_TAKEN, type TravelLabels, type TravelProgress,
  trackTravel, trackUnsafe, travelStep, UNSAFE_MAX_MS,
} from "./quest";

export const FIRM_QUEST_ID = 2222;
export const QUEST_CAN_TAKE = TASK_CAN_TAKE;
export const QUEST_TAKEN = TASK_TAKEN;
export const FIRM_SCENE = 100001; // Jangan, onde fica o Leebaek
export const ASK_HELP_PER_DAY = 3;
// Entregas minimas pro premio total (XGlobalConfig DailyTaskMinTotalTaskCount, lido 3).
export const FIRM_TOTAL_MIN = 3;
export const FIRM_TOTAL_BODY = "callsi XGuildDailyTaskDocument SendToGetMyTaskReward 3 2 0 0";
// Nota da cartela: o jogo para de deixar girar na 4.
export const FIRM_BEST_SCORE = 4;
export const FIRM_SPINS_PER_DAY = 3;
export const FIRM_SCORE_NAMES = ["D", "C", "B", "A", "S"];
// DROT_Refresh com o roleid do proprio char (o mesmo do botao do jogo).
export function refreshBody(roleId: string): string {
  if (!/^[1-9]\d*$/.test(roleId)) throw new Error("roleid invalido");
  return `callx XGuildDailyTaskDocument SendToRefreshTaskOp 2 -- i:1 q:${roleId}`;
}

export interface FirmConfig {
  stopAfter: number; // para com N entregues no dia (padrao 3)
  maxQuality: number; // entrega item de qualidade ate esta (2 = protege Tablet e Element)
  allowItems: number[]; // itemIDs liberados mesmo acima da qualidade
  askHelp: boolean; // pede ajuda a guilda no que nao da pra entregar
  allowTeleport: boolean; // aceita a viagem paga em gold ate o Leebaek
  reroll?: boolean; // gira a roleta gratis da cartela ate a nota alvo (desligado se ausente)
  rerollTarget?: number; // nota alvo de get_CurScore: 2 B, 3 A, 4 S (padrao 3)
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
  refreshNum?: number; // giros gratis da roleta (_refresh_num)
  curScore?: number; // nota da cartela (get_CurScore)
  roleId?: string; // roleid de 64 bits do char (so lido com a roleta ligada)
}

export type FirmAction = "stophunt" | "goto" | "teleport" | "take" | "refresh" | "submit" | "ask" | "total" | "close" | "defend";

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

// Viagem (gotoSentAt, teleports, arrivedAt em Jangan, movedAt) vem do quest.ts.
export interface FirmProgress extends TravelProgress {
  huntStopped: boolean;
  unsafeSince: number; // desde quando esta em combate esperando pra parar a caca (0 = nao)
  defended: boolean; // religou a caca no caminho (atacado com HP baixo)
  takeSent: boolean;
  submitted: number[]; // taskIDs entregues nesta passada
  asked: number[];
  totalSent: boolean; // pediu o premio total nesta passada
  spins: number; // giros da roleta mandados nesta passada (nunca passa dos gratis do dia)
}

export function newFirmProgress(): FirmProgress {
  return { ...newTravel(), huntStopped: false, unsafeSince: 0, defended: false, takeSent: false, submitted: [], asked: [], totalSent: false, spins: 0 };
}

// Conclui o dia (Submit) so com o servidor dizendo que o premio total nao foi pego.
function totalStep(s: FirmSnapshot, p: FirmProgress): FirmStep | null {
  if (s.totalRewarded !== false || s.count < FIRM_TOTAL_MIN || p.totalSent) return null;
  return act("total", `concluir o Firm (Submit): premio total de ${s.count} entrega(s)`, FIRM_TOTAL_BODY, 8000);
}

const totalNote = (s: FirmSnapshot, p: FirmProgress) =>
  s.totalRewarded ? ", premio total pego" : p.totalSent ? ", o servidor nao deu o premio total" : "";

const GOTO_COOLDOWN_MS = 60000;
// Viagem e guarda da caca no quest.ts (casos de 2026-11-07 21:00, 2026-11-08 09:49
// e 2026-11-09 18:01 contados la).
export { GOTO_MAX_MS };
export const FIRM_UNSAFE_MAX_MS = UNSAFE_MAX_MS;
export const FIRM_DEFEND_HP_PCT = DEFEND_HP_PCT;
const FIRM_TRAVEL: TravelLabels = { dest: "o Leebaek", at: "no Leebaek", map: "Jangan", toMap: "a Jangan" };

export function nextFirmStep(s: FirmSnapshot | null, cfg: FirmConfig, p: FirmProgress, now: number): FirmStep {
  if (!s) return { kind: "wait", reason: "engine fora" };
  if (!s.inWorld) return { kind: "wait", reason: "fora de mundo" };
  if (s.questStatus < 0) {
    if (s.totalRewarded) return { kind: "done", reason: "Firm de hoje ja entregue (premio do dia pego; a missao volta na virada do dia)" };
    if (s.inGuild === false) return { kind: "fail", reason: "char sem guilda: o Firm e uma missao da guilda" };
    return { kind: "fail", reason: "missao do Firm nao achada na lista" };
  }
  if (p.defended) return { kind: "fail", reason: `atacado com HP abaixo de ${FIRM_DEFEND_HP_PCT}% indo ao Leebaek; caca religada, Firm fica pra depois` };
  if (mustDefend(p.huntStopped, s.inCombat, s.hpPct))
    return act("defend", `atacado com HP abaixo de ${FIRM_DEFEND_HP_PCT}% indo ao Leebaek: religar a caca`, JSON.stringify({ on: 1 }));
  if (s.questStatus === QUEST_CAN_TAKE) {
    if (!p.huntStopped) {
      const block = stopHuntBlock(s.safeToLeave, p.unsafeSince, now, "Firm");
      if (block) return block;
      return act("stophunt", "parar a caca pra ir ao Leebaek", JSON.stringify({ on: 0 }));
    }
    if (p.gotoSentAt === 0) return act("goto", "ir ate o Leebaek", doTaskBody(FIRM_QUEST_ID));
    const trip = travelStep(s, FIRM_SCENE, p, cfg.allowTeleport, now, FIRM_TRAVEL);
    if (trip.kind === "teleport") return act("teleport", trip.name, trip.body);
    if (trip.kind !== "arrived") return trip;
    // Em Jangan: aceita (repete com prazo se nao pegar).
    if (!p.takeSent || now - p.gotoSentAt >= GOTO_COOLDOWN_MS)
      return act("take", "aceitar a missao do Firm", operateTaskBody(FIRM_QUEST_ID, TASK_OP_TAKE), 8000);
    return { kind: "wait", reason: "esperando a missao aceitar" };
  }
  if (s.questStatus !== QUEST_TAKEN) return { kind: "done", reason: "Firm de hoje ja fechado" };
  if (!s.tasks.length) return { kind: "wait", reason: "esperando as tarefas do dia" };
  const spin = rerollStep(s, cfg, p);
  if (spin) return spin;
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
  if (s && !p.huntStopped) p = trackUnsafe(p, s.safeToLeave, now);
  return trackTravel(p, s, now, FIRM_SCENE);
}

export function afterFirmAction(p: FirmProgress, step: FirmStep, now: number, s: FirmSnapshot | null): FirmProgress {
  if (step.kind !== "act") return p;
  if (step.id === "stophunt") return { ...p, huntStopped: true };
  if (step.id === "defend") return { ...p, defended: true };
  if (step.id === "goto") return { ...p, gotoSentAt: now };
  if (step.id === "teleport") return afterTeleport(p, now);
  if (step.id === "take") return { ...p, takeSent: true };
  if (step.id === "total") return { ...p, totalSent: true };
  if (step.id === "refresh") return { ...p, spins: p.spins + 1 };
  const m = /tarefa (\d+)\)/.exec(step.name);
  if (step.id === "submit" && m) return { ...p, submitted: [...p.submitted, Number(m[1])] };
  if (step.id === "ask" && s) {
    const id = Number(/ (\d+)$/.exec(step.body)?.[1]);
    return { ...p, asked: [...p.asked, id] };
  }
  return p;
}

// Roleta gratis antes do premio total: so com giro gratis lido, a nota lida abaixo
// do alvo e o roleid do char. Cada giro espera a resposta (a nota e os giros mudam).
export function rerollStep(s: FirmSnapshot, cfg: FirmConfig, p: FirmProgress): FirmStep | null {
  if (!cfg.reroll || !s.roleId || s.totalRewarded || p.spins >= FIRM_SPINS_PER_DAY) return null;
  if (s.refreshNum === undefined || s.refreshNum <= 0 || s.curScore === undefined) return null;
  const target = Math.min(FIRM_BEST_SCORE, Math.max(1, cfg.rerollTarget ?? 3));
  if (s.curScore >= target) return null;
  const name = (n: number) => FIRM_SCORE_NAMES[n] ?? String(n);
  return act("refresh", `girar a roleta gratis do Firm (nota ${name(s.curScore)}, alvo ${name(target)}; ${s.refreshNum} giro(s) gratis)`,
    refreshBody(s.roleId), 4000);
}

// Le o estado pelo engine. Null = engine fora.
export async function readFirmSnapshot(q: EngineQuery, cfg?: FirmConfig): Promise<FirmSnapshot | null> {
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
  s.questStatus = await findTaskStatus(q, FIRM_QUEST_ID);
  s.scene = await num("XScene get_SceneID");
  s.navigating = await readNavigating(q);
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
  if (cfg?.reroll) {
    const rn = await q("GETP", `${DOC} _refresh_num`);
    if (rn.ok === true && typeof rn.int === "number") s.refreshNum = rn.int;
    const sc = await q("GETP", `${DOC} get_CurScore`);
    if (sc.ok === true && typeof sc.int === "number") s.curScore = sc.int;
    const lo = await q("GETP", "XAttributeMgr get_XPlayerData _id");
    const hi = await q("GETP", "XAttributeMgr get_XPlayerData _id+4");
    if (typeof lo.int === "number" && typeof hi.int === "number" && lo.ok === true && hi.ok === true) s.roleId = roleId(lo.int, hi.int);
  }
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
