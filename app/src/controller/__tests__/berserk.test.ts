import assert from "node:assert";
import { test } from "node:test";

import { BERSERK_CLICK, BERSERK_VISIBLE, shouldBerserk } from "../berserk";

test("Berserk: so em combate, vivo, em mundo e fora de viagem", () => {
  assert.equal(shouldBerserk({ inWorld: true, dead: false, inCombat: true }, false), true);
  assert.equal(shouldBerserk({ inWorld: true, dead: false, inCombat: false }, false), false); // sem monstro: desperdica
  assert.equal(shouldBerserk({ inWorld: true, dead: false, inCombat: true }, true), false); // viajando pro ponto
  assert.equal(shouldBerserk({ inWorld: true, dead: true, inCombat: true }, false), false);
  assert.equal(shouldBerserk(null, false), false);
});

test("Berserk: le o botao e chama o metodo do toque (sem tap)", () => {
  assert.equal(BERSERK_VISIBLE, "BattleMain m_uiBehaviour m_BerserkerBtn IsVisible");
  assert.match(BERSERK_CLICK, /^callx BattleMain OnBerserkerButtonClick 1 -- o:BattleMain\|m_uiBehaviour\|m_BerserkerBtn$/);
});

test("Devil: clica pelo metodo uma vez por minuto (recarga de ~30 min nao e lida)", async () => {
  const { DEVIL_CLICK, DEVIL_EVERY_MS } = await import("../berserk");
  assert.equal(DEVIL_CLICK, "callx BattleMain OnNasrunButtonClick 1 -- o:BattleMain|m_uiBehaviour|m_NasrunBtn");
  assert.equal(DEVIL_EVERY_MS, 60_000);
});

test("Barra do Berserk: le os pontos de raiva e mostra o estado", async () => {
  const { RAGE_CD, RAGE_MAX, RAGE_POINT, ragePct, rageText, readRage } = await import("../berserk");
  const fake = (vals: Record<string, number | undefined>) => async (_t: string, body: string) =>
    vals[body] === undefined ? { ok: false } : { ok: true, int: vals[body] };
  assert.deepEqual(await readRage(fake({ [RAGE_POINT]: 3, [RAGE_MAX]: 5, [RAGE_CD]: 0 })), { point: 3, max: 5, active: false });
  assert.deepEqual(await readRage(fake({ [RAGE_POINT]: 0, [RAGE_MAX]: 5, [RAGE_CD]: 6 })), { point: 0, max: 5, active: true });
  assert.equal(await readRage(fake({ [RAGE_POINT]: -1, [RAGE_MAX]: 5 })), undefined); // antes do servidor mandar
  assert.equal(await readRage(fake({})), undefined);
  assert.equal(rageText({ point: 3, max: 5, active: false }), "3/5");
  assert.equal(rageText({ point: 5, max: 5, active: false }), "5/5 pronto");
  assert.equal(rageText({ point: 0, max: 5, active: true }), "ativo");
  assert.equal(rageText(undefined), "-");
  assert.equal(ragePct({ point: 2, max: 5, active: false }), 40);
  assert.equal(ragePct({ point: 0, max: 5, active: true }), 100);
});
