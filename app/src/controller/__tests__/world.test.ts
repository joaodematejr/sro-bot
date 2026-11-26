import assert from "node:assert";
import { test } from "node:test";

import {
  canLeaveScene,
  channelChangeCheck,
  channelRows,
  durationText,
  leaveSceneCheck,
  lineStateText,
  msToDayReset,
  readWorld,
  serverClock,
  type WorldActionState,
} from "../world";

// Jangan: canais 1..4 nas linhas 101..104, o 4 cheio, o 3 Activity Channel; char no 2.
const JANGAN = {
  channel: 2,
  lines: { 1: 101, 2: 102, 3: 103, 4: 104 },
  info: { 1: { state: 3, activity: false }, 2: { state: 2, activity: false }, 3: { state: 3, activity: true }, 4: { state: 1, activity: false } },
};
const free: WorldActionState = { inWorld: true, dead: false, inCombat: false };

test("relogio do servidor no fuso dele", () => {
  // 2026-11-26 12:34:56 UTC = 20:34:56 no servidor (UTC+8).
  const now = Date.UTC(2026, 10, 26, 12, 34, 56);
  assert.deepStrictEqual(serverClock(now, 8), { time: "20:34:56", zone: "UTC+8" });
  assert.deepStrictEqual(serverClock(now, -3), { time: "09:34:56", zone: "UTC-3" });
  // Passa da meia-noite do servidor.
  assert.strictEqual(serverClock(Date.UTC(2026, 10, 26, 17, 0, 0), 8).time, "01:00:00");
});

test("virada do dia do jogo as 05:00 do servidor (21:00 UTC)", () => {
  assert.strictEqual(msToDayReset(Date.UTC(2026, 10, 26, 20, 0, 0), 8), 3600000);
  // Logo depois da virada: falta o dia quase inteiro.
  assert.strictEqual(msToDayReset(Date.UTC(2026, 10, 26, 21, 0, 1), 8), 86400000 - 1000);
  // Exatamente na virada conta o dia seguinte.
  assert.strictEqual(msToDayReset(Date.UTC(2026, 10, 26, 21, 0, 0), 8), 86400000);
  assert.strictEqual(durationText(3600000 + 5 * 60000), "1h 05min");
  assert.strictEqual(durationText(59 * 1000), "1min");
  assert.strictEqual(durationText(0), "0min");
});

test("so sai de cena em instancia ou na torre", () => {
  assert.strictEqual(canLeaveScene(4, 10), true); // Guild Hall
  assert.strictEqual(canLeaveScene(2200), true); // arena da Sekhmet
  assert.strictEqual(canLeaveScene(102014, 16), true); // torre, andar 14
  assert.strictEqual(canLeaveScene(100001, 76), false); // Jangan
  assert.strictEqual(canLeaveScene(100001), false);
  assert.strictEqual(canLeaveScene(-1), false);
  assert.strictEqual(canLeaveScene(undefined, 16), false);
  assert.strictEqual(leaveSceneCheck(4, 10, free), null);
  assert.match(String(leaveSceneCheck(100001, 76, free)), /mundo aberto/);
  assert.match(String(leaveSceneCheck(4, 10, { ...free, busy: "Guild Boss" })), /Guild Boss rodando/);
  assert.match(String(leaveSceneCheck(4, 10, { ...free, dead: true })), /morto/);
  assert.match(String(leaveSceneCheck(4, 10, { ...free, inWorld: false })), /nao conectado/);
});

test("lista de canais em ordem, com lotacao e o atual", () => {
  const rows = channelRows(JANGAN);
  assert.deepStrictEqual(rows.map((r) => [r.channel, r.line, r.current]), [[1, 101, false], [2, 102, true], [3, 103, false], [4, 104, false]]);
  assert.strictEqual(rows[2].activity, true);
  assert.strictEqual(lineStateText(rows[3].state), "cheio");
  assert.strictEqual(lineStateText(rows[1].state), "lotado");
  assert.strictEqual(lineStateText(undefined), "");
});

test("troca de canal na mao: so fora de combate, pra canal que existe e nao esta cheio", () => {
  const rows = channelRows(JANGAN);
  assert.deepStrictEqual(channelChangeCheck(rows, 1, free), { ok: true, line: 101 });
  // Activity Channel e permitido na mao (quem escolhe e o usuario).
  assert.deepStrictEqual(channelChangeCheck(rows, 3, free), { ok: true, line: 103 });
  const erro = (target: number, s: WorldActionState) => {
    const r = channelChangeCheck(rows, target, s);
    return r.ok ? "" : r.erro;
  };
  assert.match(erro(2, free), /ja esta no canal 2/);
  assert.match(erro(4, free), /cheio/);
  assert.match(erro(9, free), /nao existe/);
  assert.match(erro(1, { ...free, inCombat: true }), /em combate/);
  assert.match(erro(1, { ...free, dead: true }), /morto/);
  assert.match(erro(1, { ...free, busy: "Treino" }), /Treino rodando/);
  assert.match(erro(1, { ...free, inWorld: false }), /nao conectado/);
});

test("leitura: canal so no mundo aberto; fuso padrao sem leitura", async () => {
  const sent: string[] = [];
  const fake = (vals: Record<string, unknown>) => async (tag: string, body: string) => {
    sent.push(`${tag} ${body}`);
    const v = vals[body];
    return v === undefined ? {} : typeof v === "boolean" ? { ok: true, bool: v } : { ok: true, int: v };
  };
  const inHall = await readWorld(fake({ "XScene get_SceneID": 4, "XScene _scene_type": 10 }));
  assert.deepStrictEqual(inHall, { scene: 4, sceneType: 10, tz: 8, channels: [] });
  const inTower = await readWorld(fake({ "XScene get_SceneID": 102014, "XScene _scene_type": 16, "XServerTimeMgr get_ServerTimeZone": 8 }));
  assert.deepStrictEqual(inTower, { scene: 102014, sceneType: 16, tz: 8, channels: [] });
  assert.ok(!sent.some((s) => s.includes("ChannelDocument")), "instancia e torre nao pedem a lista de canais");

  const vals: Record<string, unknown> = {
    "XScene get_SceneID": 100001,
    "XScene _scene_type": 76,
    "XServerTimeMgr get_ServerTimeZone": 8,
    "ChannelDocument get_CurrentLineID": 102,
    "ChannelDocument _listLine get_Count": 2,
    "ChannelDocument LineIDToLine:101": 1,
    "ChannelDocument LineIDToLine:102": 2,
    "ChannelDocument _listLine get_Item:0 _line+4": 101,
    "ChannelDocument _listLine get_Item:0 _state+4": 3,
    "ChannelDocument _listLine get_Item:0 get_is_activity_line": false,
    "ChannelDocument _listLine get_Item:1 _line+4": 102,
    "ChannelDocument _listLine get_Item:1 _state+4": 2,
    "ChannelDocument _listLine get_Item:1 get_is_activity_line": false,
  };
  const w = await readWorld(fake(vals));
  assert.strictEqual(w.channel, 2);
  assert.strictEqual(w.sceneType, 76);
  assert.deepStrictEqual(w.channels.map((r) => [r.channel, r.line, r.current]), [[1, 101, false], [2, 102, true]]);
});
