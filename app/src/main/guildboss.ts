// Loop de execucao do Guild Boss. Mapeado 100% por metodos de engine, sem cliques
// em coordenadas.

import {
  afterGuildBossStep,
  DEFAULT_GUILD_BOSS_SCENE,
  type GuildBossConfig,
  guildBossOpenNow,
  HUNT_ON_BODY,
  newGuildBossMemory,
  nextGuildBossStep,
  readGuildBossSnapshot,
  readSafeZones,
  type SafeZone,
} from "../controller/guildboss";
import { queryPlayer, sendCommand } from "./engine";

type Log = (msg: string) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RUN_TIMEOUT_MS = 30 * 60 * 1000; // max 30 min por sessao de Guild Boss
// Na arena o passo e curto: a safe zone abre e fecha em segundos.
const ARENA_TICK_MS = 700;
const TICK_MS = 1500;

let stopRequested = false;

export function stopGuildBoss(): void {
  stopRequested = true;
}

export async function isGuildBossOpen(host: string, port: number): Promise<boolean> {
  return guildBossOpenNow((tag, body) => sendCommand(host, port, tag, body)).catch(() => false);
}

export async function runGuildBoss(
  host: string,
  port: number,
  cfg: GuildBossConfig,
  log: Log = () => {},
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<{ ok: boolean; erro?: string }> {
  stopRequested = false;
  const p = await queryPlayer(host, port);
  if (!p.ok) {
    log("char nao esta em mundo; Guild Boss nao iniciado.");
    return { ok: false, erro: "char nao esta em mundo" };
  }

  const q = (tag: string, body: string) => sendCommand(host, port, tag, body);
  const t0 = Date.now();
  let lastWait = "";
  let mem = newGuildBossMemory();
  let zones: SafeZone[] = [];
  let wasInArena = false;
  let warnedNoStatic = false;
  // Nunca deixa o char parado na arena com o auto-play desligado (a safe zone o desliga).
  const huntBackOn = async () => {
    const end = await queryPlayer(host, port).catch(() => null);
    if (end && end.ok && (end as { autoPlayOn?: boolean }).autoPlayOn === false) await q("SKIL", HUNT_ON_BODY);
  };

  while (Date.now() - t0 < timeoutMs) {
    if (stopRequested) {
      log("Guild Boss parado pelo usuario.");
      if (wasInArena) await huntBackOn();
      return { ok: false, erro: "parado" };
    }

    const s = await readGuildBossSnapshot(q, zones);
    if (s?.inBossScene) {
      if (!zones.length) {
        const sc = s.sceneId > 0 ? s.sceneId : DEFAULT_GUILD_BOSS_SCENE;
        zones = await readSafeZones(q, sc);
        s.zones = zones;
        log(`Guild Boss: ${zones.length} safe zone(s) na arena`);
      }
      if (cfg.dodgeSupreme && s.safeZoneOpen === undefined && !warnedNoStatic) {
        warnedNoStatic = true;
        log("Guild Boss: o engine nao leu o aviso da safe zone (engine antigo?); sem desvio nesta luta");
      }
      wasInArena = true;
    } else if (s && wasInArena && s.inWorld) {
      log("Guild Boss: saiu da arena; fim da luta.");
      return { ok: true };
    }

    const now = Date.now();
    const step = nextGuildBossStep(s, cfg, mem, now);
    mem = afterGuildBossStep(mem, step, now);

    if (step.kind === "done") {
      log(`Guild Boss: ${step.reason}`);
      return { ok: true };
    }
    if (step.kind === "closed") {
      log(`Guild Boss: ${step.reason}`);
      return { ok: false, erro: "fechado" };
    }
    if (step.kind === "fail") {
      log(`Guild Boss falhou: ${step.reason}`);
      return { ok: false, erro: step.reason };
    }

    if (step.kind === "wait") {
      if (step.reason !== lastWait) {
        log(step.reason);
        lastWait = step.reason;
      }
    } else if (step.kind === "act") {
      lastWait = "";
      log(`Guild Boss: ${step.name}`);
      await q(step.tag, step.body);
    } else if (step.kind === "move") {
      lastWait = "";
      log(`Guild Boss: ${step.name}`);
      await q("MOVE", step.pos.map((n) => n.toFixed(2)).join(" "));
    }

    await sleep(s?.inBossScene ? ARENA_TICK_MS : TICK_MS);
  }

  log("timeout do ciclo do Guild Boss.");
  if (wasInArena) await huntBackOn();
  return { ok: false, erro: "timeout" };
}
