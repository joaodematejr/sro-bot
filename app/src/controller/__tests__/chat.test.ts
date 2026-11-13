import assert from "node:assert";
import { test } from "node:test";

import { chatChannelId, chatSendCheck, chatTimeMs, cleanChatText, type ChatMessage, mergeChat, parseTzOffset, readChatChannel, roleId, sayBody } from "../chat";

test("texto do chat sai sem as marcas de cor e estilo do jogo", () => {
  assert.equal(cleanChatText("Receive [55A9FF]Gold[-]*300"), "Receive Gold*300");
  assert.equal(cleanChatText("[b]oi[/b] [ff0000]todos[-] "), "oi todos");
  assert.equal(cleanChatText("[1/3] party"), "[1/3] party"); // colchete comum fica
});

test("hora da mensagem: DateTime local do aparelho em epoch, descontando o fuso", () => {
  // lido ao vivo em 2026-11-13: 09:06:48 no aparelho em UTC+8
  assert.equal(new Date(chatTimeMs(1922597888, 148848997, 480)).toISOString(), "2026-11-13T01:06:48.000Z");
  assert.equal(chatTimeMs(0, 0, 480), 0);
  assert.equal(parseTzOffset("+0800\n"), 480);
  assert.equal(parseTzOffset("-0330"), -210);
  assert.equal(parseTzOffset("sem fuso"), undefined);
  assert.equal(chatChannelId("privado"), 3);
});

// Canal falso: lista de mensagens por indice, como o GetChatInfoList.
function fakeChat(list: { id: number; from: string; to?: string; text: string; self?: boolean; sid?: number; rid?: number }[] | null) {
  const asked: string[] = [];
  const q = async (_tag: string, body: string): Promise<Record<string, unknown>> => {
    asked.push(body);
    if (!list) return { ok: false, erro: "campo nulo: GetChatInfoList:7" };
    if (body.endsWith("get_Count")) return { ok: true, int: list.length };
    const m = /get_Item:(\d+) (\S+)$/.exec(body);
    const it = m ? list[Number(m[1])] : undefined;
    if (!m || !it) return { ok: false };
    switch (m[2]) {
      case "id": return { ok: true, int: it.id };
      case "isSelfSender": return { ok: true, int: 0, bool: !!it.self };
      case "mSenderName": return { ok: true, str: it.from };
      case "mReceiverName": return { ok: true, str: it.to ?? "" };
      case "mContent": return { ok: true, str: it.text };
      case "mSenderId": return { ok: true, int: it.sid ?? 0 };
      case "mReceiverId": return { ok: true, int: it.rid ?? 0 };
      case "mSenderId+4": case "mReceiverId+4": return { ok: true, int: 1 };
      default: return { ok: true, int: 0 };
    }
  };
  return { q, asked };
}

test("le so as mensagens novas, da mais velha pra mais nova", async () => {
  const list = [10, 11, 12, 13].map((id) => ({ id, from: `p${id}`, text: `m${id}` }));
  const { q } = fakeChat(list);
  const r = await readChatChannel(q, 1, 11, 480);
  assert.deepEqual(r?.map((m) => m.id), [12, 13]);
  assert.equal(r?.[0].text, "m12");
  assert.equal(r?.[0].to, ""); // fora do privado nao le o destinatario
});

test("primeira leitura para no limite; privado traz o destinatario", async () => {
  const list = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, from: "a", to: "MeuChar", text: "x", self: i === 49 }));
  const { q } = fakeChat(list);
  const r = await readChatChannel(q, 3, -1, 0, 5);
  assert.deepEqual(r?.map((m) => m.id), [46, 47, 48, 49, 50]);
  assert.equal(r?.[4].to, "MeuChar");
  assert.equal(r?.[4].self, true);
});

test("privado: o outro lado da conversa e quem mandou, ou o destino quando fui eu", async () => {
  const list = [{ id: 1, from: "Amigo", to: "MeuChar", text: "oi", sid: 5, rid: 9 }, { id: 2, from: "MeuChar", to: "Amigo", text: "oi", self: true, sid: 9, rid: 5 }];
  const { q } = fakeChat(list);
  const r = await readChatChannel(q, 3, -1, 0);
  assert.deepEqual(r?.map((m) => [m.peer, m.peerId]), [["Amigo", "4294967301"], ["Amigo", "4294967301"]]);
  assert.equal(roleId(-1, 0), "4294967295"); // metade de baixo negativa no GETP
});

test("jogo reaberto: ids recomecam e a leitura volta do zero", async () => {
  const list = [1, 2, 3].map((id) => ({ id, from: "a", text: "x" }));
  const { q } = fakeChat(list);
  const r = await readChatChannel(q, 1, 500, 0);
  assert.deepEqual(r?.map((m) => m.id), [1, 2, 3]);
  const m = (id: number): ChatMessage => ({ id, from: "", to: "", text: "", self: false, at: 0, peerId: "", peer: "" });
  assert.deepEqual(mergeChat([m(499), m(500)], r ?? []).map((x) => x.id), [1, 2, 3]);
});

test("canal que nunca recebeu mensagem volta vazio", async () => {
  const { q } = fakeChat(null);
  assert.deepEqual(await readChatChannel(q, 7, -1, 0), []);
});

test("antes de mandar: texto, tamanho, nivel, intervalo do canal e destino do privado", () => {
  const now = 100000;
  assert.equal(chatSendCheck("mundo", "  oi\n todos ", { now, level: 87 }).text, "oi todos");
  assert.equal(chatSendCheck("mundo", "oi", { now, level: 87 }).ok, true);
  assert.equal(chatSendCheck("mundo", "   ", { now }).ok, false);
  assert.equal(chatSendCheck("mundo", "x".repeat(201), { now }).ok, false);
  assert.equal(chatSendCheck("mundo", "oi", { now, level: 9 }).erro, "o Mundo pede Lv.10");
  assert.match(chatSendCheck("mundo", "oi", { now, lastSentAt: now - 5000 }).erro ?? "", /espere 15 s/);
  assert.equal(chatSendCheck("mundo", "oi", { now, lastSentAt: now - 20000 }).ok, true);
  assert.equal(chatSendCheck("guilda", "oi", { now, lastSentAt: now - 1000 }).ok, true);
  assert.equal(chatSendCheck("privado", "oi", { now }).ok, false);
  assert.equal(chatSendCheck("privado", "oi", { now, to: "4294967301" }).ok, true);
  assert.equal(chatSendCheck("loja", "oi", { now }).ok, false);
});

test("corpo do say: canal, destino so no privado e texto UTF-8 em hex", () => {
  assert.equal(sayBody(1, "123", "oi a"), "say 1 0 6f692061");
  assert.equal(sayBody(3, "123", "ç"), "say 3 123 c3a7");
});

test("juntar nao repete mensagem e guarda so as ultimas", () => {
  const m = (id: number): ChatMessage => ({ id, from: "", to: "", text: "", self: false, at: 0, peerId: "", peer: "" });
  assert.deepEqual(mergeChat([m(1), m(2)], [m(2), m(3)]).map((x) => x.id), [1, 2, 3]);
  assert.deepEqual(mergeChat([m(1), m(2)], [m(3), m(4)], 3).map((x) => x.id), [2, 3, 4]);
});
