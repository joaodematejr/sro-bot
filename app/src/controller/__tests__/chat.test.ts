import assert from "node:assert";
import { test } from "node:test";

import { chatChannelId, chatTimeMs, cleanChatText, type ChatMessage, mergeChat, parseTzOffset, readChatChannel } from "../chat";

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
function fakeChat(list: { id: number; from: string; to?: string; text: string; self?: boolean }[] | null) {
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
  const list = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, from: "a", to: "xJoao", text: "x", self: i === 49 }));
  const { q } = fakeChat(list);
  const r = await readChatChannel(q, 3, -1, 0, 5);
  assert.deepEqual(r?.map((m) => m.id), [46, 47, 48, 49, 50]);
  assert.equal(r?.[4].to, "xJoao");
  assert.equal(r?.[4].self, true);
});

test("jogo reaberto: ids recomecam e a leitura volta do zero", async () => {
  const list = [1, 2, 3].map((id) => ({ id, from: "a", text: "x" }));
  const { q } = fakeChat(list);
  const r = await readChatChannel(q, 1, 500, 0);
  assert.deepEqual(r?.map((m) => m.id), [1, 2, 3]);
  const m = (id: number): ChatMessage => ({ id, from: "", to: "", text: "", self: false, at: 0 });
  assert.deepEqual(mergeChat([m(499), m(500)], r ?? []).map((x) => x.id), [1, 2, 3]);
});

test("canal que nunca recebeu mensagem volta vazio", async () => {
  const { q } = fakeChat(null);
  assert.deepEqual(await readChatChannel(q, 7, -1, 0), []);
});

test("juntar nao repete mensagem e guarda so as ultimas", () => {
  const m = (id: number): ChatMessage => ({ id, from: "", to: "", text: "", self: false, at: 0 });
  assert.deepEqual(mergeChat([m(1), m(2)], [m(2), m(3)]).map((x) => x.id), [1, 2, 3]);
  assert.deepEqual(mergeChat([m(1), m(2)], [m(3), m(4)], 3).map((x) => x.id), [2, 3, 4]);
});
