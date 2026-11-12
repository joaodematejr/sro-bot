// Avisos pelo Telegram: token criptografado pelo Windows (safeStorage, como a
// senha da conta), chat e opcoes num JSON. O token nunca volta pro renderer nem
// vai pro log.

import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

import { alertDue, alertMessage, chatFromUpdates, hideToken, type TelegramAlert, validToken } from "../controller/telegram";

export interface TelegramSettings {
  enabled: boolean;
  problems: boolean; // morte, queda, mochila cheia, EXP/h caiu
  done: boolean; // treino e Continental concluidos
  chatId?: number;
  chatName?: string;
}

const DEFAULTS: TelegramSettings = { enabled: false, problems: true, done: false };
const API = "https://api.telegram.org/bot";
const TIMEOUT_MS = 15000;

let dir = "";
const last: Record<string, number> = {};

export function setTelegramDir(d: string): void {
  dir = d;
}

const settingsFile = () => path.join(dir, "telegram.json");
const tokenFile = () => path.join(dir, "telegram-token.bin");

export function loadTelegram(): TelegramSettings {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return {
      enabled: s.enabled === true,
      problems: s.problems !== false,
      done: s.done === true,
      chatId: typeof s.chatId === "number" ? s.chatId : undefined,
      chatName: typeof s.chatName === "string" ? s.chatName : undefined,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function hasTelegramToken(): boolean {
  return fs.existsSync(tokenFile());
}

function readToken(): string {
  try {
    return safeStorage.decryptString(fs.readFileSync(tokenFile()));
  } catch {
    return "";
  }
}

// token: undefined mantem, "" apaga (e esquece o chat), texto grava.
export function saveTelegram(s: Partial<TelegramSettings>, token?: string): TelegramSettings {
  fs.mkdirSync(dir, { recursive: true });
  const cur = loadTelegram();
  let next: TelegramSettings = {
    ...cur,
    enabled: s.enabled ?? cur.enabled,
    problems: s.problems ?? cur.problems,
    done: s.done ?? cur.done,
  };
  if (token !== undefined) {
    if (!token.trim()) {
      fs.rmSync(tokenFile(), { force: true });
      next = { ...next, enabled: false, chatId: undefined, chatName: undefined };
    } else {
      if (!validToken(token)) throw new Error("token invalido (o do @BotFather e numero:codigo)");
      if (!safeStorage.isEncryptionAvailable()) throw new Error("o Windows nao liberou a criptografia pra guardar o token");
      fs.writeFileSync(tokenFile(), safeStorage.encryptString(token.trim()));
      next = { ...next, chatId: undefined, chatName: undefined };
    }
  }
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

async function call(method: string, body?: unknown): Promise<unknown> {
  const token = readToken();
  if (!token) throw new Error("sem token");
  try {
    const r = await fetch(`${API}${token}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!r.ok || j.ok === false) throw new Error(`Telegram respondeu ${r.status}${j.description ? `: ${j.description}` : ""}`);
    return j;
  } catch (e) {
    throw new Error(hideToken(e instanceof Error ? e.message : String(e), token));
  }
}

// Acha o chat: a pessoa manda qualquer mensagem pro bot antes.
export async function linkTelegram(): Promise<TelegramSettings> {
  const chat = chatFromUpdates(await call("getUpdates"));
  if (!chat) throw new Error("nenhuma mensagem pro bot ainda: mande um \"oi\" pro seu bot no Telegram e tente de novo");
  const cur = loadTelegram();
  const next = { ...cur, chatId: chat.id, chatName: chat.name, enabled: true };
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

async function send(text: string): Promise<void> {
  const s = loadTelegram();
  if (s.chatId === undefined) throw new Error("chat nao ligado");
  await call("sendMessage", { chat_id: s.chatId, text, disable_web_page_preview: true });
}

export async function testTelegram(): Promise<void> {
  await send("SRO Bot | teste: os avisos vao chegar aqui.");
}

// Aviso vindo do log. false = nao mandou (desligado, grupo desligado ou repetido).
export async function alertTelegram(a: TelegramAlert, charName?: string): Promise<boolean> {
  const s = loadTelegram();
  if (!s.enabled || s.chatId === undefined || !hasTelegramToken()) return false;
  if (a.group === "problem" ? !s.problems : !s.done) return false;
  const now = Date.now();
  if (!alertDue(last, a.kind, now)) return false;
  last[a.kind] = now;
  await send(alertMessage(a, charName));
  return true;
}
