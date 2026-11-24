// Missao principal por metodo: le o estado (readMainQuestSnapshot), decide UMA acao
// e manda, ate concluir, falhar, estourar o tempo da passada ou o Parar.

import {
  afterMainQuestAction,
  type MainQuestConfig,
  newMainQuestProgress,
  nextMainQuestStep,
  readMainQuestSnapshot,
  trackMainQuest,
} from "../controller/mainquest";
import { queryPlayer, sendCommand } from "./engine";

type Log = (msg: string) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 3000;
const SAME_ACTION_COOLDOWN_MS = 4000;
// Uma passada segura o Treino parado; depois disso o Treino volta e a missao fica
// pro proximo Iniciar bot (ou marcar "Ativa" de novo).
const RUN_TIMEOUT_MS = 60 * 60 * 1000;

let stopRequested = false;

export function stopMainQuest(): void {
  stopRequested = true;
}

export async function runMainQuest(
  host: string,
  port: number,
  cfg: MainQuestConfig,
  log: Log = () => {},
): Promise<{ ok: boolean; erro?: string; completed?: number }> {
  stopRequested = false;
  const p0 = await queryPlayer(host, port);
  if (!p0.ok) {
    log("char nao esta em mundo; nao iniciado.");
    return { ok: false, erro: "char nao esta em mundo" };
  }
  const q = (tag: string, body: string) => sendCommand(host, port, tag, body);
  let prog = newMainQuestProgress();
  let lastBody = "";
  let lastAt = 0;
  let lastWait = "";
  const t0 = Date.now();
  while (!stopRequested && Date.now() - t0 < RUN_TIMEOUT_MS) {
    const now = Date.now();
    const s = await readMainQuestSnapshot(q);
    prog = trackMainQuest(prog, s, now);
    const step = nextMainQuestStep(s, cfg, prog, now);
    if (step.kind === "done") {
      log(`concluido: ${step.reason}.`);
      return { ok: true, completed: prog.completed.length };
    }
    if (step.kind === "fail") {
      log(`falhou: ${step.reason}.`);
      return { ok: false, erro: step.reason, completed: prog.completed.length };
    }
    if (step.kind === "act") {
      const cooldown = step.cooldownMs ?? SAME_ACTION_COOLDOWN_MS;
      if (step.body !== lastBody || now - lastAt >= cooldown) {
        log(step.name);
        await q(step.tag, step.body);
        lastBody = step.body;
        lastAt = now;
        prog = afterMainQuestAction(prog, step, now);
        lastWait = "";
      }
    } else if (step.reason !== lastWait) {
      lastWait = step.reason;
      log(step.reason);
    }
    await sleep(POLL_MS);
  }
  if (stopRequested) {
    log("parado.");
    return { ok: false, erro: "parado", completed: prog.completed.length };
  }
  log("tempo da passada esgotado (1 h); a missao segue no proximo Iniciar bot.");
  return { ok: false, erro: "tempo esgotado", completed: prog.completed.length };
}
