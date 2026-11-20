// Guild Boss 100% por metodo e guiado por estado. Logica pura, sem IO; o main faz
// as leituras e manda os comandos.
//
// Lido no XMainClient.dll descompilado e conferido ao vivo (so leitura) em 2026-11-16.
// A primeira versao usava o XWorldBossDocument, que e o World Boss (outro evento):
// por isso nao entrava quando o Guild Boss abria.
//   Aberto       -> XGuildDragonDocument get_bCanFight (o servidor liga pelo
//                   HintNotify do XSys_GuildDragon 85, o mesmo do ponto vermelho).
//   Arena        -> XScene get_SceneType == 11 (SCENE_GUILD_BOSS); a cena e a
//                   XGlobalConfig GetInt:"GuildBossSceneID" (5).
//   Entrar       -> XGuildDragonDocument ReqEnterScene (o que o Challenge do
//                   XGuildDragonView chama, depois de sair da party). Nao entra do
//                   Guild Hall (SCENE_GUILD_HALL 10) nem com o job ativo.
//   Safe zone    -> os circulos da RegionList da cena (GetRegionListBySceneId:
//                   RegionType 2, RegionPos x/y/z, RegionSize[0] raio): na cena 5 sao
//                   4, raio 6. Dentro do circulo o jogo bloqueia as skills (AI
//                   BlockSkill), e o get_IsInSafeRegion do jogo nunca muda: o "dentro"
//                   e a distancia da posicao ao centro. O estatico
//                   XSafeZoneDocument _isEffectSafeZoneActive NAO serve de aviso: em
//                   2026-11-18 ficou ligado a luta inteira (12:08 a 12:20 UTC), e
//                   seguir ele deixava o char parado no circulo sem atacar.
//   Aviso        -> antes do golpe forte o script da arena mostra a notice "<boss> is
//                   going to destroy the place, quickly find a safezone" na
//                   BattleMain (Level_Cmd_Notice, 4 s). Le o BattleMain NoticeTime
//                   (diferente de 0 enquanto a notice aparece) e o XLevelScriptMgr
//                   (CommandCount sobe a cada comando; _currentCmd cmd 6 = Notice).
//                   Em 2026-11-18 o golpe (skill 975472616 do JeonUk) tirou 19 mil
//                   de HP em menos de 1 s no meio da arena.
//   Fim          -> evento fechado (bCanFight falso) com o char ainda na arena:
//                   XGuildDragonDocument ReqQuitScene (o XScene ReqLeaveScene).
//   Tela de fim  -> LevelRewardGuildBossHandler OnContinueClick (sem prova ao vivo).
//   Morte        -> na arena nao tira EXP e o jogo revive no lugar em ~20 s (ao vivo
//                   em 2026-11-20). Char fraco pro boss (Lv.87 contra o JeonUk Lv.155)
//                   morre a cada ~35 s por golpe comum; maxDeaths sai da arena depois
//                   de N mortes pra voltar ao Treino.

export const SCENE_TYPE_GUILD_BOSS = 11;
export const SCENE_TYPE_GUILD_HALL = 10;
export const DEFAULT_GUILD_BOSS_SCENE = 5;

export const LEAVE_TEAM_BODY = "callx XTeamDocument ReqTeamOp 7 -- i:3 q:0 n i:1 s: i:0 u:0";
export const ENTER_BOSS_BODY = "calls XGuildDragonDocument ReqEnterScene 0";
export const EXIT_REWARD_BODY = "callp XLevelRewardView _DlgHandler OnContinueClick 1";
export const LEAVE_ARENA_BODY = "calls XGuildDragonDocument ReqQuitScene 0";
// Buff de ataque da arena: o botao de gold do BattleWorldBossHandler (indice 0,
// custo XGlobalConfig GuildBossConsume, 20.000 gold lido em 2026-11-19). O de Silk
// e outro botao e nunca e usado. Limite: GetMaxEncourageTimes (10).
export const ENCOURAGE_GOLD_BODY = "calls XGuildDragonDocument ReqEncourage 0";
export const ENCOURAGE_COUNT_BODY = "XGuildDragonDocument get_EncourageCount";
export const ENCOURAGE_MAX_BODY = "XGuildDragonDocument GetMaxEncourageTimes";
export const BUFF_RETRY_MS = 3_000;
// Pedidos sem a conta subir (gold acabou, servidor recusou): desiste.
export const BUFF_EXTRA_TRIES = 3;
export const NOTICE_TIME_BODY = "BattleMain NoticeTime";
export const SCRIPT_COUNT_BODY = "XLevelScriptMgr CommandCount";
export const SCRIPT_CMD_BODY = "XLevelScriptMgr _currentCmd cmd";
// LevelCmd.Level_Cmd_Notice.
export const LEVEL_CMD_NOTICE = 6;
export const HUNT_ON_BODY = '{"on":1}';
export const HUNT_OFF_BODY = '{"on":0}';

// Nova tentativa de entrar se a cena nao mudou.
export const ENTER_RETRY_MS = 10_000;
export const ENTER_MAX_TRIES = 6;
// Navigate de novo enquanto nao chega (o caminho pode ser cortado pelo boss).
export const MOVE_RETRY_MS = 2_000;
// Margem pra dentro do raio: parar na borda deixa o char meio fora.
export const SAFE_MARGIN = 1.5;
// Fica no circulo ate esse tempo depois do ultimo aviso visto (a notice dura 4 s e
// o golpe vem depois dela); passou, religa o auto-play e volta pro boss.
export const DODGE_HOLD_MS = 10_000;
// Nova tentativa de sair da arena se a cena nao mudou.
export const LEAVE_RETRY_MS = 10_000;
export const LEAVE_MAX_TRIES = 3;

export interface GuildBossConfig {
  enabled: boolean;
  buffs?: number; // buffs de ataque por gold a comprar na arena (0 = nenhum; padrao 0)
  dodgeSupreme: boolean; // corre pra safe zone no aviso do golpe forte
  autoFight: boolean; // liga o auto-play dentro da arena
  maxDeaths?: number; // sai da arena depois de N mortes (0 ou ausente = fica ate o fim)
}

export const DEFAULT_GUILD_BOSS_CONFIG: GuildBossConfig = {
  enabled: true,
  dodgeSupreme: true,
  autoFight: true,
};

export interface SafeZone {
  x: number;
  y: number;
  z: number;
  r: number;
}

export interface GuildBossSnapshot {
  inWorld: boolean;
  inGuild: boolean;
  inTeam: boolean;
  sceneId: number;
  sceneType: number;
  inBossScene: boolean;
  canFight: boolean; // evento aberto com o boss vivo
  noticeOn?: boolean; // notice da BattleMain na tela agora (undefined = nao lido)
  scriptCount?: number; // XLevelScriptMgr CommandCount
  scriptCmd?: number; // tipo do comando atual do script da arena
  encourageCount?: number; // buffs de gold ja comprados nesta arena
  encourageMax?: number; // limite do jogo
  zones: SafeZone[];
  pos?: [number, number, number];
  rewardVisible: boolean;
  dead: boolean;
  autoPlay: boolean;
}

export interface GuildBossMemory {
  enterTries: number;
  lastEnterAt: number;
  lastMoveAt: number;
  leftTeam: boolean;
  rewardTried: boolean;
  leaveTries: number;
  lastLeaveAt: number;
  deaths: number; // mortes nesta arena
  wasDead: boolean;
  buffTries: number;
  lastBuffAt: number;
  lastScriptCount: number; // -1 = ainda nao lido
  dodgeUntil: number; // fica no circulo ate aqui
}

export function newGuildBossMemory(): GuildBossMemory {
  return {
    enterTries: 0,
    lastEnterAt: -Infinity,
    lastMoveAt: -Infinity,
    leftTeam: false,
    rewardTried: false,
    leaveTries: 0,
    lastLeaveAt: -Infinity,
    deaths: 0,
    wasDead: false,
    lastScriptCount: -1,
    dodgeUntil: -Infinity,
    buffTries: 0,
    lastBuffAt: -Infinity,
  };
}

// Aviso do golpe forte: notice na tela ou um comando Notice novo no script da
// arena. Cada aviso empurra o fim da espera no circulo.
export function trackGuildBossWarning(m: GuildBossMemory, s: GuildBossSnapshot | null, now: number): GuildBossMemory {
  if (!s?.inBossScene) return m;
  const newNotice =
    s.scriptCount !== undefined && m.lastScriptCount >= 0 && s.scriptCount !== m.lastScriptCount && s.scriptCmd === LEVEL_CMD_NOTICE;
  return {
    ...m,
    lastScriptCount: s.scriptCount ?? m.lastScriptCount,
    dodgeUntil: s.noticeOn === true || newNotice ? Math.max(m.dodgeUntil, now + DODGE_HOLD_MS) : m.dodgeUntil,
  };
}

// Conta as mortes na arena (a passagem de vivo pra morto).
export function trackGuildBossDeath(m: GuildBossMemory, s: GuildBossSnapshot | null): GuildBossMemory {
  if (!s?.inBossScene || s.dead === m.wasDead) return m;
  return { ...m, wasDead: s.dead, deaths: s.dead ? m.deaths + 1 : m.deaths };
}

export type GuildBossStep =
  | { kind: "done"; reason: string }
  | { kind: "wait"; reason: string }
  | { kind: "act"; id: string; name: string; tag: string; body: string }
  | { kind: "move"; name: string; pos: [number, number, number] }
  | { kind: "fail"; reason: string }
  | { kind: "closed"; reason: string }; // evento fechado: nada a fazer agora (nem sair da party)

export function isBossScene(sceneType: number, sceneId: number, bossScene = DEFAULT_GUILD_BOSS_SCENE): boolean {
  return sceneType === SCENE_TYPE_GUILD_BOSS || sceneId === bossScene;
}

// Zona mais perto (no plano x/z) e se o char ja esta dentro dela.
export function nearestZone(pos: [number, number, number] | undefined, zones: SafeZone[]): { zone: SafeZone; inside: boolean } | null {
  if (!pos || !zones.length) return null;
  let best = zones[0];
  let bd = Infinity;
  for (const z of zones) {
    const d = Math.hypot(pos[0] - z.x, pos[2] - z.z);
    if (d < bd) {
      bd = d;
      best = z;
    }
  }
  return { zone: best, inside: bd <= Math.max(best.r - SAFE_MARGIN, 0.5) };
}

export function buffStep(s: GuildBossSnapshot, cfg: GuildBossConfig, m: GuildBossMemory, now: number): GuildBossStep | null {
  const want = Math.min(Math.max(0, Math.floor(cfg.buffs ?? 0)), s.encourageMax ?? 0);
  if (want <= 0 || s.encourageCount === undefined || s.encourageCount >= want) return null;
  if (now - m.lastBuffAt < BUFF_RETRY_MS || m.buffTries >= want + BUFF_EXTRA_TRIES) return null;
  return {
    kind: "act", id: "buff", tag: "SKIL", body: ENCOURAGE_GOLD_BODY,
    name: `comprando buff de ataque por gold (${s.encourageCount + 1}/${want})`,
  };
}

export function nextGuildBossStep(s: GuildBossSnapshot | null, cfg: GuildBossConfig, m: GuildBossMemory, now: number): GuildBossStep {
  if (!s) return { kind: "fail", reason: "engine fora" };
  if (!s.inWorld) return { kind: "wait", reason: "aguardando char entrar em mundo..." };
  if (!s.inGuild) return { kind: "done", reason: "char sem guilda" };

  if (s.inBossScene) {
    if (s.rewardVisible && !m.rewardTried)
      return { kind: "act", id: "reward", name: "sair da arena do Guild Boss e receber recompensas", tag: "SKIL", body: EXIT_REWARD_BODY };
    if (s.dead) return { kind: "wait", reason: "char abatido na arena do Boss; aguardando..." };
    // Evento fechado com o char ainda na arena (em 2026-11-18 ficou la depois do fim),
    // ou o limite de mortes: sai depois de renascer, antes de religar o auto-play.
    const maxDeaths = Math.max(0, Math.floor(cfg.maxDeaths ?? 0));
    const gaveUp = maxDeaths > 0 && m.deaths >= maxDeaths;
    if (!s.canFight || gaveUp) {
      if (m.leaveTries < LEAVE_MAX_TRIES && now - m.lastLeaveAt >= LEAVE_RETRY_MS) {
        const name = s.canFight ? `${m.deaths} mortes na arena: saindo e voltando pro Treino` : "evento fechado: saindo da arena";
        return { kind: "act", id: "leave-arena", name, tag: "SKIL", body: LEAVE_ARENA_BODY };
      }
      if (!s.canFight) return { kind: "wait", reason: "evento fechado; esperando sair da arena..." };
      // Saida recusada: continua lutando em vez de ficar parado na arena.
      if (m.leaveTries < LEAVE_MAX_TRIES) return { kind: "wait", reason: "saindo da arena do Guild Boss..." };
    }

    if (cfg.dodgeSupreme && now < m.dodgeUntil) {
      const near = nearestZone(s.pos, s.zones);
      if (!near) return { kind: "wait", reason: "aviso do boss, mas sem a posicao ou as zonas lidas" };
      // Com o auto-play ligado a IA volta pro boss: desliga so durante o aviso e
      // religa quando a espera acaba.
      if (s.autoPlay)
        return { kind: "act", id: "hunt-off", name: "aviso do boss: parando o auto-play pra correr pra safe zone", tag: "SKIL", body: HUNT_OFF_BODY };
      if (!near.inside) {
        if (now - m.lastMoveAt < MOVE_RETRY_MS) return { kind: "wait", reason: "correndo pra safe zone..." };
        const z = near.zone;
        return { kind: "move", name: `correndo pra safe zone (${z.x.toFixed(0)}, ${z.z.toFixed(0)})`, pos: [z.x, z.y, z.z] };
      }
      return { kind: "wait", reason: "dentro da safe zone; esperando o golpe do boss passar" };
    }

    if (cfg.autoFight && !s.autoPlay)
      return { kind: "act", id: "hunt-on", name: "ligando o auto-play contra o Guild Boss", tag: "SKIL", body: HUNT_ON_BODY };
    // Buff com o char lutando: a fuga do aviso e a volta do auto-play vem antes.
    const buff = buffStep(s, cfg, m, now);
    if (buff) return buff;
    return { kind: "wait", reason: "em batalha contra o Guild Boss..." };
  }

  if (!s.canFight) return { kind: "closed", reason: "Guild Boss fechado agora" };

  if (s.inTeam) {
    if (!m.leftTeam)
      return { kind: "act", id: "leave-team", name: "saindo da party (o Guild Boss e sozinho)", tag: "SKIL", body: LEAVE_TEAM_BODY };
    return { kind: "wait", reason: "esperando sair da party..." };
  }
  if (s.sceneType === SCENE_TYPE_GUILD_HALL) return { kind: "fail", reason: "o jogo nao entra no Guild Boss de dentro do Guild Hall" };

  if (now - m.lastEnterAt < ENTER_RETRY_MS) return { kind: "wait", reason: "aguardando entrada na arena..." };
  if (m.enterTries >= ENTER_MAX_TRIES) return { kind: "fail", reason: `nao entrou na arena depois de ${m.enterTries} pedidos` };
  return {
    kind: "act",
    id: "enter",
    name: `entrando na arena do Guild Boss${m.enterTries ? ` (tentativa ${m.enterTries + 1})` : ""}`,
    tag: "SKIL",
    body: ENTER_BOSS_BODY,
  };
}

export function afterGuildBossStep(m: GuildBossMemory, step: GuildBossStep, now: number): GuildBossMemory {
  if (step.kind === "move") return { ...m, lastMoveAt: now };
  if (step.kind !== "act") return m;
  if (step.id === "enter") return { ...m, enterTries: m.enterTries + 1, lastEnterAt: now };
  if (step.id === "leave-team") return { ...m, leftTeam: true };
  if (step.id === "reward") return { ...m, rewardTried: true };
  if (step.id === "leave-arena") return { ...m, leaveTries: m.leaveTries + 1, lastLeaveAt: now };
  if (step.id === "buff") return { ...m, buffTries: m.buffTries + 1, lastBuffAt: now };
  return m;
}

export type EngineQuery = (tag: string, body: string) => Promise<Record<string, unknown>>;

const num = (r: Record<string, unknown>): number | undefined => (r.ok === true && typeof r.int === "number" ? r.int : undefined);
const f32 = (i: number): number => {
  const b = new DataView(new ArrayBuffer(4));
  b.setInt32(0, i, true);
  return b.getFloat32(0, true);
};

// Leitura rapida pro painel: o evento esta aberto (ou o char ja esta na arena)?
// Antes de parar o Treino o app pergunta isso.
export async function guildBossOpenNow(q: EngineQuery): Promise<boolean> {
  if ((await q("GETP", "XGuildDragonDocument get_bCanFight")).bool === true) return true;
  return inGuildBossArena(q);
}

// Char na arena do Guild Boss (o Treino nao religa aqui dentro).
export async function inGuildBossArena(q: EngineQuery): Promise<boolean> {
  return num(await q("GETP", "XScene get_SceneType")) === SCENE_TYPE_GUILD_BOSS;
}

// Circulos da cena do Guild Boss (os floats vem como int32 do GETP [#n]).
export async function readSafeZones(q: EngineQuery, sceneId: number): Promise<SafeZone[]> {
  const L = `XSafeZoneDocument GetRegionListBySceneId:${sceneId}`;
  const n = num(await q("GETP", `${L} get_Count`)) ?? 0;
  const out: SafeZone[] = [];
  for (let i = 0; i < Math.min(n, 12); i++) {
    const b = `${L} get_Item:${i}`;
    if (num(await q("GETP", `${b} RegionType`)) !== 2) continue;
    if ((num(await q("GETP", `${b} RegionCategory`)) ?? 0) <= 0) continue;
    const v: number[] = [];
    for (const k of ["RegionPos [#0]", "RegionPos [#1]", "RegionPos [#2]", "RegionSize [#0]"]) {
      const x = num(await q("GETP", `${b} ${k}`));
      if (x === undefined) break;
      v.push(f32(x));
    }
    if (v.length === 4 && v.every(Number.isFinite) && v[3] > 0) out.push({ x: v[0], y: v[1], z: v[2], r: v[3] });
  }
  return out;
}

export async function readGuildBossSnapshot(q: EngineQuery, zones: SafeZone[]): Promise<GuildBossSnapshot | null> {
  const conn = await q("CONN", "");
  const player = conn.player as Record<string, unknown> | undefined;
  if (!player) return null;
  const bool = async (body: string) => (await q("GETP", body)).bool === true;

  const sceneId = num(await q("GETP", "XScene get_SceneID")) ?? -1;
  const sceneType = num(await q("GETP", "XScene get_SceneType")) ?? -1;
  const bossScene = num(await q("GETP", 'XGlobalConfig GetInt:"GuildBossSceneID"')) ?? DEFAULT_GUILD_BOSS_SCENE;
  const inBossScene = isBossScene(sceneType, sceneId, bossScene);
  const c = player.corrected;
  const pos = Array.isArray(c) && c.length === 3 && c.every((x) => typeof x === "number") ? (c as [number, number, number]) : undefined;
  let noticeOn: boolean | undefined;
  let scriptCount: number | undefined;
  let scriptCmd: number | undefined;
  if (inBossScene) {
    const nt = await q("GETP", NOTICE_TIME_BODY);
    if (nt.ok === true && typeof nt.int === "number") noticeOn = nt.int !== 0;
    scriptCount = num(await q("GETP", SCRIPT_COUNT_BODY));
    scriptCmd = num(await q("GETP", SCRIPT_CMD_BODY));
  }
  const encourageCount = inBossScene ? num(await q("GETP", ENCOURAGE_COUNT_BODY)) : undefined;
  const encourageMax = inBossScene ? num(await q("GETP", ENCOURAGE_MAX_BODY)) : undefined;
  return {
    inWorld: player.ok === true,
    inGuild: await bool("XGuildDocument get_bInGuild"),
    inTeam: await bool("XTeamDocument get_bInTeam"),
    sceneId,
    sceneType,
    inBossScene,
    canFight: await bool("XGuildDragonDocument get_bCanFight"),
    noticeOn,
    scriptCount,
    scriptCmd,
    encourageCount,
    encourageMax,
    zones,
    pos,
    rewardVisible: inBossScene && (num(await q("GETP", "XLevelRewardView _DlgHandler")) ?? 0) !== 0,
    dead: player.dead === true,
    autoPlay: player.autoPlayOn === true,
  };
}
