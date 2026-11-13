// Status do char alem de HP/MP: buffs ativos (engine BUFS) e abates (o engine
// conta no hook de morte as mortes com Killer = o char; vem no estado do jogador
// como "kills", acumulado desde que o jogo abriu).

export interface CharBuff {
  id: number;
  level: number;
  stack: number;
  left: number; // segundos restantes; -1 = sem tempo (fixo) ou relogio nao lido
  total: number; // duracao em segundos; 0 = fixo
  key: string; // chave de traducao do nome (BuffList_BuffName_<id>_<nivel>)
  name: string; // traduzido pelo main ("" = sem traducao)
}

export function parseBufs(r: Record<string, unknown>): CharBuff[] | null {
  if (r.ok !== true || !Array.isArray(r.buffs)) return null;
  const out: CharBuff[] = [];
  for (const b of r.buffs as unknown[]) {
    if (!Array.isArray(b) || b.length < 6) continue;
    const [id, level, stack, left, total, key] = b as [number, number, number, number, number, string];
    if (typeof id !== "number") continue;
    out.push({ id, level, stack, left, total, key: String(key ?? ""), name: "" });
  }
  return out;
}

// Nome pra mostrar: o traduzido, ou "buff <id>" quando o jogo nao traduziu.
export function buffLabel(b: CharBuff): string {
  const lv = b.level > 1 ? ` Lv${b.level}` : "";
  const st = b.stack > 1 ? ` x${b.stack}` : "";
  return `${b.name || `buff ${b.id}`}${lv}${st}`;
}

// Tempo restante: "12:05", "1:02:30", "fixo" (sem duracao) ou "" (relogio nao lido).
export function buffLeftText(b: CharBuff): string {
  if (b.total <= 0) return "fixo";
  if (b.left < 0) return "";
  const s = Math.max(0, Math.round(b.left));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// Abates ganhos desde a ultima leitura. O contador do engine zera quando o jogo
// reabre: valor menor que o anterior conta como recomeco.
export function killStep(last: number | undefined, cur: number | undefined): { gained: number; last: number | undefined } {
  if (typeof cur !== "number") return { gained: 0, last };
  if (last === undefined) return { gained: 0, last: cur };
  return { gained: cur >= last ? cur - last : cur, last: cur };
}
