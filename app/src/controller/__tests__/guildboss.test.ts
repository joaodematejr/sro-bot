import assert from "node:assert";
import { test } from "node:test";

import {
  afterGuildBossStep,
  DEFAULT_GUILD_BOSS_CONFIG,
  DODGE_HOLD_MS,
  ENTER_BOSS_BODY,
  ENTER_MAX_TRIES,
  ENTER_RETRY_MS,
  EXIT_REWARD_BODY,
  type GuildBossSnapshot,
  guildBossOpenNow,
  HUNT_OFF_BODY,
  HUNT_ON_BODY,
  LEAVE_ARENA_BODY,
  LEAVE_TEAM_BODY,
  LEVEL_CMD_NOTICE,
  MOVE_RETRY_MS,
  nearestZone,
  newGuildBossMemory,
  nextGuildBossStep,
  readSafeZones,
  type SafeZone,
  trackGuildBossWarning,
} from "../guildboss";

// As 4 safe zones da cena 5, lidas ao vivo em 2026-11-16.
const ZONES: SafeZone[] = [
  { x: 480, y: 127, z: 160, r: 6 },
  { x: 480, y: 126.56, z: 235, r: 6 },
  { x: 533, y: 126.56, z: 220, r: 6 },
  { x: 533, y: 126.56, z: 148, r: 6 },
];

const cfg = DEFAULT_GUILD_BOSS_CONFIG;
const T = 1_000_000;

function snap(p: Partial<GuildBossSnapshot> = {}): GuildBossSnapshot {
  return {
    inWorld: true,
    inGuild: true,
    inTeam: false,
    sceneId: 100003,
    sceneType: 76,
    inBossScene: false,
    canFight: true,
    zones: [],
    rewardVisible: false,
    dead: false,
    autoPlay: true,
    ...p,
  };
}

function arena(p: Partial<GuildBossSnapshot> = {}): GuildBossSnapshot {
  return snap({ inBossScene: true, sceneId: 5, sceneType: 11, zones: ZONES, pos: [505, 127, 190], noticeOn: false, scriptCount: 16, scriptCmd: 24, ...p });
}

test("guild boss: fora da guilda conclui; fechado nao mexe nem na party", () => {
  assert.equal(nextGuildBossStep(snap({ inGuild: false }), cfg, newGuildBossMemory(), T).kind, "done");
  assert.equal(nextGuildBossStep(snap({ canFight: false, inTeam: true }), cfg, newGuildBossMemory(), T).kind, "closed");
});

test("guild boss: aberto sai da party uma vez e entra pelo XGuildDragonDocument, tentando de novo", () => {
  let m = newGuildBossMemory();
  const leave = nextGuildBossStep(snap({ inTeam: true }), cfg, m, T);
  assert.equal(leave.kind === "act" && leave.body, LEAVE_TEAM_BODY);
  m = afterGuildBossStep(m, leave, T);
  assert.equal(nextGuildBossStep(snap({ inTeam: true }), cfg, m, T).kind, "wait");
  const enter = nextGuildBossStep(snap(), cfg, m, T);
  assert.equal(enter.kind === "act" && enter.body, ENTER_BOSS_BODY);
  assert.equal(ENTER_BOSS_BODY, "calls XGuildDragonDocument ReqEnterScene 0");
  m = afterGuildBossStep(m, enter, T);
  assert.equal(nextGuildBossStep(snap(), cfg, m, T + ENTER_RETRY_MS - 1).kind, "wait");
  assert.equal(nextGuildBossStep(snap(), cfg, m, T + ENTER_RETRY_MS).kind, "act");
  m = { ...m, enterTries: ENTER_MAX_TRIES, lastEnterAt: -Infinity };
  assert.equal(nextGuildBossStep(snap(), cfg, m, T).kind, "fail");
  // Do Guild Hall o jogo recusa.
  assert.equal(nextGuildBossStep(snap({ sceneType: 10 }), cfg, newGuildBossMemory(), T).kind, "fail");
});

test("guild boss: na arena liga o auto-play; tela de fim sai uma vez", () => {
  const on = nextGuildBossStep(arena({ autoPlay: false }), cfg, newGuildBossMemory(), T);
  assert.equal(on.kind === "act" && on.body, HUNT_ON_BODY);
  assert.equal(nextGuildBossStep(arena(), cfg, newGuildBossMemory(), T).kind, "wait");
  let m = newGuildBossMemory();
  const end = nextGuildBossStep(arena({ rewardVisible: true }), cfg, m, T);
  assert.equal(end.kind === "act" && end.body, EXIT_REWARD_BODY);
  m = afterGuildBossStep(m, end, T);
  assert.notEqual(nextGuildBossStep(arena({ rewardVisible: true }), cfg, m, T).kind === "act" && "reward", "reward");
});

test("guild boss: o aviso vem da notice na tela ou de um Notice novo no script da arena", () => {
  let m = trackGuildBossWarning(newGuildBossMemory(), arena(), T);
  assert.equal(m.lastScriptCount, 16);
  assert.ok(m.dodgeUntil < T); // primeira leitura do contador nao e aviso
  // Comando novo que nao e Notice (a fala do NPC a cada 30 s): segue lutando.
  m = trackGuildBossWarning(m, arena({ scriptCount: 17, scriptCmd: 24 }), T);
  assert.ok(m.dodgeUntil < T);
  // Comando Notice novo: aviso, mesmo antes da notice aparecer na tela.
  const n = trackGuildBossWarning(m, arena({ scriptCount: 18, scriptCmd: LEVEL_CMD_NOTICE }), T);
  assert.equal(n.dodgeUntil, T + DODGE_HOLD_MS);
  // Notice na tela empurra a espera enquanto aparece.
  const v = trackGuildBossWarning(n, arena({ scriptCount: 18, scriptCmd: LEVEL_CMD_NOTICE, noticeOn: true }), T + 3000);
  assert.equal(v.dodgeUntil, T + 3000 + DODGE_HOLD_MS);
  // Fora da arena nao mexe.
  assert.equal(trackGuildBossWarning(m, snap({ noticeOn: true }), T), m);
});

test("guild boss: no aviso para o auto-play, corre pra zona mais perto, espera e religa depois", () => {
  // O estatico da safe zone ficou ligado a luta inteira: sem aviso, luta.
  assert.equal(nextGuildBossStep(arena(), cfg, newGuildBossMemory(), T).kind, "wait");
  let m = trackGuildBossWarning(newGuildBossMemory(), arena({ noticeOn: true }), T);
  const off = nextGuildBossStep(arena({ noticeOn: true }), cfg, m, T);
  assert.equal(off.kind === "act" && off.body, HUNT_OFF_BODY);
  const mv = nextGuildBossStep(arena({ autoPlay: false }), cfg, m, T);
  assert.deepEqual(mv.kind === "move" && mv.pos, [480, 127, 160]); // (505,190) fica mais perto de (480,160)
  m = afterGuildBossStep(m, mv, T);
  assert.equal(nextGuildBossStep(arena({ autoPlay: false }), cfg, m, T + MOVE_RETRY_MS - 1).kind, "wait");
  assert.equal(nextGuildBossStep(arena({ autoPlay: false }), cfg, m, T + MOVE_RETRY_MS).kind, "move");
  const inside = nextGuildBossStep(arena({ autoPlay: false, pos: [481, 127, 161] }), cfg, m, T + 5000);
  assert.equal(inside.kind, "wait");
  // Passou a espera: religa o auto-play e a IA volta pro boss.
  const back = nextGuildBossStep(arena({ autoPlay: false, pos: [481, 127, 161] }), cfg, m, T + DODGE_HOLD_MS);
  assert.equal(back.kind === "act" && back.body, HUNT_ON_BODY);
  // Sem a opcao de desviar, segue lutando.
  assert.equal(nextGuildBossStep(arena(), { ...cfg, dodgeSupreme: false }, m, T).kind, "wait");
});

test("guild boss: evento fechado com o char na arena sai uma vez", () => {
  let m = newGuildBossMemory();
  const leave = nextGuildBossStep(arena({ canFight: false }), cfg, m, T);
  assert.equal(leave.kind === "act" && leave.body, LEAVE_ARENA_BODY);
  m = afterGuildBossStep(m, leave, T);
  assert.equal(nextGuildBossStep(arena({ canFight: false }), cfg, m, T).kind, "wait");
  // Morto espera o renascer antes; a tela de fim vem antes de sair.
  assert.equal(nextGuildBossStep(arena({ canFight: false, dead: true }), cfg, newGuildBossMemory(), T).kind, "wait");
  const rw = nextGuildBossStep(arena({ canFight: false, rewardVisible: true }), cfg, newGuildBossMemory(), T);
  assert.equal(rw.kind === "act" && rw.body, EXIT_REWARD_BODY);
});

test("guild boss: dentro da zona com folga da borda", () => {
  assert.equal(nearestZone([480, 127, 164], ZONES)?.inside, true); // 4 m do centro, raio 6
  assert.equal(nearestZone([480, 127, 165], ZONES)?.inside, false); // 5 m: na borda conta como fora
  assert.equal(nearestZone(undefined, ZONES), null);
});

test("guild boss: le as zonas da RegionList (floats pelo GETP) e o aberto pelo bCanFight", async () => {
  const fl = (x: number) => {
    const d = new DataView(new ArrayBuffer(4));
    d.setFloat32(0, x, true);
    return d.getInt32(0, true);
  };
  const L = "XSafeZoneDocument GetRegionListBySceneId:5";
  const v: Record<string, Record<string, unknown>> = {
    [`${L} get_Count`]: { ok: true, int: 2 },
    [`${L} get_Item:0 RegionType`]: { ok: true, int: 1 }, // retangulo: fora
    [`${L} get_Item:1 RegionType`]: { ok: true, int: 2 },
    [`${L} get_Item:1 RegionCategory`]: { ok: true, int: 1 },
    [`${L} get_Item:1 RegionPos [#0]`]: { ok: true, int: fl(533) },
    [`${L} get_Item:1 RegionPos [#1]`]: { ok: true, int: fl(126.56) },
    [`${L} get_Item:1 RegionPos [#2]`]: { ok: true, int: fl(148) },
    [`${L} get_Item:1 RegionSize [#0]`]: { ok: true, int: fl(6) },
    "XGuildDragonDocument get_bCanFight": { ok: true, bool: true },
  };
  const q = async (_t: string, b: string) => v[b] ?? { ok: false };
  const z = await readSafeZones(q, 5);
  assert.equal(z.length, 1);
  assert.equal(z[0].x, 533);
  assert.ok(Math.abs(z[0].y - 126.56) < 0.01);
  assert.equal(await guildBossOpenNow(q), true);
});
