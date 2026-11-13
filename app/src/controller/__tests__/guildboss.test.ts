import assert from "node:assert";
import { test } from "node:test";

import {
  DEFAULT_GUILD_BOSS_CONFIG,
  ENTER_BOSS_BODY,
  EXIT_REWARD_BODY,
  type GuildBossSnapshot,
  LEAVE_TEAM_BODY,
  nextGuildBossStep,
} from "../guildboss";

function baseSnap(p: Partial<GuildBossSnapshot> = {}): GuildBossSnapshot {
  return {
    inWorld: true,
    inGuild: true,
    inTeam: false,
    sceneId: 3,
    inBossScene: false,
    bossOpen: true,
    timeLeft: 600,
    goldBuffCount: 0,
    inSafeRegion: false,
    wipeActive: false,
    rewardVisible: false,
    dead: false,
    autoPlay: true,
    gold: 500000,
    ...p,
  };
}

test("fora da guilda conclui direto", () => {
  const step = nextGuildBossStep(baseSnap({ inGuild: false }), DEFAULT_GUILD_BOSS_CONFIG);
  assert.equal(step.kind, "done");
});

test("se estiver em equipe, sai da party primeiro", () => {
  const step = nextGuildBossStep(baseSnap({ inTeam: true }), DEFAULT_GUILD_BOSS_CONFIG);
  assert.equal(step.kind, "act");
  if (step.kind === "act") {
    assert.equal(step.id, "leave-team");
    assert.equal(step.body, LEAVE_TEAM_BODY);
  }
});

test("fora da arena abre o painel e entra pelo Challenge", () => {
  const stepOpen = nextGuildBossStep(baseSnap(), DEFAULT_GUILD_BOSS_CONFIG);
  assert.equal(stepOpen.kind, "act");
  if (stepOpen.kind === "act") assert.equal(stepOpen.id, "open-view");

  const triedOpen = new Set(["open-view"]);
  const stepEnter = nextGuildBossStep(baseSnap(), DEFAULT_GUILD_BOSS_CONFIG, triedOpen);
  assert.equal(stepEnter.kind, "act");
  if (stepEnter.kind === "act") {
    assert.equal(stepEnter.id, "enter");
    assert.equal(stepEnter.body, ENTER_BOSS_BODY);
  }
});

test("evento fechado: para na hora e nao sai da party", () => {
  const step = nextGuildBossStep(baseSnap({ bossOpen: false, timeLeft: 0, inTeam: true }), DEFAULT_GUILD_BOSS_CONFIG);
  assert.equal(step.kind, "closed");
  // ja na arena conta como aberto (o painel pode ter fechado)
  const inArena = nextGuildBossStep(baseSnap({ bossOpen: false, inBossScene: true, sceneId: 2200 }), DEFAULT_GUILD_BOSS_CONFIG);
  assert.notEqual(inArena.kind, "closed");
});

test("dentro da arena: combate e tela de recompensa ao finalizar", () => {
  const arenaSnap = baseSnap({ inBossScene: true, sceneId: 2200, autoPlay: false });
  // Sem autoPlay: manda ligar auto-ataque
  const fightStep = nextGuildBossStep(arenaSnap, DEFAULT_GUILD_BOSS_CONFIG);
  assert.equal(fightStep.kind, "act");
  if (fightStep.kind === "act") {
    assert.equal(stepBody(fightStep), '{"on":1}');
  }

  // Fim do boss: tela de recompensa visivel -> clica no botao Continue
  const endStep = nextGuildBossStep(baseSnap({ inBossScene: true, sceneId: 2200, rewardVisible: true }), DEFAULT_GUILD_BOSS_CONFIG);
  assert.equal(endStep.kind, "act");
  if (endStep.kind === "act") {
    assert.equal(endStep.id, "reward");
    assert.equal(endStep.body, EXIT_REWARD_BODY);
  }
});

test("dentro da arena: desvio da safe zone durante golpe supremo", () => {
  const wipeSnap = baseSnap({
    inBossScene: true,
    sceneId: 2200,
    wipeActive: true,
    inSafeRegion: false,
    safePos: [100, 20, 200],
  });
  const step = nextGuildBossStep(wipeSnap, DEFAULT_GUILD_BOSS_CONFIG);
  assert.equal(step.kind, "move");
  if (step.kind === "move") {
    assert.deepEqual(step.pos, [100, 20, 200]);
  }

  // Ja dentro da safe zone: segura na defensiva
  const safeSnap = baseSnap({
    inBossScene: true,
    sceneId: 2200,
    wipeActive: true,
    inSafeRegion: true,
    autoPlay: false,
  });
  const safeStep = nextGuildBossStep(safeSnap, DEFAULT_GUILD_BOSS_CONFIG);
  assert.equal(safeStep.kind, "wait");
});

function stepBody(s: ReturnType<typeof nextGuildBossStep>): string {
  return s.kind === "act" ? s.body : "";
}

