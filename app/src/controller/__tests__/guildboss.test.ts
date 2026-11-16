import assert from "node:assert";
import { test } from "node:test";

import {
  afterGuildBossStep,
  DEFAULT_GUILD_BOSS_CONFIG,
  ENTER_BOSS_BODY,
  ENTER_MAX_TRIES,
  ENTER_RETRY_MS,
  EXIT_REWARD_BODY,
  type GuildBossSnapshot,
  guildBossOpenNow,
  HUNT_OFF_BODY,
  HUNT_ON_BODY,
  LEAVE_TEAM_BODY,
  MOVE_RETRY_MS,
  nearestZone,
  newGuildBossMemory,
  nextGuildBossStep,
  readSafeZones,
  type SafeZone,
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
  return snap({ inBossScene: true, sceneId: 5, sceneType: 11, zones: ZONES, pos: [505, 127, 190], safeZoneOpen: false, ...p });
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

test("guild boss: safe zone aberta para o auto-play, corre pra zona mais perto, espera e religa quando fecha", () => {
  let m = newGuildBossMemory();
  const off = nextGuildBossStep(arena({ safeZoneOpen: true }), cfg, m, T);
  assert.equal(off.kind === "act" && off.body, HUNT_OFF_BODY);
  const mv = nextGuildBossStep(arena({ safeZoneOpen: true, autoPlay: false }), cfg, m, T);
  assert.deepEqual(mv.kind === "move" && mv.pos, [480, 127, 160]); // (505,190) fica mais perto de (480,160)
  m = afterGuildBossStep(m, mv, T);
  assert.equal(nextGuildBossStep(arena({ safeZoneOpen: true, autoPlay: false }), cfg, m, T + MOVE_RETRY_MS - 1).kind, "wait");
  assert.equal(nextGuildBossStep(arena({ safeZoneOpen: true, autoPlay: false }), cfg, m, T + MOVE_RETRY_MS).kind, "move");
  const inside = nextGuildBossStep(arena({ safeZoneOpen: true, autoPlay: false, pos: [481, 127, 161] }), cfg, m, T);
  assert.equal(inside.kind, "wait");
  const back = nextGuildBossStep(arena({ safeZoneOpen: false, autoPlay: false, pos: [481, 127, 161] }), cfg, m, T);
  assert.equal(back.kind === "act" && back.body, HUNT_ON_BODY);
  // Sem a opcao de desviar, ou sem o aviso lido (engine antigo), segue lutando.
  assert.equal(nextGuildBossStep(arena({ safeZoneOpen: true }), { ...cfg, dodgeSupreme: false }, m, T).kind, "wait");
  assert.equal(nextGuildBossStep(arena({ safeZoneOpen: undefined }), cfg, m, T).kind, "wait");
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
