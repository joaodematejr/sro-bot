import assert from "node:assert";
import { test } from "node:test";

import {
  afterSekhmetStep,
  BUFF_EXTRA_TRIES,
  BUFF_RETRY_MS,
  ENCOURAGE_GOLD_BODY,
  ENTER_MAX_TRIES,
  ENTER_RETRY_MS,
  ENTER_SEKHMET_BODY,
  EXIT_MAX_TRIES,
  EXIT_RETRY_MS,
  EXIT_SEKHMET_BODY,
  HUNT_ON_BODY,
  LEAVE_TEAM_BODY,
  newSekhmetMemory,
  nextSekhmetStep,
  REFRESH_ACTIVITIES_BODY,
  REFRESH_ACTIVITIES_MS,
  SEKHMET_SCENE,
  type SekhmetSnapshot,
  sekhmetOpenNow,
} from "../sekhmet";

const T = 1_000_000;

function snap(p: Partial<SekhmetSnapshot> = {}): SekhmetSnapshot {
  return { inWorld: true, sceneId: 100003, inBossScene: false, open: true, inTeam: false, isEnd: false, dead: false, autoPlay: true, ...p };
}

function arena(p: Partial<SekhmetSnapshot> = {}): SekhmetSnapshot {
  return snap({ sceneId: SEKHMET_SCENE, inBossScene: true, encourageCount: 0, ...p });
}

test("sekhmet: fechado nao mexe nem na party; aberto sai da party uma vez e entra com nova tentativa", () => {
  const m = newSekhmetMemory();
  assert.equal(nextSekhmetStep(snap({ open: false, inTeam: true }), {}, m, T).kind, "closed");
  const lt = nextSekhmetStep(snap({ inTeam: true }), {}, m, T);
  assert.equal(lt.kind === "act" && lt.body, LEAVE_TEAM_BODY);
  assert.equal(nextSekhmetStep(snap({ inTeam: true }), {}, afterSekhmetStep(m, lt, T), T + 1000).kind, "wait");
  const en = nextSekhmetStep(snap(), {}, m, T);
  assert.equal(en.kind === "act" && en.body, ENTER_SEKHMET_BODY);
  let e = afterSekhmetStep(m, en, T);
  assert.equal(nextSekhmetStep(snap(), {}, e, T + 1000).kind, "wait");
  assert.equal(nextSekhmetStep(snap(), {}, e, T + ENTER_RETRY_MS).kind, "act");
  for (let i = 1; i < ENTER_MAX_TRIES; i++) e = afterSekhmetStep(e, en, T);
  assert.equal(nextSekhmetStep(snap(), {}, e, T + ENTER_RETRY_MS).kind, "fail");
});

test("sekhmet: na arena liga o auto-play, compra so os buffs pedidos e espera morto", () => {
  const m = newSekhmetMemory();
  assert.equal(nextSekhmetStep(arena(), {}, m, T).kind, "wait"); // padrao: nenhum buff
  const on = nextSekhmetStep(arena({ autoPlay: false }), { buffs: 3 }, m, T);
  assert.equal(on.kind === "act" && on.body, HUNT_ON_BODY);
  const b = nextSekhmetStep(arena(), { buffs: 3 }, m, T);
  assert.equal(b.kind === "act" && b.body, ENCOURAGE_GOLD_BODY);
  let bm = afterSekhmetStep(m, b, T);
  assert.equal(nextSekhmetStep(arena(), { buffs: 3 }, bm, T + 1000).kind, "wait");
  assert.equal(nextSekhmetStep(arena({ encourageCount: 3 }), { buffs: 3 }, m, T).kind, "wait");
  assert.equal(nextSekhmetStep(arena({ encourageCount: undefined }), { buffs: 3 }, m, T).kind, "wait");
  for (let i = 0; i < 3 + BUFF_EXTRA_TRIES; i++) bm = afterSekhmetStep(bm, b, T);
  assert.equal(nextSekhmetStep(arena(), { buffs: 3 }, bm, T + 10 * BUFF_RETRY_MS).kind, "wait");
  // Morto: nao liga auto-play nem compra.
  assert.equal(nextSekhmetStep(arena({ dead: true, autoPlay: false }), { buffs: 3 }, m, T).kind, "wait");
});

test("sekhmet: no fim sai da arena com nova tentativa e desiste; o isWin antigo nao conta", () => {
  const m = newSekhmetMemory();
  const ex = nextSekhmetStep(arena({ isEnd: true, dead: true }), {}, m, T);
  assert.equal(ex.kind === "act" && ex.body, EXIT_SEKHMET_BODY);
  let e = afterSekhmetStep(m, ex, T);
  assert.equal(nextSekhmetStep(arena({ isEnd: true }), {}, e, T + 1000).kind, "wait");
  assert.equal(nextSekhmetStep(arena({ isEnd: true }), {}, e, T + EXIT_RETRY_MS).kind, "act");
  for (let i = 1; i < EXIT_MAX_TRIES; i++) e = afterSekhmetStep(e, ex, T);
  assert.equal(nextSekhmetStep(arena({ isEnd: true }), {}, e, T + EXIT_RETRY_MS).kind, "fail");
});

test("sekhmet: aberto pela atividade 524 ou com o char na arena", async () => {
  const q = (scene: number, opening: boolean) => async (_t: string, body: string) =>
    body === "XScene get_SceneID" ? { ok: true, int: scene } : body.startsWith("XActivityDocument IsMulActivityOpening:524") ? { ok: true, bool: opening } : { ok: false };
  assert.equal(await sekhmetOpenNow(q(100003, false)), false);
  assert.equal(await sekhmetOpenNow(q(100003, true)), true);
  assert.equal(await sekhmetOpenNow(q(SEKHMET_SCENE, false)), true);
});

test("sekhmet: pede a lista de atividades ao servidor no maximo 1 vez por minuto", async () => {
  const sent: string[] = [];
  const q = async (tag: string, body: string) => {
    if (tag === "SKIL") sent.push(body);
    return body === "XScene get_SceneID" ? { ok: true, int: 100003 } : { ok: true, bool: false };
  };
  const T = Date.now() + 10 * REFRESH_ACTIVITIES_MS;
  await sekhmetOpenNow(q, T);
  await sekhmetOpenNow(q, T + 15_000);
  assert.deepEqual(sent, [REFRESH_ACTIVITIES_BODY]);
  await sekhmetOpenNow(q, T + REFRESH_ACTIVITIES_MS);
  assert.equal(sent.length, 2);
});
