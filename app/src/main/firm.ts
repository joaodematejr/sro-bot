// Firm por metodo: le o estado (readFirmSnapshot), decide UMA acao e manda, ate
// concluir, falhar ou o Parar.

import {
  afterFirmAction,
  type FirmConfig,
  newFirmProgress,
  nextFirmStep,
  readFirmSnapshot,
  trackFirm,
} from "../controller/firm";
import { queryPlayer, sendCommand } from "./engine";

type Log = (msg: string) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 3000;
const SAME_ACTION_COOLDOWN_MS = 4000;
const RUN_TIMEOUT_MS = 15 * 60 * 1000;

let stopRequested = false;

export function stopFirm(): void {
  stopRequested = true;
}

export async function runFirm(
  host: string,
  port: number,
  cfg: FirmConfig,
  log: Log = () => {},
): Promise<{ ok: boolean; erro?: string; submitted?: number }> {
  stopRequested = false;
  const p0 = await queryPlayer(host, port);
  if (!p0.ok) {
    log("char nao esta em mundo; nao iniciado.");
    return { ok: false, erro: "char nao esta em mundo" };
  }
  const q = (tag: string, body: string) => sendCommand(host, port, tag, body);
  await q("SKIL", "calls XGuildDailyTaskDocument SendGetDailyTaskInfo 0");
  // Espera a resposta do servidor: lida logo depois, a lista ainda vinha a do
  // login (visto em 2026-11-07: tarefa entregue por fora lida como aberta).
  await sleep(2000);
  let prog = newFirmProgress();
  let lastBody = "";
  let lastAt = 0;
  let lastWait = "";
  const t0 = Date.now();
  while (!stopRequested && Date.now() - t0 < RUN_TIMEOUT_MS) {
    const now = Date.now();
    const s = await readFirmSnapshot(q, cfg);
    prog = trackFirm(prog, s, now);
    const step = nextFirmStep(s, cfg, prog, now);
    if (step.kind === "done") {
      log(`concluido: ${step.reason}.`);
      return { ok: true, submitted: prog.submitted.length };
    }
    if (step.kind === "fail") {
      log(`falhou: ${step.reason}.`);
      return { ok: false, erro: step.reason, submitted: prog.submitted.length };
    }
    if (step.kind === "act") {
      const cooldown = step.cooldownMs ?? SAME_ACTION_COOLDOWN_MS;
      if (step.body !== lastBody || now - lastAt >= cooldown) {
        log(step.name);
        await q(step.tag, step.body);
        lastBody = step.body;
        lastAt = now;
        prog = afterFirmAction(prog, step, now, s);
        // A lista e o _count so atualizam com o servidor: pede de novo.
        if (step.id === "submit" || step.id === "take" || step.id === "ask" || step.id === "total") {
          await sleep(1500);
          await q("SKIL", "calls XGuildDailyTaskDocument SendGetDailyTaskInfo 0");
        }
      }
    } else if (step.reason !== lastWait) {
      lastWait = step.reason;
      log(step.reason);
    }
    await sleep(POLL_MS);
  }
  if (stopRequested) {
    log("parado.");
    return { ok: false, erro: "parado", submitted: prog.submitted.length };
  }
  log("tempo esgotado.");
  return { ok: false, erro: "tempo esgotado", submitted: prog.submitted.length };
}
