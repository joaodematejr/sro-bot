import assert from "node:assert";
import { test } from "node:test";

import {
  afterFirmAction,
  canSubmit,
  DEFAULT_FIRM_CONFIG,
  FIRM_SCENE,
  type FirmSnapshot,
  type FirmTask,
  GOTO_MAX_MS,
  newFirmProgress,
  nextFirmStep,
  QUEST_CAN_TAKE,
  QUEST_TAKEN,
  trackFirm,
} from "../firm";

// Tarefas lidas ao vivo no Heroi (2026-11-06), depois de entregar o Bronze Chimes.
const task = (taskId: number, itemId: number, need: number, have: number, quality: number, rewarded = false): FirmTask =>
  ({ taskId, itemId, need, have, quality, rewarded, asked: false });
const LIVE: FirmTask[] = [
  task(100813, 850010839, 2, 0, 4), // Ruby Tablet Of Courage
  task(100827, 850010849, 2, 0, 4), // Ruby Tablet Of Warriors
  task(100561, 850010779, 1, 0, 4), // Jade Tablet Of Fogs
  task(100177, 850010345, 3, 0, 1), // Wing Tribe Bill
  task(101019, 850010689, 10, 220, 4), // Wind Element (protegido pela qualidade)
  task(101156, 410000044, 4, 366, 2, true), // Bronze Chimes, ja entregue
];

function snap(p: Partial<FirmSnapshot>): FirmSnapshot {
  return { inWorld: true, questStatus: QUEST_TAKEN, scene: 100003, navigating: false, count: 1, askedNum: 0, tasks: LIVE, ...p };
}

test("qualidade protege Tablet e Element; lista de liberados destrava", () => {
  assert.equal(canSubmit(LIVE[4], DEFAULT_FIRM_CONFIG), false);
  assert.equal(canSubmit(LIVE[4], { ...DEFAULT_FIRM_CONFIG, allowItems: [850010689] }), true);
  assert.equal(canSubmit(task(1, 410000044, 4, 366, 2), DEFAULT_FIRM_CONFIG), true);
  assert.equal(canSubmit(task(1, 410000044, 4, 3, 2), DEFAULT_FIRM_CONFIG), false); // falta item
  assert.equal(canSubmit(LIVE[5], DEFAULT_FIRM_CONFIG), false); // ja entregue
});

test("entrega com o comando provado ao vivo, sem item de conclusao instantanea", () => {
  const ready = [task(101156, 410000044, 4, 370, 2), ...LIVE.slice(0, 5)];
  const st = nextFirmStep(snap({ count: 0, tasks: ready }), DEFAULT_FIRM_CONFIG, newFirmProgress(), 0);
  assert.equal(st.kind === "act" && st.body, "callsi XGuildDailyTaskDocument SendToGetMyTaskReward 3 1 101156 0");
  const p = afterFirmAction(newFirmProgress(), st, 0, null);
  assert.deepEqual(p.submitted, [101156]);
});

test("sem nada entregavel: pede ajuda ate 3 por dia e depois conclui", () => {
  let p = newFirmProgress();
  const asks: number[] = [];
  for (let i = 0; i < 5; i++) {
    const st = nextFirmStep(snap({ askedNum: asks.length }), DEFAULT_FIRM_CONFIG, p, i);
    if (st.kind !== "act") break;
    assert.equal(st.id, "ask");
    asks.push(Number(/ (\d+)$/.exec(st.body)?.[1]));
    p = afterFirmAction(p, st, i, snap({}));
  }
  assert.deepEqual(asks, [100813, 100827, 100561]);
  assert.equal(nextFirmStep(snap({ askedNum: 3 }), DEFAULT_FIRM_CONFIG, p, 9).kind, "done");
  assert.equal(nextFirmStep(snap({}), { ...DEFAULT_FIRM_CONFIG, askHelp: false }, newFirmProgress(), 0).kind, "done");
});

test("meta do dia batida conclui; sem guilda falha", () => {
  assert.equal(nextFirmStep(snap({ count: 3 }), DEFAULT_FIRM_CONFIG, newFirmProgress(), 0).kind, "done");
  assert.equal(nextFirmStep(snap({ questStatus: -1 }), DEFAULT_FIRM_CONFIG, newFirmProgress(), 0).kind, "fail");
  const noGuild = nextFirmStep(snap({ questStatus: -1, inGuild: false, totalRewarded: false }), DEFAULT_FIRM_CONFIG, newFirmProgress(), 0);
  assert.equal(noGuild.kind === "fail" && noGuild.reason, "char sem guilda: o Firm e uma missao da guilda");
});

// Ao vivo em 2026-11-12: premio do dia pego, a 2222 some da lista (ficam 2223
// Bounty Quest e 2224 Mission Scroll) e o char segue na guilda.
test("missao fora da lista com o premio do dia pego conclui, sem falhar", () => {
  const s = nextFirmStep(snap({ questStatus: -1, totalRewarded: true, inGuild: true }), DEFAULT_FIRM_CONFIG, newFirmProgress(), 0);
  assert.equal(s.kind, "done");
  assert.match(s.kind === "done" ? s.reason : "", /ja entregue/);
});

test("missao por aceitar: para a caca, vai, confirma a viagem, chega e aceita", () => {
  const cfg = DEFAULT_FIRM_CONFIG;
  let p = newFirmProgress();
  const away = snap({ questStatus: QUEST_CAN_TAKE, tasks: [], scene: 100003 });
  const ids: string[] = [];
  const step = (s: FirmSnapshot, now: number) => {
    p = trackFirm(p, s, now);
    const st = nextFirmStep(s, cfg, p, now);
    if (st.kind === "act") { ids.push(st.id); p = afterFirmAction(p, st, now, s); }
    return st;
  };
  step(away, 0);
  step(away, 1000);
  assert.equal(step(away, 3000).kind, "wait"); // da tempo pro mapa abrir
  const tp = step(away, 8000);
  assert.equal(tp.kind === "act" && tp.body, "callsn MiniMapView OnClickButtonInternationalMapTeleport 1");
  const here = snap({ questStatus: QUEST_CAN_TAKE, tasks: [], scene: FIRM_SCENE });
  assert.equal(step(here, 20000).kind, "wait"); // chegando no Leebaek
  const take = step(here, 31000);
  assert.equal(take.kind === "act" && take.body, "callsi XTaskDocument OperateTask 2 2222 1");
  assert.deepEqual(ids, ["stophunt", "goto", "teleport", "take"]);
  // Viagem paga desligada: falha em vez de gastar.
  let q = afterFirmAction(afterFirmAction(newFirmProgress(), { kind: "act", id: "stophunt", name: "", tag: "", body: "" }, 0, null),
    { kind: "act", id: "goto", name: "", tag: "", body: "" }, 1, null);
  q = trackFirm(q, away, 9000);
  assert.equal(nextFirmStep(away, { ...cfg, allowTeleport: false }, q, 9000).kind, "fail");
  assert.equal(nextFirmStep(away, cfg, q, GOTO_MAX_MS + 1).kind, "fail");
});

test("Firm so para a caca fora de combate; em combate espera e desiste em 1 min com a caca ligada", async () => {
  const { QUEST_CAN_TAKE, FIRM_UNSAFE_MAX_MS, trackFirm } = await import("../firm");
  // Caso real de 2026-11-07 21:00: Heroi em combate no ponto, missao pra pegar.
  const emCombate = snap({ questStatus: QUEST_CAN_TAKE, safeToLeave: false });
  let p = trackFirm(newFirmProgress(), emCombate, 1000);
  assert.equal(p.unsafeSince, 1000);
  assert.deepEqual(nextFirmStep(emCombate, DEFAULT_FIRM_CONFIG, p, 1000), { kind: "wait", reason: "esperando o char ficar seguro (fora de combate, HP alto, sem monstro perto) pra parar a caca" });
  p = trackFirm(p, emCombate, 1000 + FIRM_UNSAFE_MAX_MS);
  assert.equal(nextFirmStep(emCombate, DEFAULT_FIRM_CONFIG, p, 1000 + FIRM_UNSAFE_MAX_MS).kind, "fail");
  // Saiu do combate antes: zera a espera e para a caca.
  const seguro = snap({ questStatus: QUEST_CAN_TAKE, safeToLeave: true });
  p = trackFirm(trackFirm(newFirmProgress(), emCombate, 1000), seguro, 20000);
  assert.equal(p.unsafeSince, 0);
  const st = nextFirmStep(seguro, DEFAULT_FIRM_CONFIG, p, 20000);
  assert.equal(st.kind === "act" && st.id, "stophunt");
  // Sem a leitura (snapshot antigo): comportamento de antes.
  assert.equal((nextFirmStep(snap({ questStatus: QUEST_CAN_TAKE }), DEFAULT_FIRM_CONFIG, newFirmProgress(), 0) as { id?: string }).id, "stophunt");
});

// Mesma regra da ida pra cidade do Treino (morte de 2026-11-08 09:49).
test("Firm: atacado indo ao Leebaek com HP abaixo de 60% religa a caca e desiste", async () => {
  const { QUEST_CAN_TAKE, FIRM_DEFEND_HP_PCT } = await import("../firm");
  const p = { ...newFirmProgress(), huntStopped: true, gotoSentAt: 1000 };
  const hit = snap({ questStatus: QUEST_CAN_TAKE, scene: 100005, inCombat: true, hpPct: FIRM_DEFEND_HP_PCT - 1 });
  const st = nextFirmStep(hit, DEFAULT_FIRM_CONFIG, p, 2000);
  assert.equal(st.kind === "act" && st.id, "defend");
  assert.equal(st.kind === "act" && st.body, '{"on":1}');
  const pd = afterFirmAction(p, st, 2000, hit);
  assert.equal(nextFirmStep(hit, DEFAULT_FIRM_CONFIG, pd, 3000).kind, "fail");
  // HP alto ou fora de combate: segue a viagem.
  const ok = snap({ questStatus: QUEST_CAN_TAKE, scene: 100005, inCombat: true, hpPct: 80 });
  assert.notEqual((nextFirmStep(ok, DEFAULT_FIRM_CONFIG, p, 2000) as { id?: string }).id, "defend");
  // Antes de parar a caca nao ha o que religar.
  assert.notEqual((nextFirmStep(hit, DEFAULT_FIRM_CONFIG, newFirmProgress(), 2000) as { id?: string }).id, "defend");
});

test("Firm: andando ate a borda do mapa conta como viagem (caso de 2026-11-09 18:01)", () => {
  const cfg = DEFAULT_FIRM_CONFIG;
  // Niya Hunter (100003), missao pra pegar; o char anda ~5 m/s rumo a borda com o IsNavigating falso.
  const at = (x: number) => snap({ questStatus: QUEST_CAN_TAKE, tasks: [], safeToLeave: true, pos: [x, 107, 1128] });
  let p = newFirmProgress();
  const step = (s: FirmSnapshot, now: number) => {
    p = trackFirm(p, s, now);
    const st = nextFirmStep(s, cfg, p, now);
    if (st.kind === "act") p = afterFirmAction(p, st, now, s);
    return st;
  };
  step(at(1194), 0); // parar a caca
  step(at(1194), 1000); // ir
  assert.equal(step(at(1194), 4000).kind, "wait");
  assert.equal(step(at(1194), 8000).kind, "act"); // 1a viagem
  assert.equal(step(at(1194), 24000).kind, "act"); // 2a viagem: o char comecou a andar depois
  // Antes desistia aqui (38 s); andando, espera.
  let x = 1194;
  for (let t = 27000; t < 120000; t += 3000) {
    x += 15;
    assert.deepEqual(step(at(x), t), { kind: "wait", reason: "andando ate a borda do mapa pra viajar a Jangan" });
  }
  // Parou fora de Jangan alem da folga: ai desiste.
  step(at(x), 123000);
  assert.equal(step(at(x), 132000).kind, "fail");
  // Chegou em Jangan: segue pro aceite.
  p = { ...p, teleports: 2 };
  assert.equal(step(snap({ questStatus: QUEST_CAN_TAKE, tasks: [], scene: FIRM_SCENE, pos: [10, 0, 10] }), 125000).kind, "wait");
});

test("Firm: com 3 ou mais entregues conclui o dia (Submit) so com o premio total nao pego (caso de 2026-11-10)", async () => {
  const { FIRM_TOTAL_BODY } = await import("../firm");
  const done3 = LIVE.map((t, i) => ({ ...t, rewarded: i >= 3 }));
  // Meta batida e premio total livre: Submit, sem item de conclusao (useItemPass 0).
  const st = nextFirmStep(snap({ count: 3, tasks: done3, totalRewarded: false }), DEFAULT_FIRM_CONFIG, newFirmProgress(), 0);
  assert.equal(st.kind === "act" && st.id, "total");
  assert.equal(st.kind === "act" && st.body, "callsi XGuildDailyTaskDocument SendToGetMyTaskReward 3 2 0 0");
  assert.equal(FIRM_TOTAL_BODY.endsWith(" 0 0"), true);
  // Pedido uma vez por passada; o servidor nao deu: conclui avisando.
  const p = afterFirmAction(newFirmProgress(), st, 0, null);
  const again = nextFirmStep(snap({ count: 3, tasks: done3, totalRewarded: false }), DEFAULT_FIRM_CONFIG, p, 1);
  assert.equal(again.kind === "done" && again.reason.includes("nao deu o premio total"), true);
  // Ja pego (como amanheceu em 2026-11-10, 5/6) ou nao lido: nao pede.
  assert.equal(nextFirmStep(snap({ count: 5, tasks: done3, totalRewarded: true }), DEFAULT_FIRM_CONFIG, newFirmProgress(), 0).kind, "done");
  assert.equal(nextFirmStep(snap({ count: 3, tasks: done3 }), DEFAULT_FIRM_CONFIG, newFirmProgress(), 0).kind, "done");
  // Menos de 3 entregues: nunca, mesmo sem nada mais a fazer.
  assert.equal(nextFirmStep(snap({ count: 2, askedNum: 3, totalRewarded: false }), DEFAULT_FIRM_CONFIG, newFirmProgress(), 0).kind, "done");
  // Nada mais a entregar com 3 (meta 4): conclui tambem.
  const st4 = nextFirmStep(snap({ count: 3, tasks: done3, askedNum: 3, totalRewarded: false }), { ...DEFAULT_FIRM_CONFIG, stopAfter: 4 }, newFirmProgress(), 0);
  assert.equal(st4.kind === "act" && st4.id, "total");
});
