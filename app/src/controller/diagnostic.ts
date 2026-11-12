// Diagnostico num arquivo de texto (Ferramentas > Exportar diagnostico): log,
// configuracao e versoes pra quem usa o bot mandar quando algo der errado.
// Nunca entra senha, token ou chave: os .bin ficam de fora, campo com nome de
// segredo vira "***" e o texto passa por scrubText.

// Arquivos da pasta de dados que entram. Os .bin (senha, token, chave), a VPN e
// os caches ficam de fora.
export const DIAG_FILES = ["settings.json", "login-profile.json", "ai.json", "telegram.json", "booster.json", "qigong-asks.json"];

const SECRET_KEY = /pass|pwd|senha|token|secret|apikey|api_key|cookie|account|chat|^key$/i;

export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? "***" : redact(x);
    return out;
  }
  return typeof v === "string" ? scrubText(v) : v;
}

// Formatos de segredo que podem vazar num texto livre (log, valor de config):
// token de bot do Telegram, chave de API (sk-...) e chave WireGuard (base64 de 32 bytes).
export function scrubText(s: string): string {
  return s
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, "***")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "***")
    .replace(/\b[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=/g, "***");
}

// Valor do localStorage: JSON vira objeto (pra passar pelo redact), o resto fica texto.
function parseStored(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

export interface DiagnosticParts {
  when: Date;
  versions: Record<string, string>;
  files: Record<string, string | null>; // nome -> conteudo (null = nao existe)
  local: Record<string, string>; // localStorage do painel
  history: unknown;
  log: string;
}

export function buildDiagnostic(p: DiagnosticParts): string {
  const json = (v: unknown) => JSON.stringify(redact(v), null, 2);
  const out: string[] = [`SRO Bot: diagnostico de ${p.when.toISOString()}`, "", "== Versoes", json(p.versions), ""];
  for (const [name, text] of Object.entries(p.files)) {
    out.push(`== ${name}`);
    out.push(text === null ? "(nao existe)" : json(parseStored(text)), "");
  }
  const local: Record<string, unknown> = {};
  for (const k of Object.keys(p.local).sort()) local[k] = SECRET_KEY.test(k) ? "***" : parseStored(p.local[k]);
  out.push("== Configuracao do painel", json(local), "");
  out.push("== Historico (24 h)", json(p.history), "");
  out.push("== Log", scrubText(p.log));
  return out.join("\n");
}

export function diagnosticFileName(d: Date): string {
  const z = (n: number) => String(n).padStart(2, "0");
  return `sro-bot-diagnostico-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}.txt`;
}
