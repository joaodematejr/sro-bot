import assert from "node:assert";
import { test } from "node:test";

import { classifyEntity, ENTITY, parseEnts, worldToScreen } from "../map";

test("mapa: classifica monstro, elite, chefe, party, jogador, pet e NPC", () => {
  const team = new Set([111]);
  assert.equal(classifyEntity(ENTITY.Enemy, 1, team), "monster");
  assert.equal(classifyEntity(ENTITY.Enemy | ENTITY.Elite, 1, team), "elite");
  assert.equal(classifyEntity(ENTITY.Enemy | ENTITY.Boss, 1, team), "boss");
  assert.equal(classifyEntity(ENTITY.Role, 111, team), "party");
  assert.equal(classifyEntity(ENTITY.Role, 222, team), "player");
  // Pets vem com o bit de inimigo (lidos em Jangan): combate 0x10019, coleta 0x20019.
  assert.equal(classifyEntity(0x10019, 444, team), "pet");
  assert.equal(classifyEntity(0x20019, 445, team), "pet");
  assert.equal(classifyEntity(0x3, 222, team), "player");
  assert.equal(classifyEntity(ENTITY.Role | ENTITY.Affiliate, 333, team), "pet");
  assert.equal(classifyEntity(ENTITY.Npc, 1, team), "npc");
  assert.equal(classifyEntity(0, 1, team), "other");
});

test("mapa: Champion e Giant viram elite pelo nome (o jogo manda tipo de monstro comum)", () => {
  const none = new Set<number>();
  assert.equal(classifyEntity(0x19, 1, none, "Niya Hunter - Champion"), "elite");
  assert.equal(classifyEntity(0x19, 1, none, "Niya Sniper Giant"), "elite");
  assert.equal(classifyEntity(0x19, 1, none, "Niya Hunter"), "monster");
  assert.equal(classifyEntity(0x10019, 1, none, "Elite Penguin"), "pet"); // pet com nome de elite segue pet
  const s = parseEnts({ ok: true, me: { x: 0, z: 0, id: 1 }, ents: [[25, 9, 1, 1, 76, 0, 21638, 21638, "Niya Hunter - Champion"]], drops: [] }, none);
  assert.equal(s?.ents[0].kind, "elite");
});

test("mapa: le a resposta do ENTS e reconhece o engine antigo (sem ENTS)", () => {
  const r = {
    ok: true,
    me: { x: 1300.5, z: 1200, id: 7, target: 42 },
    ents: [
      [8, 42, 1310, 1205, 76, 0, 900, 1000, "Niya Hunter"],
      [2, 99, 1290, 1190, 75, 0, 5000, 5000, "Heroi"],
      [8, 43, 1320, 1210, 74, 1, 0, 1000, "Niya Sniper"],
      ["lixo"],
    ],
    drops: [[1301, 1201, 605, 1]],
  };
  const s = parseEnts(r, new Set());
  assert.ok(s);
  assert.equal(s.source, "ents");
  assert.deepEqual(s.me, { x: 1300.5, z: 1200, id: 7 });
  assert.equal(s.target, 42);
  assert.equal(s.ents.length, 3);
  assert.deepEqual([s.ents[0].kind, s.ents[0].level, s.ents[0].hp, s.ents[0].name], ["monster", 76, 900, "Niya Hunter"]);
  assert.equal(s.ents[1].kind, "player");
  assert.equal(s.ents[2].dead, true);
  assert.deepEqual(s.drops, [{ x: 1301, z: 1201, item: 605, count: 1 }]);
  // Engine sem ENTS responde o estado do jogador pra tag desconhecida.
  assert.equal(parseEnts({ player: { ok: true } }, new Set()), null);
});

test("mapa: o char fica no centro e o norte (z maior) pra cima", () => {
  const me = { x: 100, z: 200 };
  assert.deepEqual(worldToScreen(100, 200, me, 400, 300, 5), [400, 300]);
  assert.deepEqual(worldToScreen(110, 200, me, 400, 300, 5), [450, 300]); // leste: direita
  assert.deepEqual(worldToScreen(100, 210, me, 400, 300, 5), [400, 250]); // norte: cima
});
