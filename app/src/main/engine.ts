// Cliente do engine e helpers de ADB para o processo main do Electron.
// Mesmo enquadramento do engine C++:
//   cabecalho 16 bytes (tag[4], a, b, len) little-endian + corpo JSON.

import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

import { requestOnce } from "../controller/enginechannel";
import { fullExp, readExpHigh, unsignedExp } from "../controller/train";
import { adbBin } from "./adbbin";

const execFileP = promisify(execFile);

const HEADER = 16;

export interface PlayerState {
  ok: boolean;
  player?: string;
  corrected?: [number, number, number];
  next?: [number, number, number];
  name?: string;
  exp?: number;
  maxExp?: number;
  erro?: string;
}

function frame(tag: string, payload: string): Buffer {
  const body = Buffer.from(payload, "utf-8");
  const head = Buffer.alloc(HEADER);
  head.write(tag.padEnd(4, "\0").slice(0, 4), 0, "ascii");
  head.writeUInt32LE(0, 4);
  head.writeUInt32LE(0, 8);
  head.writeUInt32LE(body.length, 12);
  return Buffer.concat([head, body]);
}

// Abre a porta encaminhada do engine (device 27100 -> host hostPort).
export async function adbForward(serial: string, hostPort: number): Promise<void> {
  await execFileP(adbBin(), ["-s", serial, "forward", `tcp:${hostPort}`, "tcp:27100"], { timeout: 30000 });
}

export async function adbConnect(serial: string): Promise<void> {
  try {
    await execFileP(adbBin(), ["connect", serial], { timeout: 30000 });
  } catch {
    // ignora; connect em serial ja conectado retorna erro benigno
  }
}

// Comando one-shot (tag + corpo cru) que devolve o JSON do primeiro RESP. Mora
// no controlador (o goal da torre tambem le estado por ele).
export const sendCommand = requestOnce;

// Liga/desliga o auto-battle do jogo (comando SKIL no engine). Manda a mesma
// forma canonica que o canal do controlador usa ({"on":N}); o engine ainda
// aceita o corpo cru "1"/"0" como defesa.
export function setAutoFight(host: string, port: number, on: boolean): Promise<Record<string, unknown>> {
  return sendCommand(host, port, "SKIL", JSON.stringify({ on: on ? 1 : 0 }));
}

// Consulta o engine: CONN e, em mundo, os 4 bytes de cima do EXP (fullExp).
export async function queryPlayer(host: string, port: number, timeoutMs = 4000): Promise<PlayerState> {
  const p = await queryPlayerConn(host, port, timeoutMs);
  if (p.ok !== true || typeof p.exp !== "number") return p;
  const hi = await readExpHigh((tag, body) => sendCommand(host, port, tag, body));
  p.exp = fullExp(p.exp, hi.exp);
  if (typeof p.maxExp === "number") p.maxExp = fullExp(p.maxExp, hi.max);
  return p;
}

// Envia CONN e le o frame RESP com o estado do jogador.
function queryPlayerConn(host: string, port: number, timeoutMs: number): Promise<PlayerState> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = (s: PlayerState) => {
      if (settled) return; // resolve uma vez so; close pos-destroy nao sobrescreve
      settled = true;
      try { sock.destroy(); } catch { /* noop */ }
      resolve(s);
    };
    sock.setTimeout(timeoutMs, () => done({ ok: false, erro: "timeout" }));
    sock.on("error", (e) => done({ ok: false, erro: String(e) }));
    // Engine morto: o adb aceita a conexao local e fecha (porta do device sem
    // listener). Sem tratar 'close' a promise nunca resolvia e travava o loop.
    sock.on("close", () => done({ ok: false, erro: "conexao fechada (engine fora?)" }));
    // Socket sem setEncoding: o data vem como Buffer (o tipo do Node admite texto).
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, typeof d === "string" ? Buffer.from(d) : d]);
      // procura um frame RESP completo
      let off = 0;
      while (buf.length - off >= HEADER) {
        const tag = buf.toString("ascii", off, off + 4).replace(/\0+$/, "");
        const len = buf.readUInt32LE(off + 12);
        if (buf.length - off < HEADER + len) break;
        const body = buf.toString("utf-8", off + HEADER, off + HEADER + len);
        off += HEADER + len;
        if (tag === "RESP") {
          try {
            const obj = JSON.parse(body);
            const p = (obj.player ?? obj) as PlayerState;
            if (typeof p.exp === "number") p.exp = unsignedExp(p.exp);
            if (typeof p.maxExp === "number") p.maxExp = unsignedExp(p.maxExp);
            return done(p);
          } catch {
            return done({ ok: false, erro: "json invalido" });
          }
        }
      }
    });
    sock.connect(port, host, () => {
      sock.write(frame("CONN", ""));
    });
  });
}

