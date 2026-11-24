// Missao principal (main quest) por metodo: acha a main quest na lista, vai ate o
// NPC com o DoTask do jogo, aceita, segue o objetivo (caca com o auto-play do jogo,
// falar com NPC), entrega e repete pra proxima. Logica pura; quem chama faz as
// leituras com readMainQuestSnapshot.
//
// Mapeado ao vivo no char principal (2026-11-24; ver DISCOVERY.md, secao "Missao
// principal"), so por leitura:
//   Missao     -> XTaskDocument get_TaskRecord m_TaskList: a entrada com
//                 m_TableData TaskType = 1 (XTaskType TT_Main). m_Status 1 CanTake,
//                 2 Taked, 3 Finish, 4 Over. Linha inteira: GetTaskStatue:1 (4 = acabou).
//   Objetivo   -> m_Conditions (KKSG.TaskConditionInfo: get_type TaskConnType,
//                 get_id, get_step, get_max_step).
//   Acoes      -> DoTask(id, 1) (ir), OperateTask(id, op) com TAKE 1, DONE 2,
//                 FINISH 3 (o mesmo do Firm, provado so o TAKE).
// Nao provado ao vivo (o char principal ja fechou a linha): o DoTask com a missao
// em Taked, o DONE pra falar com NPC e o FINISH pra entregar. Cada operacao tem
// limite de tentativas e a perna tem prazo: sem resposta, desiste avisando.

import type { EngineQuery } from "./tower";
import { hpPercent, readEnemiesAround, safeToStopHunt } from "./train";
import {
  afterTeleport, doTaskBody, MOVE_GRACE_MS, mustDefend, newTravel, operateTaskBody, readNavigating, stopHuntBlock,
  TASK_CAN_TAKE, TASK_FINISH, TASK_LIST, TASK_OP_DONE, TASK_OP_FINISH, TASK_OP_TAKE, TASK_OVER, TASK_TAKEN,
  TASK_TYPE_MAIN, type TravelLabels, type TravelProgress, type TravelSnapshot, trackTravel, trackUnsafe, travelStep,
} from "./quest";

// KKSG.TaskConnType que o auto-play do jogo resolve cacando: ItemID (item que o
// monstro dropa), MonsterID, MonsterDropItem, KillEnemyInSpecialScene, KillMonsterOnStaticMap.
export const MQ_HUNT_TYPES = [1, 3, 15, 17, 18];
// Os que o cliente fecha indo ate o lugar/NPC: FindPeople, NpcTalk, SearchZone.
export const MQ_TALK_TYPES = [9, 10, 13];
export const MQ_COND_NAMES: Record<number, string> = {
  1: "item", 2: "fase", 3: "matar monstro", 4: "item por qualidade", 5: "atividade", 6: "world boss", 7: "tipo de fase",
  8: "subir nivel", 9: "achar pessoa", 10: "falar com NPC", 11: "usar item", 12: "coletar", 13: "procurar area",
  14: "responder", 15: "item de monstro", 16: "escoltar NPC", 17: "matar em cena especial", 18: "matar no mapa", 19: "concluir cena",
};

export interface MainQuestConfig {
  allowTeleport: boolean; // aceita a viagem paga em gold ate o NPC/objetivo
  hunt: boolean; // liga a caca do jogo nos objetivos de matar monstro/juntar drop
  maxQuests: number; // para depois de N missoes entregues na passada (0 = sem limite)
}

export const DEFAULT_MAIN_QUEST_CONFIG: MainQuestConfig = { allowTeleport: true, hunt: true, maxQuests: 0 };

export interface MainQuestCond {
  type: number; // TaskConnType
  id: number; // monstro, item ou NPC
  step: number;
  max: number;
}

export interface MainQuest {
  id: number;
  status: number; // TaskStatus
  scene: number; // TaskScene da tabela (0 = sem cena fixa)
  level: number; // RequiredLevel
  conds: MainQuestCond[];
}

export interface MainQuestSnapshot extends TravelSnapshot {
  inWorld: boolean;
  dead?: boolean;
  level?: number;
  inCombat?: boolean;
  hpPct?: number;
  safeToLeave?: boolean; // fora de combate, HP alto e sem monstro perto
  quest: MainQuest | null;
  lineStatus?: number; // GetTaskStatue(TT_Main): 4 = linha principal acabou
}

export type MainQuestLeg = "take" | "hunt" | "talk" | "other" | "finish" | "over";

const condDone = (c: MainQuestCond) => c.max > 0 && c.step >= c.max;

// Em que parte da missao o char esta.
export function questLeg(q: MainQuest): MainQuestLeg {
  if (q.status === TASK_CAN_TAKE) return "take";
  if (q.status === TASK_FINISH) return "finish";
  if (q.status !== TASK_TAKEN) return "over";
  const open = q.conds.filter((c) => !condDone(c));
  if (q.conds.length && !open.length) return "finish";
  if (open.some((c) => MQ_HUNT_TYPES.includes(c.type))) return "hunt";
  if (!open.length || open.every((c) => MQ_TALK_TYPES.includes(c.type))) return "talk";
  return "other";
}

export function condText(c: MainQuestCond): string {
  return `${MQ_COND_NAMES[c.type] ?? `tipo ${c.type}`} ${c.id} ${c.step}/${c.max}`;
}

const openConds = (q: MainQuest) => q.conds.filter((c) => !condDone(c)).map(condText).join(", ") || "sem condicao lida";
const stepSum = (q: MainQuest | null) => (q ? q.conds.reduce((a, c) => a + c.step, 0) : 0);

export type MainQuestAction = "stophunt" | "goto" | "teleport" | "take" | "done" | "finish" | "hunt" | "defend";

export type MainQuestStep =
  | { kind: "done"; reason: string }
  | { kind: "fail"; reason: string }
  | { kind: "wait"; reason: string }
  | { kind: "act"; id: MainQuestAction; name: string; tag: string; body: string; cooldownMs?: number };

function act(id: MainQuestAction, name: string, body: string, cooldownMs?: number): MainQuestStep {
  return { kind: "act", id, name, tag: "SKIL", body, cooldownMs };
}

export interface MainQuestProgress extends TravelProgress {
  key: string; // `${id}:${perna}` em andamento ("" = nenhuma)
  questId: number; // ultima main quest vista (0 = nenhuma)
  legAt: number; // inicio da perna
  huntOff: boolean; // o bot desligou a caca (sabe que esta desligada)
  huntOnAt: number; // o bot ligou a caca pro objetivo (0 = nao)
  unsafeSince: number;
  defended: boolean;
  opSent: number; // TAKE/DONE/FINISH mandados nesta perna
  opAt: number;
  steps: number; // soma dos step na ultima leitura
  progressAt: number; // ultima vez que um step subiu (ou inicio da perna)
  renavs: number; // voltas ao objetivo de caca sem progresso
  idleSince: number; // sem main quest aberta desde (0 = tem)
  completed: number[]; // missoes que sairam da lista nesta passada
}

export function newMainQuestProgress(): MainQuestProgress {
  return {
    ...newTravel(), key: "", questId: 0, legAt: 0, huntOff: false, huntOnAt: 0, unsafeSince: 0, defended: false,
    opSent: 0, opAt: 0, steps: 0, progressAt: 0, renavs: 0, idleSince: 0, completed: [],
  };
}

// Perna sem mudar e sem nenhum step subir nesse tempo: desiste (o resto do bot
// segue). Conta do ultimo progresso: caca longa (matar 30, juntar 20) que segue
// subindo nao cai por tempo.
export const MQ_LEG_MAX_MS = 15 * 60 * 1000;
// Cacando sem nenhum step subir nesse tempo: volta ao objetivo (DoTask de novo).
export const MQ_HUNT_STALL_MS = 3 * 60 * 1000;
export const MQ_MAX_RENAVS = 2;
// TAKE/DONE/FINISH: espera a resposta antes de repetir; no maximo MQ_MAX_OPS por perna.
export const MQ_OP_RETRY_MS = 10000;
export const MQ_MAX_OPS = 3;
// Objetivo que o bot nao sabe fazer: depois de chegar (ou do ultimo step), espera o
// jogo andar sozinho.
export const MQ_OTHER_WAIT_MS = 2 * 60 * 1000;
// A proxima missao aparece na lista logo depois da entrega: espera antes de concluir.
export const MQ_NEXT_WAIT_MS = 8000;

const TRAVEL: Record<"npc" | "obj", TravelLabels> = {
  npc: { dest: "o NPC da missao", at: "no NPC da missao", map: "o mapa da missao", toMap: "ao mapa da missao" },
  obj: { dest: "o objetivo da missao", at: "no objetivo da missao", map: "o mapa da missao", toMap: "ao mapa da missao" },
};

export function nextMainQuestStep(s: MainQuestSnapshot | null, cfg: MainQuestConfig, p: MainQuestProgress, now: number): MainQuestStep {
  if (!s) return { kind: "wait", reason: "engine fora" };
  if (!s.inWorld) return { kind: "wait", reason: "fora de mundo" };
  if (s.dead) return { kind: "fail", reason: "char morto; missao principal fica pra depois" };
  if (p.defended) return { kind: "fail", reason: "atacado com HP baixo seguindo a missao; caca religada, missao principal fica pra depois" };
  if (mustDefend(p.huntOff, s.inCombat, s.hpPct)) return act("defend", "atacado com HP baixo seguindo a missao: religar a caca", JSON.stringify({ on: 1 }));
  const done = p.completed.length;
  if (cfg.maxQuests > 0 && done >= cfg.maxQuests) return { kind: "done", reason: `${done} missao(oes) principal(is) entregue(s) (limite ${cfg.maxQuests})` };
  const q = s.quest;
  if (!q || q.status === TASK_OVER) {
    if (done > 0 && p.idleSince > 0 && now - p.idleSince < MQ_NEXT_WAIT_MS) return { kind: "wait", reason: "esperando a proxima missao principal" };
    if (s.lineStatus === TASK_OVER) return { kind: "done", reason: `linha principal concluida (${done} entregue(s) nesta passada)` };
    const lv = s.level !== undefined ? ` (char nivel ${s.level}; a proxima pode pedir nivel maior)` : "";
    return { kind: "done", reason: `nenhuma missao principal aberta${lv}` };
  }
  if (s.level !== undefined && q.level > s.level) return { kind: "done", reason: `missao ${q.id} pede nivel ${q.level} (char ${s.level})` };
  const leg = questLeg(q);
  if (p.legAt > 0 && now - Math.max(p.legAt, p.progressAt) >= MQ_LEG_MAX_MS)
    return { kind: "fail", reason: `missao ${q.id} sem progresso ha 15 min (${leg}: ${openConds(q)})` };
  if (leg === "hunt" && !cfg.hunt) return { kind: "fail", reason: `missao ${q.id} pede caca (${openConds(q)}) e a caca pela missao esta desligada` };

  // Cacando o objetivo: espera os steps subirem; parado demais, volta ao objetivo.
  if (leg === "hunt" && p.huntOnAt > 0) {
    if (now - Math.max(p.progressAt, p.huntOnAt) < MQ_HUNT_STALL_MS) return { kind: "wait", reason: `cacando pela missao ${q.id}: ${openConds(q)}` };
    if (p.renavs >= MQ_MAX_RENAVS) return { kind: "fail", reason: `missao ${q.id}: sem progresso cacando (${openConds(q)})` };
    const block = stopHuntBlock(s.safeToLeave, p.unsafeSince, now, "a missao principal");
    if (block) return block;
    return act("stophunt", `missao ${q.id} sem progresso ha 3 min: parar a caca e voltar ao objetivo`, JSON.stringify({ on: 0 }));
  }

  // Ir: o auto-play do jogo segura o char no lugar, entao desliga antes (como no Firm).
  if (!p.huntOff) {
    const block = stopHuntBlock(s.safeToLeave, p.unsafeSince, now, "a missao principal");
    if (block) return block;
    return act("stophunt", "parar a caca pra seguir a missao principal", JSON.stringify({ on: 0 }));
  }
  const lb = leg === "hunt" || leg === "other" ? TRAVEL.obj : TRAVEL.npc;
  if (p.gotoSentAt === 0) return act("goto", `missao ${q.id} (${leg}): ir ate ${lb.dest}`, doTaskBody(q.id));
  const trip = travelStep(s, q.scene, p, cfg.allowTeleport, now, lb);
  if (trip.kind === "teleport") return act("teleport", trip.name, trip.body);
  if (trip.kind !== "arrived") return trip;
  // O IsNavigating fica falso em trechos da caminhada: andando, ainda nao chegou.
  if (p.movedAt > p.gotoSentAt && now - p.movedAt < MOVE_GRACE_MS) return { kind: "wait", reason: `indo ate ${lb.dest}` };

  if (leg === "hunt") return act("hunt", `missao ${q.id}: ligar a caca no objetivo (${openConds(q)})`, JSON.stringify({ on: 1 }));
  if (leg === "other") {
    if (now - Math.max(p.progressAt, p.arrivedAt) < MQ_OTHER_WAIT_MS) return { kind: "wait", reason: `missao ${q.id}: esperando o jogo (${openConds(q)})` };
    return { kind: "fail", reason: `missao ${q.id}: objetivo que o bot nao faz sozinho (${openConds(q)}); faca na mao` };
  }
  if (p.opSent > 0 && now - p.opAt < MQ_OP_RETRY_MS) return { kind: "wait", reason: `missao ${q.id}: esperando o servidor` };
  if (leg === "take") {
    if (p.opSent >= MQ_MAX_OPS) return { kind: "fail", reason: `o servidor nao aceitou a missao ${q.id}` };
    return act("take", `aceitar a missao principal ${q.id}`, operateTaskBody(q.id, TASK_OP_TAKE), MQ_OP_RETRY_MS);
  }
  if (leg === "finish") {
    if (p.opSent >= MQ_MAX_OPS) return { kind: "fail", reason: `o servidor nao aceitou a entrega da missao ${q.id}` };
    return act("finish", `entregar a missao principal ${q.id}`, operateTaskBody(q.id, TASK_OP_FINISH), MQ_OP_RETRY_MS);
  }
  // Falar com NPC: o DONE primeiro; sem efeito, tenta a entrega direto.
  if (p.opSent >= MQ_MAX_OPS + 1) return { kind: "fail", reason: `missao ${q.id}: o NPC nao fechou o objetivo (${openConds(q)})` };
  if (p.opSent < 2) return act("done", `missao ${q.id}: concluir o objetivo no NPC (${openConds(q)})`, operateTaskBody(q.id, TASK_OP_DONE), MQ_OP_RETRY_MS);
  return act("finish", `missao ${q.id}: entregar no NPC`, operateTaskBody(q.id, TASK_OP_FINISH), MQ_OP_RETRY_MS);
}

// Muda de perna (missao nova, status novo ou objetivo cumprido): zera a viagem e
// as tentativas. Missao que saiu da lista ou mudou de ID conta como entregue.
export function trackMainQuest(p: MainQuestProgress, s: MainQuestSnapshot | null, now: number): MainQuestProgress {
  if (!s || !s.inWorld) return p;
  const q = s.quest && s.quest.status !== TASK_OVER ? s.quest : null;
  if (p.questId > 0 && p.questId !== q?.id && !p.completed.includes(p.questId)) p = { ...p, completed: [...p.completed, p.questId] };
  if (!q) return { ...p, questId: 0, key: "", idleSince: p.idleSince || now };
  p = { ...p, questId: q.id, idleSince: 0 };
  const key = `${q.id}:${questLeg(q)}`;
  const steps = stepSum(q);
  if (key !== p.key) {
    p = { ...p, ...newTravel(), key, legAt: now, opSent: 0, opAt: 0, renavs: 0, huntOnAt: 0, steps, progressAt: now };
  } else if (steps > p.steps) {
    p = { ...p, steps, progressAt: now };
  }
  if (!p.huntOff) p = trackUnsafe(p, s.safeToLeave, now);
  return trackTravel(p, s, now, q.scene);
}

export function afterMainQuestAction(p: MainQuestProgress, step: MainQuestStep, now: number): MainQuestProgress {
  if (step.kind !== "act") return p;
  switch (step.id) {
    case "stophunt":
      // Parou a caca do objetivo sem progresso: volta a ir ate ele.
      if (p.huntOnAt > 0) return { ...p, ...newTravel(), huntOff: true, huntOnAt: 0, renavs: p.renavs + 1, unsafeSince: 0 };
      return { ...p, huntOff: true, unsafeSince: 0 };
    case "hunt":
      return { ...p, huntOff: false, huntOnAt: now };
    case "defend":
      return { ...p, huntOff: false, defended: true };
    case "goto":
      return { ...p, gotoSentAt: now };
    case "teleport":
      return afterTeleport(p, now);
    default:
      return { ...p, opSent: p.opSent + 1, opAt: now };
  }
}

// Le o estado pelo engine. Null = engine fora.
export async function readMainQuestSnapshot(q: EngineQuery): Promise<MainQuestSnapshot | null> {
  const conn = await q("CONN", "");
  const player = conn.player as Record<string, unknown> | undefined;
  if (!player) return null;
  const num = async (body: string, dflt = -1) => {
    const r = await q("GETP", body);
    return r.ok === true && typeof r.int === "number" ? r.int : dflt;
  };
  const s: MainQuestSnapshot = { inWorld: player.ok === true, scene: -1, navigating: false, quest: null };
  if (!s.inWorld) return s;
  s.dead = player.dead === true;
  if (typeof player.level === "number") s.level = player.level;
  s.scene = await num("XScene get_SceneID");
  s.navigating = await readNavigating(q);
  if (Array.isArray(player.corrected)) s.pos = player.corrected as number[];
  s.inCombat = player.inCombat === true;
  s.hpPct = hpPercent(player.hp, player.maxHp);
  const n = Math.min(await num(`${TASK_LIST} get_Count`, 0), 32);
  for (let i = 0; i < n && !s.quest; i++) {
    const it = `${TASK_LIST} get_Item:${i}`;
    if ((await num(`${it} m_TableData TaskType`)) !== TASK_TYPE_MAIN) continue;
    const quest: MainQuest = {
      id: await num(`${it} m_ID`),
      status: await num(`${it} m_Status`),
      scene: await num(`${it} m_TableData TaskScene`, 0),
      level: await num(`${it} m_TableData RequiredLevel`, 0),
      conds: [],
    };
    const cn = Math.min(await num(`${it} m_Conditions get_Count`, 0), 8);
    for (let j = 0; j < cn; j++) {
      const c = `${it} m_Conditions get_Item:${j}`;
      quest.conds.push({ type: await num(`${c} get_type`, 0), id: await num(`${c} get_id`, 0), step: await num(`${c} get_step`, 0), max: await num(`${c} get_max_step`, 0) });
    }
    if (quest.id > 0) s.quest = quest;
  }
  const line = await q("GETP", `XTaskDocument GetTaskStatue:${TASK_TYPE_MAIN}`);
  if (line.ok === true && typeof line.int === "number") s.lineStatus = line.int;
  // So com missao aberta: antes de parar a caca, o char precisa estar seguro.
  if (s.quest) s.safeToLeave = safeToStopHunt(s.inCombat, await readEnemiesAround(q, player.corrected), s.hpPct);
  return s;
}
