import assert from "node:assert";
import { test } from "node:test";

import { type MapEntity, type MapSnapshot, parseEnts } from "../map";
import {
  afterSwap,
  filterActive,
  GIVE_UP_MS,
  INSIST_WINDOW_MS,
  isIgnored,
  monsterFilterStep,
  type MonsterFilterConfig,
  nearbySpecies,
  newFilterMemory,
  SWAP_MAX_M,
  targBody,
  targResult,
} from "../monsterfilter";

// Niya Mage 310011 e Niya Shaman 310012: lidos ao vivo no North Taklamakan.
const MAGE = 310011;
const SHAMAN = 310012;

function ent(id: number, x: number, z: number, over: Partial<MapEntity> = {}): MapEntity {
  return { kind: "monster", id, x, z, level: 77, dead: false, hp: 11170, maxHp: 11170, name: "Niya Mage", typeId: MAGE, ...over };
}

function snap(target: number, ents: MapEntity[]): MapSnapshot {
  return { me: { x: 0, z: 0, id: 1 }, target, ents, drops: [], path: [], source: "ents" };
}

const noMage: MonsterFilterConfig = { species: [{ id: MAGE, name: "Niya Mage" }] };

test("filtro: desligado sem especie nem categoria", () => {
  assert.equal(filterActive(undefined), false);
  assert.equal(filterActive({}), false);
  assert.equal(filterActive({ species: [], categories: [] }), false);
  assert.equal(filterActive(noMage), true);
  assert.equal(filterActive({ categories: ["boss"] }), true);
  const s = snap(10, [ent(10, 5, 0), ent(11, 8, 0, { typeId: SHAMAN, name: "Niya Shaman" })]);
  assert.deepEqual(monsterFilterStep(s, {}, newFilterMemory(), 0), { kind: "none" });
});

test("filtro: ignora por especie e por categoria, nunca jogador, pet ou NPC", () => {
  assert.equal(isIgnored(ent(1, 0, 0), noMage), true);
  assert.equal(isIgnored(ent(1, 0, 0, { typeId: SHAMAN }), noMage), false);
  // Engine sem _type_id: especie nao pega (nao chuta pelo nome).
  assert.equal(isIgnored(ent(1, 0, 0, { typeId: undefined }), noMage), false);
  const champ: MonsterFilterConfig = { categories: ["elite"] };
  assert.equal(isIgnored(ent(1, 0, 0, { kind: "elite", name: "Niya Shaman - Champion" }), champ), true);
  assert.equal(isIgnored(ent(1, 0, 0), champ), false);
  assert.equal(isIgnored(ent(1, 0, 0, { kind: "boss" }), { categories: ["boss"] }), true);
  const all: MonsterFilterConfig = { categories: ["monster", "elite", "boss"], species: [{ id: MAGE, name: "x" }] };
  for (const kind of ["player", "party", "pet", "npc", "other"] as const) assert.equal(isIgnored(ent(1, 0, 0, { kind }), all), false, kind);
});

test("filtro: alvo ignorado troca pro permitido vivo mais perto", () => {
  const s = snap(10, [
    ent(10, 3, 0), // alvo: Mage, ignorado
    ent(11, 4, 0), // Mage: ignorado tambem
    ent(12, 30, 0, { typeId: SHAMAN, name: "Niya Shaman" }),
    ent(13, 20, 0, { typeId: SHAMAN, name: "Niya Shaman" }),
    ent(14, 6, 0, { typeId: SHAMAN, dead: true }), // corpo
    ent(15, 7, 0, { typeId: SHAMAN, hp: 0 }), // morrendo (HP 0)
    ent(16, 2, 0, { kind: "pet", typeId: 999 }),
    ent(17, 1, 0, { kind: "player", typeId: undefined }),
  ]);
  const st = monsterFilterStep(s, noMage, newFilterMemory(), 0);
  assert.equal(st.kind, "swap");
  if (st.kind === "swap") {
    assert.equal(st.from.id, 10);
    assert.equal(st.to.id, 13);
    assert.equal(st.dist, 20);
  }
});

test("filtro: alvo permitido, morto, sumido ou sem alvo nao faz nada", () => {
  const m = newFilterMemory();
  const sh = ent(10, 3, 0, { typeId: SHAMAN });
  assert.equal(monsterFilterStep(snap(10, [sh, ent(11, 4, 0)]), noMage, m, 0).kind, "none");
  assert.equal(monsterFilterStep(snap(0, [ent(10, 3, 0), sh]), noMage, m, 0).kind, "none");
  assert.equal(monsterFilterStep(snap(99, [ent(10, 3, 0)]), noMage, m, 0).kind, "none");
  assert.equal(monsterFilterStep(snap(10, [ent(10, 3, 0, { dead: true }), ent(11, 4, 0, { typeId: SHAMAN })]), noMage, m, 0).kind, "none");
});

test("filtro: sem permitido ate SWAP_MAX_M, deixa lutar com o ignorado", () => {
  const far = ent(12, SWAP_MAX_M + 1, 0, { typeId: SHAMAN });
  const st = monsterFilterStep(snap(10, [ent(10, 3, 0), far]), noMage, newFilterMemory(), 0);
  assert.deepEqual(st.kind === "keep" && st.why, "sem-permitido");
  const ok = ent(12, SWAP_MAX_M, 0, { typeId: SHAMAN });
  assert.equal(monsterFilterStep(snap(10, [ent(10, 3, 0), ok]), noMage, newFilterMemory(), 0).kind, "swap");
});

test("filtro: o mesmo ignorado voltando 2 vezes em 30 s fica 60 s sem troca", () => {
  const s = snap(10, [ent(10, 3, 0), ent(12, 10, 0, { typeId: SHAMAN })]);
  let m = afterSwap(newFilterMemory(), 10, 1000);
  assert.equal(monsterFilterStep(s, noMage, m, 2000).kind, "swap");
  m = afterSwap(m, 10, 5000);
  const st = monsterFilterStep(s, noMage, m, 6000);
  assert.deepEqual(st.kind === "keep" && st.why, "insiste");
  assert.equal(monsterFilterStep(s, noMage, m, 5000 + GIVE_UP_MS + 1).kind, "swap");
  // Duas trocas longe uma da outra nao contam como insistencia.
  let m2 = afterSwap(newFilterMemory(), 10, 0);
  m2 = afterSwap(m2, 10, INSIST_WINDOW_MS + 1);
  assert.equal(monsterFilterStep(s, noMage, m2, INSIST_WINDOW_MS + 2).kind, "swap");
});

test("filtro: a memoria esquece o que passou", () => {
  let m = newFilterMemory();
  for (let i = 0; i < 50; i++) m = afterSwap(m, 1000 + i, i * 1000);
  m = afterSwap(m, 1, 10 * 60 * 1000);
  assert.deepEqual(Object.keys(m.tries), ["1"]);
  assert.deepEqual(m.giveUp, {});
});

test("filtro: resposta do TARG (troca, engine antigo, recusa)", () => {
  assert.equal(targResult({ ok: true, targ: 368565 }), "ok");
  assert.equal(targResult({ player: { ok: true, level: 87 } }), "old-engine");
  assert.equal(targResult({ ok: false, erro: "monstro morto" }), "refused");
  assert.equal(targResult({ ok: false, erro: "timeout" }), "refused");
  assert.equal(targBody(368565), "368565");
  assert.equal(targBody(-1), "4294967295");
});

test("filtro: ENTS com especie vira typeId; engine antigo fica sem", () => {
  const r = {
    ok: true,
    me: { x: 0, z: 0, id: 1, target: 9 },
    ents: [
      [25, 9, 1, 1, 77, 0, 11170, 11170, "Niya Mage", MAGE],
      [25, 8, 2, 2, 78, 0, 11532, 11532, "Niya Shaman"],
      [3, 7, 3, 3, 80, 0, 100, 100, "Heroi", 0],
    ],
    drops: [],
  };
  const s = parseEnts(r, new Set());
  assert.equal(s?.ents[0].typeId, MAGE);
  assert.equal(s?.ents[1].typeId, undefined);
  assert.equal(s?.ents[2].typeId, undefined); // 0 = sem atributos
});

test("filtro: especies em volta pra tela, sem repetir", () => {
  const list = nearbySpecies([
    ent(1, 0, 0),
    ent(2, 0, 0),
    ent(3, 0, 0, { typeId: SHAMAN, name: "Niya Shaman", level: 78 }),
    ent(4, 0, 0, { kind: "pet", typeId: 5 }),
    ent(5, 0, 0, { typeId: undefined }),
  ]);
  assert.deepEqual(list, [
    { id: MAGE, name: "Niya Mage", level: 77, kind: "monster", count: 2 },
    { id: SHAMAN, name: "Niya Shaman", level: 78, kind: "monster", count: 1 },
  ]);
});
