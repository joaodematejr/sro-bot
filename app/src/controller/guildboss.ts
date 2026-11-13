// Guild Boss (World Boss da Guilda) 100% por metodo e guiado por estado.
// Logica pura, sem IO; o main faz as leituras e manda os comandos.
//
// Mapeado na memoria em 2026-11-12/13:
//   Cena da Arena        -> XScene get_SceneID == 2200 (XWorldBossDocument GetWorldBossSceneID)
//   Status e tempo       -> XWorldBossDocument GetWorldBossTime / ReqBattleInfo
//   Checagem de equipe   -> XTeamDocument get_bInTeam (char nao pode estar em party)
//   Sair da equipe       -> XTeamView _MyTeamHandler _DoLeaveFromTeam (ou XTeamDocument ReqLeaveTeam)
//   Comprar buffs (gold) -> XWorldBossDocument ReqEncourageTwo (get_EncourgeGuildCount)
//   Entrada na arena     -> XWorldBossDocument ReqEnterWorldBossScene (ou XWorldBossView OnGoBattleClick)
//   Zona Segura (Wipe)   -> XSafeZoneDocument get_IsInSafeRegion / PtcG2C_OpenSafeZoneGuildBoss
//   Fim / Recompensa     -> LevelRewardGuildBossHandler OnContinueClick

export const GUILD_BOSS_SCENE_ID = 5;
export const GUILD_BOSS_TEMPLATE_ID = 2200;
export const GUILD_BUFF_GOLD_COST = 20000;

export const LEAVE_TEAM_BODY = "callx XTeamDocument ReqTeamOp 7 -- i:3 q:0 n i:1 s: i:0 u:0";
export const OPEN_BOSS_VIEW_BODY = "callp XWorldBossView ShowView 0";
export const ENTER_BOSS_BODY = "callp XWorldBossView OnGoBattleClick 1";
export const BUY_GUILD_BUFF_BODY = "callsn XWorldBossDocument ReqEncourageTwo";
export const EXIT_REWARD_BODY = "callp XLevelRewardView _DlgHandler OnContinueClick 1";

export function isBossScene(sceneId: number): boolean {
  return sceneId === GUILD_BOSS_SCENE_ID || sceneId === GUILD_BOSS_TEMPLATE_ID;
}

export interface GuildBossConfig {
  enabled: boolean;
  goldBuffsMax: number; // quantos buffs de gold comprar (ex: 5). 0 = nao compra
  dodgeSupreme: boolean; // corre pra safe zone no golpe supremo
  autoFight: boolean; // liga auto-play dentro da arena
}

export const DEFAULT_GUILD_BOSS_CONFIG: GuildBossConfig = {
  enabled: true,
  goldBuffsMax: 5,
  dodgeSupreme: true,
  autoFight: true,
};

export interface GuildBossSnapshot {
  inWorld: boolean;
  inGuild: boolean;
  inTeam: boolean;
  sceneId: number;
  inBossScene: boolean;
  bossOpen: boolean; // se o icone/evento do World Boss esta ativo no jogo
  timeLeft: number; // segundos restantes do evento
  goldBuffCount: number; // contador de buffs adquiridos pela guilda
  inSafeRegion: boolean; // se o char esta dentro do circulo seguro
  wipeActive: boolean; // se o wipe supremo do boss esta em andamento
  safePos?: [number, number, number]; // coordenadas [x, y, z] do centro da zona segura mais proxima
  rewardVisible: boolean; // tela de vitoria/derrota com OnContinueClick
  dead: boolean;
  autoPlay: boolean;
  gold: number;
}

export type GuildBossStep =
  | { kind: "done"; reason: string }
  | { kind: "wait"; reason: string }
  | { kind: "act"; id: string; name: string; tag: string; body: string }
  | { kind: "move"; name: string; pos: [number, number, number] }
  | { kind: "fail"; reason: string }
  | { kind: "closed"; reason: string }; // evento fechado: nada a fazer agora (nem sair da party)

export function isBossActive(s: GuildBossSnapshot): boolean {
  return s.inBossScene || s.bossOpen;
}

// Decide a proxima acao com base no snapshot do estado do jogo.
export function nextGuildBossStep(
  s: GuildBossSnapshot | null,
  cfg: GuildBossConfig,
  tried: Set<string> = new Set(),
): GuildBossStep {
  if (!s) return { kind: "fail", reason: "engine fora" };
  if (!s.inWorld) return { kind: "wait", reason: "aguardando char entrar em mundo..." };
  if (!s.inGuild) return { kind: "done", reason: "char sem guilda" };

  // 1. Ja dentro da arena do Guild Boss
  if (s.inBossScene) {
    if (s.rewardVisible && !tried.has("reward")) {
      return {
        kind: "act",
        id: "reward",
        name: "sair da arena do Guild Boss e receber recompensas",
        tag: "SKIL",
        body: EXIT_REWARD_BODY,
      };
    }

    if (s.dead) {
      return { kind: "wait", reason: "char abatido na arena do Boss; aguardando..." };
    }

    // Mecanica de desvio do golpe supremo (SafeZone)
    if (s.wipeActive && cfg.dodgeSupreme) {
      if (!s.inSafeRegion) {
        if (s.safePos) {
          return {
            kind: "move",
            name: "correndo para a Safe Zone (golpe supremo do Boss!)",
            pos: s.safePos,
          };
        }
        // Se ainda nao temos coordenadas do centro, desliga autoPlay para parar de focar no boss
        if (s.autoPlay) {
          return {
            kind: "act",
            id: "stop-autohunt",
            name: "pausando ataque ao Boss (preparando fuga para Safe Zone)",
            tag: "SKIL",
            body: '{"on":0}',
          };
        }
      } else {
        // Dentro da safe region durante o wipe: fica protegido
        if (s.autoPlay) {
          return {
            kind: "act",
            id: "safe-stand",
            name: "em seguranca na Safe Zone; aguardando golpe supremo explodir",
            tag: "SKIL",
            body: '{"on":0}',
          };
        }
        return { kind: "wait", reason: "protegido na Safe Zone durante o golpe supremo." };
      }
    }

    // Combate regular dentro da arena
    // Quando morre no boss e renasce do countdown, o jogo mantem auto-play desligado;
    // o bot reativa auto-play continuamente toda vez que estiver vivo com auto-play off.
    if (cfg.autoFight && !s.autoPlay && !s.wipeActive) {
      return {
        kind: "act",
        id: "autofight",
        name: "ligando auto-ataque contra o Guild Boss",
        tag: "SKIL",
        body: '{"on":1}',
      };
    }

    return { kind: "wait", reason: "em batalha contra o Guild Boss..." };
  }

  // 2. Fora da arena do Guild Boss. Com o evento fechado nao mexe em nada: sair
  // da party ou esperar aqui travaria o Treino e a party o dia todo.
  if (!isBossActive(s)) {
    return { kind: "closed", reason: "Guild Boss fechado agora (abre as 20:00 do servidor)" };
  }

  if (s.inTeam && !tried.has("leave-team")) {
    return {
      kind: "act",
      id: "leave-team",
      name: "saindo da party (requisito para acessar o Guild Boss)",
      tag: "SKIL",
      body: LEAVE_TEAM_BODY,
    };
  }

  // Abre janela do boss e entra
  if (!tried.has("open-view")) {
    return {
      kind: "act",
      id: "open-view",
      name: "abrindo painel do Guild Boss",
      tag: "SKIL",
      body: OPEN_BOSS_VIEW_BODY,
    };
  }

  // Entra na arena clicando em Challenge
  if (!tried.has("enter")) {
    return {
      kind: "act",
      id: "enter",
      name: "entrando na arena do Guild Boss (Challenge)",
      tag: "SKIL",
      body: ENTER_BOSS_BODY,
    };
  }

  return { kind: "wait", reason: "aguardando entrada na arena..." };
}

export type EngineQuery = (tag: string, body: string) => Promise<Record<string, unknown>>;

// Leitura rapida pro painel: o evento esta aberto (ou o char ja esta na arena)?
// Antes de parar o Treino o app pergunta isso.
export async function guildBossOpenNow(q: EngineQuery): Promise<boolean> {
  const sc = await q("GETP", "XScene get_SceneID");
  if (typeof sc.int === "number" && isBossScene(sc.int)) return true;
  return (await q("GETP", "XWorldBossDocument MainInterfaceState")).bool === true;
}

export async function readGuildBossSnapshot(q: EngineQuery): Promise<GuildBossSnapshot | null> {
  const conn = await q("CONN", "");
  const player = conn.player as Record<string, unknown> | undefined;
  if (!player) return null;

  const int = async (body: string, dflt = -1) => {
    const r = await q("GETP", body);
    return r.ok === true && typeof r.int === "number" ? r.int : dflt;
  };
  const bool = async (body: string) => (await q("GETP", body)).bool === true;

  const sceneId = await int("XScene get_SceneID", -1);
  const inBossScene = isBossScene(sceneId);
  const bossOpen = await bool("XWorldBossDocument MainInterfaceState");
  const dlgHandler = await int("XLevelRewardView _DlgHandler", 0);

  const s: GuildBossSnapshot = {
    inWorld: player.ok === true,
    inGuild: await bool("XGuildDocument get_bInGuild"),
    inTeam: await bool("XTeamDocument get_bInTeam"),
    sceneId,
    inBossScene,
    bossOpen,
    timeLeft: bossOpen ? 600 : 0,
    goldBuffCount: await int("XWorldBossDocument get_EncourgeGuildCount", 0),
    inSafeRegion: await bool("XSafeZoneDocument get_IsInSafeRegion"),
    wipeActive: false,
    rewardVisible: dlgHandler !== 0,
    dead: player.dead === true,
    autoPlay: player.autoPlayOn === true,
    gold: await int("XBagDocument GetItemCount:1,0", 0),
  };

  return s;
}

