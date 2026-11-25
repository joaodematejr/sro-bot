// Portao dos eventos de hora marcada (Guild Boss, Sekhmet War): com um deles aberto a
// fila de 1 min (diarias, Continental, baus, gratis do dia, Album de Cards, Qigong)
// espera o bot entrar. Logica pura.
//
// Em 2026-11-24 o portao ficou preso em "Sekhmet War" das 09:58 ate o app ser
// reaberto no dia seguinte: o checkTimedEvents saia sem atualizar quando o Guild
// Boss ou a Sekhmet estavam no meio da propria checagem (quase todo tick de 5 s), e
// so atualizava com uma atividade da fila rodando, que o proprio portao impedia.
// Agora o portao fecha quando a leitura diz que nada esta aberto e, mesmo lendo
// aberto, nunca segura a fila mais que EVENT_GATE_MAX_MS (o evento dura 30 min).

export const EVENT_GATE_MAX_MS = 40 * 60 * 1000;

export interface EventGate {
  name: string; // evento lido aberto ("" = nenhum)
  since: number; // quando ele foi lido aberto pela primeira vez (ms)
}

export const NO_EVENT: EventGate = { name: "", since: 0 };

// Nova leitura: `open` e o evento aberto agora ("" = nenhum). O mesmo evento segue
// aberto mantem o `since`, pra validade contar desde a abertura.
export function nextEventGate(prev: EventGate, open: string, now: number): EventGate {
  if (!open) return NO_EVENT;
  if (open === prev.name) return prev;
  return { name: open, since: now };
}

// Evento que segura a fila agora ("" = fila livre). Passada a validade, libera
// mesmo que a leitura ainda diga aberto (leitura velha do jogo).
export function eventHolding(gate: EventGate, now: number): string {
  if (!gate.name) return "";
  return now - gate.since < EVENT_GATE_MAX_MS ? gate.name : "";
}
