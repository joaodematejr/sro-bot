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
//   Safe zone    -> o servidor abre com o PtcG2C_OpenSafeZoneGuildBoss (isOpen), que
//                   so liga o campo estatico XSafeZoneDocument _isEffectSafeZoneActive
//                   (le com o GETP de estatico do engine; o engine velho le lixo, por
//                   isso so vale com "static": true). As zonas sao os circulos da
//                   RegionList da cena (GetRegionListBySceneId: RegionType 2,
//                   RegionPos x/y/z, RegionSize[0] raio): na cena 5 sao 4, raio 6.
//                   Dentro do circulo aberto o jogo bloqueia as skills (AI BlockSkill),
//                   e o get_IsInSafeRegion do jogo nunca muda (isInSide fica falso):
//                   o "dentro" e a distancia da posicao ao centro.
//   Fim          -> LevelRewardGuildBossHandler OnContinueClick (sem prova ao vivo).

export const SCENE_TYPE_GUILD_BOSS = 11;
export const SCENE_TYPE_GUILD_HALL = 10;
export const DEFAULT_GUILD_BOSS_SCENE = 5;

export const LEAVE_TEAM_BODY = "callx XTeamDocument ReqTeamOp 7 -- i:3 q:0 n i:1 s: i:0 u:0";
export const ENTER_BOSS_BODY = "calls XGuildDragonDocument ReqEnterScene 0";
export const EXIT_REWARD_BODY = "callp XLevelRewardView _DlgHandler OnContinueClick 1";
export const SAFE_ZONE_OPEN_BODY = "XSafeZoneDocument _isEffectSafeZoneActive";
export const HUNT_ON_BODY = '{"on":1}';
export const HUNT_OFF_BODY = '{"on":0}';

// Nova tentativa de entrar se a cena nao mudou.
export const ENTER_RETRY_MS = 10_000;
export const ENTER_MAX_TRIES = 6;
// Navigate de novo enquanto nao chega (o caminho pode ser cortado pelo boss).
export const MOVE_RETRY_MS = 2_000;
// Margem pra dentro do raio: parar na borda deixa o char meio fora.
export const SAFE_MARGIN = 1.5;

export interface GuildBossConfig {
  enabled: boolean;
  goldBuffsMax: number; // ainda nao usado: o fluxo nao compra buff
  dodgeSupreme: boolean; // corre pra safe zone quando o servidor abre
  autoFight: boolean; // liga o auto-play dentro da arena
}

export const DEFAULT_GUILD_BOSS_CONFIG: GuildBossConfig = {
  enabled: true,
  goldBuffsMax: 5,
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
  safeZoneOpen?: boolean; // undefined = nao lido (engine sem GETP de estatico)
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
}

export function newGuildBossMemory(): GuildBossMemory {
  return { enterTries: 0, lastEnterAt: -Infinity, lastMoveAt: -Infinity, leftTeam: false, rewardTried: false };
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

export function nextGuildBossStep(s: GuildBossSnapshot | null, cfg: GuildBossConfig, m: GuildBossMemory, now: number): GuildBossStep {
  if (!s) return { kind: "fail", reason: "engine fora" };
  if (!s.inWorld) return { kind: "wait", reason: "aguardando char entrar em mundo..." };
  if (!s.inGuild) return { kind: "done", reason: "char sem guilda" };

  if (s.inBossScene) {
    if (s.rewardVisible && !m.rewardTried)
      return { kind: "act", id: "reward", name: "sair da arena do Guild Boss e receber recompensas", tag: "SKIL", body: EXIT_REWARD_BODY };
    if (s.dead) return { kind: "wait", reason: "char abatido na arena do Boss; aguardando..." };

    if (cfg.dodgeSupreme && s.safeZoneOpen === true) {
      const near = nearestZone(s.pos, s.zones);
      if (!near) return { kind: "wait", reason: "safe zone aberta, mas sem a posicao ou as zonas lidas" };
      // Com o auto-play ligado a IA volta pro boss: desliga so enquanto a zona esta
      // aberta (o golpe do boss e o perigo aqui) e religa assim que fecha.
      if (s.autoPlay)
        return { kind: "act", id: "hunt-off", name: "safe zone aberta: parando o auto-play pra correr pra ela", tag: "SKIL", body: HUNT_OFF_BODY };
      if (!near.inside) {
        if (now - m.lastMoveAt < MOVE_RETRY_MS) return { kind: "wait", reason: "correndo pra safe zone..." };
        const z = near.zone;
        return { kind: "move", name: `correndo pra safe zone (${z.x.toFixed(0)}, ${z.z.toFixed(0)})`, pos: [z.x, z.y, z.z] };
      }
      return { kind: "wait", reason: "dentro da safe zone; esperando ela fechar" };
    }

    if (cfg.autoFight && !s.autoPlay)
      return { kind: "act", id: "hunt-on", name: "ligando o auto-play contra o Guild Boss", tag: "SKIL", body: HUNT_ON_BODY };
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
  let safeZoneOpen: boolean | undefined;
  if (inBossScene) {
    const r = await q("GETP", SAFE_ZONE_OPEN_BODY);
    if (r.ok === true && r.static === true) safeZoneOpen = r.bool === true;
  }
  return {
    inWorld: player.ok === true,
    inGuild: await bool("XGuildDocument get_bInGuild"),
    inTeam: await bool("XTeamDocument get_bInTeam"),
    sceneId,
    sceneType,
    inBossScene,
    canFight: await bool("XGuildDragonDocument get_bCanFight"),
    safeZoneOpen,
    zones,
    pos,
    rewardVisible: inBossScene && (num(await q("GETP", "XLevelRewardView _DlgHandler")) ?? 0) !== 0,
    dead: player.dead === true,
    autoPlay: player.autoPlayOn === true,
  };
}
