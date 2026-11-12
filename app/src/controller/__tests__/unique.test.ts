import assert from "node:assert";
import { test } from "node:test";

import type { MapEntity } from "../map";
import { alertFromLog } from "../telegram";
import { UNIQUE_FORGET_MS, uniqueStep, uniqueText } from "../unique";

const ent = (o: Partial<MapEntity>): MapEntity => ({ kind: "monster", id: 1, x: 0, z: 0, level: 80, dead: false, hp: 1, maxHp: 1, name: "", ...o });

test("unico avisa uma vez por id; elite, monstro e unico morto nao avisam", () => {
  const boss = ent({ kind: "boss", id: 7, name: "Tiger Girl" });
  const ents = [boss, ent({ kind: "elite", id: 8 }), ent({ id: 9 }), ent({ kind: "boss", id: 10, dead: true })];
  const a = uniqueStep(new Map(), ents, 1000);
  assert.deepEqual(a.fresh.map((e) => e.id), [7]);
  const b = uniqueStep(a.seen, ents, 2000);
  assert.equal(b.fresh.length, 0); // ainda na tela: nao repete
});

test("unico que some por 30 min volta a avisar", () => {
  const boss = ent({ kind: "boss", id: 7 });
  const a = uniqueStep(new Map(), [boss], 0);
  const gone = uniqueStep(a.seen, [], UNIQUE_FORGET_MS - 1);
  assert.equal(uniqueStep(gone.seen, [boss], UNIQUE_FORGET_MS - 1).fresh.length, 0);
  const later = uniqueStep(a.seen, [], UNIQUE_FORGET_MS);
  assert.equal(uniqueStep(later.seen, [boss], UNIQUE_FORGET_MS).fresh.length, 1);
});

test("texto do unico tem nome, nivel e distancia, e vira aviso do Telegram", () => {
  const t = uniqueText(ent({ kind: "boss", name: "Tiger Girl", level: 20, x: 30, z: 40 }), { x: 0, z: 0 });
  assert.equal(t, "Unico por perto: Tiger Girl Lv.20 a 50 m.");
  assert.equal(uniqueText(ent({ kind: "boss", level: 0 }), { x: 0, z: 0 }), "Unico por perto: monstro unico a 0 m.");
  const al = alertFromLog(`[12:00:00] ${t}`);
  assert.equal(al?.kind, "unico");
  assert.equal(al?.group, "problem");
});
