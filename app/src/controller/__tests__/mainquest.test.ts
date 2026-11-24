import assert from "node:assert";
import { test } from "node:test";

import {
  afterMainQuestAction,
  DEFAULT_MAIN_QUEST_CONFIG,
  type MainQuest,
  type MainQuestConfig,
  type MainQuestProgress,
  type MainQuestSnapshot,
  type MainQuestStep,
  MQ_HUNT_STALL_MS,
  MQ_OP_RETRY_MS,
  newMainQuestProgress,
  nextMainQuestStep,
  questLeg,
  readMainQuestSnapshot,
  trackMainQuest,
} from "../mainquest";
import { TASK_CAN_TAKE, TASK_FINISH, TASK_OVER, TASK_TAKEN, UNSAFE_MAX_MS } from "../quest";

// Objetivos lidos da tabela ao vivo (2026-11-24, GetTaskData:<id> CondType/CondParam).
const quest = (id: number, status: number, conds: MainQuest["conds"] = [], scene = 100001, level = 1): MainQuest =>
  ({ id, status, scene, level, conds });
const KILL = (step: number) => ({ type: 3, id: 110001, step, max: 5 }); // 1000005: matar 5 do monstro 110001
const TALK = { type: 10, id: 206, step: 0, max: 1 }; // 1000000: falar com o NPC 206
const DROP = { type: 1, id: 400000016, step: 0, max: 3 }; // 1000010: 3 itens que o 110001 dropa
const USE = { type: 11, id: 400000017, step: 0, max: 1 }; // 1000015: usar item

function snap(p: Partial<MainQuestSnapshot>): MainQuestSnapshot {
  return { inWorld: true, scene: 100001, navigating: false, level: 10, inCombat: false, hpPct: 100, safeToLeave: true, quest: null, lineStatus: TASK_TAKEN, ...p };
}

// Roda um tick como o runner: track, decide, aplica a acao.
function runner(cfg: MainQuestConfig = DEFAULT_MAIN_QUEST_CONFIG) {
  let p = newMainQuestProgress();
  const acts: MainQuestStep[] = [];
  return {
    get p(): MainQuestProgress { return p; },
    set p(v: MainQuestProgress) { p = v; },
    acts,
    step(s: MainQuestSnapshot, now: number): MainQuestStep {
      p = trackMainQuest(p, s, now);
      const st = nextMainQuestStep(s, cfg, p, now);
      if (st.kind === "act") { acts.push(st); p = afterMainQuestAction(p, st, now); }
      return st;
    },
  };
}
const ids = (acts: MainQuestStep[]) => acts.map((a) => (a.kind === "act" ? a.id : a.kind));

test("perna da missao pelo status e pelo tipo de objetivo da tabela", () => {
  assert.equal(questLeg(quest(1000005, TASK_CAN_TAKE)), "take");
  assert.equal(questLeg(quest(1000005, TASK_TAKEN, [KILL(2)])), "hunt");
  assert.equal(questLeg(quest(1000010, TASK_TAKEN, [DROP])), "hunt");
  assert.equal(questLeg(quest(1000000, TASK_TAKEN, [TALK])), "talk");
  assert.equal(questLeg(quest(1000015, TASK_TAKEN, [USE])), "other");
  assert.equal(questLeg(quest(1000005, TASK_TAKEN, [KILL(5)])), "finish"); // objetivo cumprido
  assert.equal(questLeg(quest(1000005, TASK_FINISH, [KILL(5)])), "finish");
  assert.equal(questLeg(quest(1000005, TASK_OVER)), "over");
});

// Ao vivo em 2026-11-24: char nivel 87, so 2223 e 2224 na lista, GetTaskStatue:1 = 4.
test("sem main quest e com a linha acabada conclui sem agir (caso do char principal)", () => {
  const st = nextMainQuestStep(snap({ level: 87, lineStatus: TASK_OVER }), DEFAULT_MAIN_QUEST_CONFIG, newMainQuestProgress(), 0);
  assert.equal(st.kind, "done");
  assert.match(st.kind === "done" ? st.reason : "", /linha principal concluida/);
  const gate = nextMainQuestStep(snap({ level: 40 }), DEFAULT_MAIN_QUEST_CONFIG, newMainQuestProgress(), 0);
  assert.match(gate.kind === "done" ? gate.reason : "", /nenhuma missao principal aberta \(char nivel 40/);
  assert.equal(nextMainQuestStep(null, DEFAULT_MAIN_QUEST_CONFIG, newMainQuestProgress(), 0).kind, "wait");
  assert.equal(nextMainQuestStep(snap({ inWorld: false }), DEFAULT_MAIN_QUEST_CONFIG, newMainQuestProgress(), 0).kind, "wait");
});

test("fluxo completo: aceita, caca o objetivo, entrega e segue pra proxima", () => {
  const r = runner();
  const can = snap({ quest: quest(1000005, TASK_CAN_TAKE) });
  // Para a caca, vai ate o NPC, espera chegar e aceita.
  assert.equal((r.step(can, 0) as { id?: string }).id, "stophunt");
  const go = r.step(can, 1000);
  assert.equal(go.kind === "act" && go.body, "callsi XTaskDocument DoTask 2 1000005 1");
  assert.equal(r.step(snap({ quest: quest(1000005, TASK_CAN_TAKE), navigating: true }), 3000).kind, "wait");
  assert.equal(r.step(can, 5000).kind, "wait"); // chegando no NPC
  const take = r.step(can, 16000);
  assert.equal(take.kind === "act" && take.body, "callsi XTaskDocument OperateTask 2 1000005 1");
  // Aceita: objetivo de matar 5. Vai ate o objetivo e liga a caca.
  const hunt0 = snap({ quest: quest(1000005, TASK_TAKEN, [KILL(0)]) });
  const go2 = r.step(hunt0, 19000);
  assert.equal(go2.kind === "act" && go2.id, "goto");
  assert.equal(r.step(hunt0, 22000).kind, "wait");
  const on = r.step(hunt0, 33000); // chegada marcada na leitura de 22 s, mais 10 s
  assert.equal(on.kind === "act" && on.body, '{"on":1}');
  // Cacando: so espera enquanto os steps sobem.
  for (let k = 1; k <= 4; k++) assert.equal(r.step(snap({ quest: quest(1000005, TASK_TAKEN, [KILL(k)]) }), 30000 + k * 60000).kind, "wait");
  // Objetivo cumprido: para a caca (seguro), volta ao NPC e entrega.
  const full = snap({ quest: quest(1000005, TASK_TAKEN, [KILL(5)]) });
  assert.equal((r.step(full, 300000) as { id?: string }).id, "stophunt");
  assert.equal((r.step(full, 301000) as { id?: string }).id, "goto");
  r.step(full, 302000);
  const fin = r.step(full, 313000);
  assert.equal(fin.kind === "act" && fin.body, "callsi XTaskDocument OperateTask 2 1000005 3");
  // Saiu da lista e a proxima apareceu: conta a entregue e recomeca.
  const next = snap({ quest: quest(1000010, TASK_CAN_TAKE) });
  assert.equal((r.step(next, 316000) as { id?: string }).id, "goto");
  assert.deepEqual(r.p.completed, [1000005]);
  assert.deepEqual(ids(r.acts), ["stophunt", "goto", "take", "goto", "hunt", "stophunt", "goto", "finish", "goto"]);
});

test("depois da entrega espera a proxima missao aparecer antes de concluir", () => {
  const r = runner();
  r.p = { ...r.p, questId: 1000005, key: "1000005:finish", huntOff: true };
  assert.equal(r.step(snap({}), 1000).kind, "wait");
  assert.deepEqual(r.p.completed, [1000005]);
  assert.equal(r.step(snap({}), 10000).kind, "done");
});

test("cacando sem progresso volta ao objetivo 2 vezes e depois desiste", () => {
  const r = runner();
  const s = snap({ quest: quest(1000005, TASK_TAKEN, [KILL(1)]) });
  r.p = { ...trackMainQuest(r.p, s, 0), huntOff: true };
  let t = 0;
  const reach = () => { r.step(s, (t += 1000)); r.step(s, (t += 1000)); return r.step(s, (t += 11000)); }; // goto, chega, liga
  for (let i = 0; i < 2; i++) {
    const on = reach();
    assert.equal(on.kind === "act" && on.id, "hunt");
    assert.equal(r.step(s, (t += MQ_HUNT_STALL_MS - 1000)).kind, "wait");
    const back = r.step(s, (t += 2000));
    assert.equal(back.kind === "act" && back.id, "stophunt");
  }
  assert.equal(r.p.renavs, 2);
  reach();
  const st = r.step(s, (t += MQ_HUNT_STALL_MS + 1000));
  assert.equal(st.kind, "fail");
  assert.match(st.kind === "fail" ? st.reason : "", /sem progresso cacando \(matar monstro 110001 1\/5\)/);
});

test("objetivo de caca com a caca pela missao desligada falha sem mexer na caca", () => {
  const st = nextMainQuestStep(snap({ quest: quest(1000005, TASK_TAKEN, [KILL(0)]) }), { ...DEFAULT_MAIN_QUEST_CONFIG, hunt: false }, newMainQuestProgress(), 0);
  assert.equal(st.kind, "fail");
});

test("TAKE sem resposta: repete com intervalo e desiste na 3a", () => {
  const r = runner();
  const can = snap({ quest: quest(1000005, TASK_CAN_TAKE) });
  r.step(can, 0); r.step(can, 1000); r.step(can, 2000);
  let t = 13000;
  const takes: string[] = [];
  for (let i = 0; i < 8; i++, t += MQ_OP_RETRY_MS / 2) {
    const st = r.step(can, t);
    if (st.kind === "act") takes.push(st.id);
    if (st.kind === "fail") { assert.match(st.reason, /nao aceitou a missao 1000005/); break; }
  }
  assert.deepEqual(takes, ["take", "take", "take"]);
});

test("falar com NPC: DONE duas vezes, depois tenta a entrega", () => {
  const r = runner();
  const s = snap({ quest: quest(1000000, TASK_TAKEN, [TALK], 0) });
  r.p = { ...trackMainQuest(r.p, s, 0), huntOff: true };
  r.step(s, 1000); // goto
  let t = 12000;
  const ops: string[] = [];
  for (let i = 0; i < 12; i++, t += MQ_OP_RETRY_MS) {
    const st = r.step(s, t);
    if (st.kind === "act") ops.push(`${st.id}:${st.body.slice(-1)}`);
    if (st.kind === "fail") break;
  }
  assert.deepEqual(ops, ["done:2", "done:2", "finish:3", "finish:3"]);
});

test("objetivo que o bot nao faz (usar item): espera o jogo e desiste avisando", () => {
  const r = runner();
  const s = snap({ quest: quest(1000015, TASK_TAKEN, [USE]) });
  r.p = { ...trackMainQuest(r.p, s, 0), huntOff: true };
  r.step(s, 1000);
  assert.equal(r.step(s, 12000).kind, "wait");
  const st = r.step(s, 200000);
  assert.match(st.kind === "fail" ? st.reason : "", /nao faz sozinho \(usar item 400000017 0\/1\)/);
});

test("so para a caca com o char seguro; em combate desiste em 1 min com a caca ligada", () => {
  const r = runner();
  const hot = snap({ quest: quest(1000005, TASK_CAN_TAKE), safeToLeave: false, inCombat: true });
  assert.equal(r.step(hot, 1000).kind, "wait");
  assert.equal(r.step(hot, 1000 + UNSAFE_MAX_MS).kind, "fail");
  assert.equal(r.acts.length, 0);
});

test("atacado com HP baixo e a caca desligada: religa e desiste", () => {
  const r = runner();
  r.p = { ...r.p, huntOff: true };
  const hit = snap({ quest: quest(1000005, TASK_CAN_TAKE), inCombat: true, hpPct: 40 });
  const st = r.step(hit, 0);
  assert.equal(st.kind === "act" && st.id, "defend");
  assert.equal(r.step(hit, 1000).kind, "fail");
});

test("fora do mapa da missao confirma a viagem paga so com ela ligada; nivel abaixo do pedido conclui", () => {
  const r = runner();
  const away = snap({ quest: quest(1000005, TASK_CAN_TAKE), scene: 100003 });
  r.step(away, 0); r.step(away, 1000);
  const tp = r.step(away, 8000);
  assert.equal(tp.kind === "act" && tp.body, "callsn MiniMapView OnClickButtonInternationalMapTeleport 1");
  const off = runner({ ...DEFAULT_MAIN_QUEST_CONFIG, allowTeleport: false });
  off.step(away, 0); off.step(away, 1000);
  assert.equal(off.step(away, 8000).kind, "fail");
  const lv = nextMainQuestStep(snap({ level: 30, quest: quest(2000000, TASK_CAN_TAKE, [], 100002, 40) }), DEFAULT_MAIN_QUEST_CONFIG, newMainQuestProgress(), 0);
  assert.match(lv.kind === "done" ? lv.reason : "", /pede nivel 40 \(char 30\)/);
});

test("limite de missoes por passada", () => {
  const p = { ...newMainQuestProgress(), completed: [1000000, 1000005] };
  const st = nextMainQuestStep(snap({ quest: quest(1000010, TASK_CAN_TAKE) }), { ...DEFAULT_MAIN_QUEST_CONFIG, maxQuests: 2 }, p, 0);
  assert.equal(st.kind, "done");
});

test("leitura: acha a entrada de TaskType 1 na lista e le as condicoes", async () => {
  // Lista como a de 2026-11-24 (2223 tipo 7, 2224 tipo 10) mais uma main em Taked.
  const rows: Record<string, number> = {
    "XScene get_SceneID": 100001,
    "XTaskDocument get_TaskRecord m_TaskList get_Count": 3,
    "XTaskDocument get_TaskRecord m_TaskList get_Item:0 m_TableData TaskType": 7,
    "XTaskDocument get_TaskRecord m_TaskList get_Item:1 m_TableData TaskType": 10,
    "XTaskDocument get_TaskRecord m_TaskList get_Item:2 m_TableData TaskType": 1,
    "XTaskDocument get_TaskRecord m_TaskList get_Item:2 m_ID": 1000005,
    "XTaskDocument get_TaskRecord m_TaskList get_Item:2 m_Status": 2,
    "XTaskDocument get_TaskRecord m_TaskList get_Item:2 m_TableData TaskScene": 100001,
    "XTaskDocument get_TaskRecord m_TaskList get_Item:2 m_TableData RequiredLevel": 1,
    "XTaskDocument get_TaskRecord m_TaskList get_Item:2 m_Conditions get_Count": 1,
    "XTaskDocument get_TaskRecord m_TaskList get_Item:2 m_Conditions get_Item:0 get_type": 3,
    "XTaskDocument get_TaskRecord m_TaskList get_Item:2 m_Conditions get_Item:0 get_id": 110001,
    "XTaskDocument get_TaskRecord m_TaskList get_Item:2 m_Conditions get_Item:0 get_step": 2,
    "XTaskDocument get_TaskRecord m_TaskList get_Item:2 m_Conditions get_Item:0 get_max_step": 5,
    "XTaskDocument GetTaskStatue:1": 2,
    "XEntityMgr GetAll get_Count": 0,
  };
  const q = async (tag: string, body: string): Promise<Record<string, unknown>> => {
    if (tag === "CONN") return { player: { ok: true, level: 12, hp: 900, maxHp: 1000, inCombat: false, corrected: [1, 0, 2] } };
    if (body === "XTaskDocument get_IsNavigating") return { ok: true, bool: false };
    return body in rows ? { ok: true, int: rows[body] } : { ok: false };
  };
  const s = await readMainQuestSnapshot(q);
  assert.deepEqual(s?.quest, { id: 1000005, status: 2, scene: 100001, level: 1, conds: [{ type: 3, id: 110001, step: 2, max: 5 }] });
  assert.equal(s?.level, 12);
  assert.equal(s?.lineStatus, 2);
  assert.equal(s?.safeToLeave, true);
});
