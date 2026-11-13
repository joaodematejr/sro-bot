// Loop de execucao do Guild Boss (World Boss da Guilda).
// Mapeado 100% por metodos de engine, sem cliques em coordenadas.

import {
  type GuildBossConfig,
  guildBossOpenNow,
  nextGuildBossStep,
  readGuildBossSnapshot,
} from "../controller/guildboss";
import { queryPlayer, sendCommand } from "./engine";

type Log = (msg: string) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RUN_TIMEOUT_MS = 30 * 60 * 1000; // max 30 min por sessao de Guild Boss

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
  const tried = new Set<string>();

  while (Date.now() - t0 < timeoutMs) {
    if (stopRequested) {
      log("Guild Boss parado pelo usuario.");
      return { ok: false, erro: "parado" };
    }

    const s = await readGuildBossSnapshot(q);
    const step = nextGuildBossStep(s, cfg, tried);

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
      tried.add(step.id);
      await q(step.tag, step.body);
    } else if (step.kind === "move") {
      lastWait = "";
      log(`Guild Boss: ${step.name} -> [${step.pos.map((n) => n.toFixed(1)).join(", ")}]`);
      await q("MOVE", JSON.stringify({ x: step.pos[0], y: step.pos[1], z: step.pos[2] }));
    }

    await sleep(1500);
  }

  log("timeout do ciclo do Guild Boss.");
  return { ok: false, erro: "timeout" };
}

