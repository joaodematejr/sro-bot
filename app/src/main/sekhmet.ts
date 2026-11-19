// Loop de execucao da Sekhmet War (World Boss). Mapeado 100% por metodos de engine,
// sem cliques em coordenadas.

import {
  afterSekhmetStep,
  BATTLE_INFO_BODY,
  HUNT_ON_BODY,
  inSekhmetArena,
  newSekhmetMemory,
  nextSekhmetStep,
  readSekhmetSnapshot,
  type SekhmetConfig,
  sekhmetOpenNow,
} from "../controller/sekhmet";
import { queryPlayer, sendCommand } from "./engine";

type Log = (msg: string) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RUN_TIMEOUT_MS = 40 * 60 * 1000; // o evento dura 30 min
const TICK_MS = 1500;
// Vida do boss e ranking: o jogo so atualiza quando pede.
const BATTLE_INFO_MS = 10_000;
// Leituras seguidas fora da arena antes de dar a luta por encerrada (uma leitura
// falha da cena nao encerra).
const LEFT_ARENA_READS = 2;

let stopRequested = false;

export function stopSekhmet(): void {
  stopRequested = true;
}

export async function isSekhmetOpen(host: string, port: number): Promise<boolean> {
  return sekhmetOpenNow((tag, body) => sendCommand(host, port, tag, body)).catch(() => false);
}

export async function isInSekhmetArena(host: string, port: number): Promise<boolean> {
  return inSekhmetArena((tag, body) => sendCommand(host, port, tag, body)).catch(() => false);
}

export async function runSekhmet(
  host: string,
  port: number,
  cfg: SekhmetConfig,
  log: Log = () => {},
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<{ ok: boolean; erro?: string }> {
  stopRequested = false;
  const p = await queryPlayer(host, port);
  if (!p.ok) {
    log("char nao esta em mundo; Sekhmet War nao iniciada.");
    return { ok: false, erro: "char nao esta em mundo" };
  }

  const q = (tag: string, body: string) => sendCommand(host, port, tag, body);
  const t0 = Date.now();
  let lastWait = "";
  let mem = newSekhmetMemory();
  let wasInArena = false;
  let outsideReads = 0;
  let infoAt = 0;
  // Parando no meio, nunca deixa o char na arena com o auto-play desligado.
  const huntBackOn = async () => {
    const end = await queryPlayer(host, port).catch(() => null);
    if (end && end.ok && (end as { autoPlayOn?: boolean }).autoPlayOn === false) await q("SKIL", HUNT_ON_BODY);
  };

  while (Date.now() - t0 < timeoutMs) {
    if (stopRequested) {
      log("Sekhmet War parada pelo usuario.");
      if (wasInArena) await huntBackOn();
      return { ok: false, erro: "parado" };
    }

    const s = await readSekhmetSnapshot(q);
    if (s?.inBossScene) {
      wasInArena = true;
      outsideReads = 0;
      if (Date.now() - infoAt >= BATTLE_INFO_MS) {
        infoAt = Date.now();
        await q("SKIL", BATTLE_INFO_BODY);
      }
    } else if (s && wasInArena && s.inWorld && s.sceneId >= 0) {
      if (++outsideReads >= LEFT_ARENA_READS) {
        log("Sekhmet War: saiu da arena; fim da luta.");
        return { ok: true };
      }
      await sleep(TICK_MS);
      continue;
    }

    const now = Date.now();
    const step = nextSekhmetStep(s, cfg, mem, now);
    mem = afterSekhmetStep(mem, step, now);

    if (step.kind === "done") {
      log(`Sekhmet War: ${step.reason}`);
      return { ok: true };
    }
    if (step.kind === "closed") {
      log(`Sekhmet War: ${step.reason}`);
      return { ok: false, erro: "fechado" };
    }
    if (step.kind === "fail") {
      log(`Sekhmet War falhou: ${step.reason}`);
      if (wasInArena) await huntBackOn();
      return { ok: false, erro: step.reason };
    }
    if (step.kind === "wait") {
      if (step.reason !== lastWait) {
        log(step.reason);
        lastWait = step.reason;
      }
    } else {
      lastWait = "";
      log(`Sekhmet War: ${step.name}`);
      await q(step.tag, step.body);
    }
    await sleep(TICK_MS);
  }

  log("timeout do ciclo da Sekhmet War.");
  if (wasInArena) await huntBackOn();
  return { ok: false, erro: "timeout" };
}
