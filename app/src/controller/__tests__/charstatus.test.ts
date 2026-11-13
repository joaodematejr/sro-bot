import assert from "node:assert";
import { test } from "node:test";

import { buffLabel, buffLeftText, killStep, parseBufs } from "../charstatus";

test("BUFS: le id, nivel, pilha, tempo e chave do nome", () => {
  const r = { ok: true, clock: true, buffs: [[200019, 11, 1, 710, 730, "BuffList_BuffName_200019_11"], [21, 1, 1, -1, 0, ""], "lixo"] };
  const b = parseBufs(r);
  assert.equal(b?.length, 2);
  assert.deepEqual(b?.[0], { id: 200019, level: 11, stack: 1, left: 710, total: 730, key: "BuffList_BuffName_200019_11", name: "" });
  assert.equal(parseBufs({ ok: false }), null);
});

test("buff na tela: nome traduzido ou id, nivel, pilha e tempo restante", () => {
  const b = { id: 200019, level: 11, stack: 1, left: 725, total: 730, key: "", name: "" };
  assert.equal(buffLabel(b), "buff 200019 Lv11");
  assert.equal(buffLabel({ ...b, name: "Força", level: 1, stack: 3 }), "Força x3");
  assert.equal(buffLeftText(b), "12:05");
  assert.equal(buffLeftText({ ...b, left: 3750, total: 7200 }), "1:02:30");
  assert.equal(buffLeftText({ ...b, total: 0 }), "fixo");
  assert.equal(buffLeftText({ ...b, left: -1 }), ""); // relogio do jogo ainda nao lido
});

test("abates: conta a diferenca e recomeca quando o jogo reabre", () => {
  let s = killStep(undefined, 40);
  assert.deepEqual(s, { gained: 0, last: 40 }); // primeira leitura so marca
  s = killStep(s.last, 43);
  assert.equal(s.gained, 3);
  s = killStep(s.last, 2); // jogo reaberto: contador do engine zerou
  assert.equal(s.gained, 2);
  assert.deepEqual(killStep(5, undefined), { gained: 0, last: 5 }); // engine sem kills
});
