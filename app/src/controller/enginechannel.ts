// Canal de mensagens com o engine.
// Cabecalho 16 bytes (tag[4], a, b, len) little-endian + corpo JSON.

import net from "node:net";

const HEADER = 16;

export interface Frame {
  tag: string;
  payload: Record<string, unknown>;
  a: number;
  b: number;
}

export function encode(tag: string, payload: Record<string, unknown> = {}): Buffer {
  const body =
    payload && Object.keys(payload).length ? Buffer.from(JSON.stringify(payload), "utf-8") : Buffer.alloc(0);
  const head = Buffer.alloc(HEADER);
  head.write(tag.padEnd(4, "\0").slice(0, 4), 0, "ascii");
  head.writeUInt32LE(0, 4);
  head.writeUInt32LE(0, 8);
  head.writeUInt32LE(body.length, 12);
  return Buffer.concat([head, body]);
}

// Manda um comando one-shot (tag + corpo cru) numa conexao propria e devolve o
// JSON do primeiro RESP. Para leituras com resposta (getv/GETP), que o canal
// persistente nao casa com o pedido.
export function requestOnce(
  host: string,
  port: number,
  tag: string,
  body = "",
  timeoutMs = 4000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = (o: Record<string, unknown>) => {
      if (settled) return; // resolve uma vez so; close pos-destroy nao sobrescreve
      settled = true;
      try { sock.destroy(); } catch { /* noop */ }
      resolve(o);
    };
    sock.setTimeout(timeoutMs, () => done({ ok: false, erro: "timeout" }));
    sock.on("error", (e) => done({ ok: false, erro: String(e) }));
    // Engine morto: o adb aceita a conexao local e fecha (porta do device sem
    // listener). Sem tratar 'close' a promise nunca resolvia e travava o loop.
    sock.on("close", () => done({ ok: false, erro: "conexao fechada (engine fora?)" }));
    // Socket sem setEncoding: o data vem como Buffer (o tipo do Node admite texto).
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, typeof d === "string" ? Buffer.from(d) : d]);
      let off = 0;
      while (buf.length - off >= HEADER) {
        const t = buf.toString("ascii", off, off + 4).replace(/\0+$/, "");
        const len = buf.readUInt32LE(off + 12);
        if (buf.length - off < HEADER + len) break;
        const b = buf.toString("utf-8", off + HEADER, off + HEADER + len);
        off += HEADER + len;
        if (t === "RESP") {
          try { return done(JSON.parse(b)); } catch { return done({ ok: false, erro: "json invalido" }); }
        }
      }
    });
    const b = Buffer.from(body, "utf-8");
    const head = Buffer.alloc(HEADER);
    head.write(tag.padEnd(4, "\0").slice(0, 4), 0, "ascii");
    head.writeUInt32LE(b.length, 12);
    sock.connect(port, host, () => sock.write(Buffer.concat([head, b])));
  });
}

export class EngineChannel {
  private sock: net.Socket | null = null;
  private buf = Buffer.alloc(0);
  private rx: Frame[] = [];
  lastPacketAt = 0;

  constructor(public host = "127.0.0.1", public port = 0) {}

  get connected(): boolean {
    return this.sock !== null && !this.sock.destroyed;
  }

  connect(timeoutMs = 5000): Promise<boolean> {
    return new Promise((resolve) => {
      const s = new net.Socket();
      this.sock = s;
      let settled = false;
      s.setTimeout(1000);
      s.on("data", (d) => this.onData(typeof d === "string" ? Buffer.from(d) : d));
      s.on("error", () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
      s.on("timeout", () => {});
      s.connect(this.port, this.host, () => {
        s.write(encode("CONN"));
        const deadline = Date.now() + timeoutMs;
        const check = () => {
          if (this.poll().some((m) => m.tag === "OKAY")) {
            if (!settled) {
              settled = true;
              resolve(true);
            }
            return;
          }
          if (Date.now() > deadline) {
            if (!settled) {
              settled = true;
              resolve(false);
            }
            return;
          }
          setTimeout(check, 50);
        };
        check();
      });
    });
  }

  close(): void {
    this.sock?.destroy();
    this.sock = null;
  }

  send(tag: string, payload: Record<string, unknown> = {}): void {
    if (!this.sock) throw new Error("canal nao conectado");
    this.sock.write(encode(tag, payload));
  }

  // Manda um comando com corpo cru (string), nao JSON. Usado pelas ferramentas
  // do engine que leem o corpo como texto (SKIL "calls ..."/"callsn ...").
  sendRaw(tag: string, body: string): void {
    if (!this.sock) throw new Error("canal nao conectado");
    const b = Buffer.from(body, "utf-8");
    const head = Buffer.alloc(HEADER);
    head.write(tag.padEnd(4, "\0").slice(0, 4), 0, "ascii");
    head.writeUInt32LE(0, 4);
    head.writeUInt32LE(0, 8);
    head.writeUInt32LE(b.length, 12);
    this.sock.write(Buffer.concat([head, b]));
  }

  poll(): Frame[] {
    const out = this.rx;
    this.rx = [];
    return out;
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= HEADER) {
      const tag = this.buf.toString("ascii", 0, 4).replace(/\0+$/, "");
      const len = this.buf.readUInt32LE(12);
      if (this.buf.length < HEADER + len) break;
      const a = this.buf.readUInt32LE(4);
      const b = this.buf.readUInt32LE(8);
      const body = this.buf.toString("utf-8", HEADER, HEADER + len);
      this.buf = this.buf.subarray(HEADER + len);
      let payload: Record<string, unknown> = {};
      try {
        const p = body ? JSON.parse(body) : {};
        payload = typeof p === "object" && p ? p : { data: p };
      } catch {
        payload = {};
      }
      this.lastPacketAt = Date.now();
      // O heartbeat real do engine e o push `RESP {player}` de ~1 s (ver
      // handle_conn em engine.cpp); markHeartbeat dispara em qualquer msg.
      // O engine nao emite BEAT hoje; a resposta abaixo fica como compat.
      if (tag === "BEAT") {
        try {
          this.sock?.write(encode("BEAT"));
        } catch {
          /* noop */
        }
      }
      this.rx.push({ tag, payload, a, b });
    }
  }
}
