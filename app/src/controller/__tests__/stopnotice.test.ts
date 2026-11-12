import assert from "node:assert";
import { test } from "node:test";

import { clearsNotice, nextNotice, noticeFromLog } from "../stopnotice";

test("linhas reais do log viram aviso com o que fazer", () => {
  const t = noticeFromLog("[14:20:01] [treino] concluido: limite de mortes (3/3).", 5);
  assert.deepEqual(t && { level: t.level, text: t.text, at: t.at }, { level: "stop", text: "Treino parou: limite de mortes (3/3).", at: 5 });
  assert.match(t!.hint, /Iniciar bot/);
  assert.equal(noticeFromLog('a conta entrou em outro aparelho ("logged in on another device"): bot parado, sem relogar.', 0)?.level, "stop");
  assert.equal(noticeFromLog("falha ao reabrir: adb sem resposta", 0)?.text, "O jogo nao reabriu: adb sem resposta.");
  assert.equal(noticeFromLog("Mochila cheia: 0 espaco(s) livre(s). O AutoBuy nao repoe pocao", 0)?.level, "warn");
  assert.equal(noticeFromLog("EXP/h caiu de 23,8 M pra 2,1 M nos ultimos 20 min. Confira", 0)?.text, "EXP/h caiu de 23,8 M pra 2,1 M nos ultimos 20 min.");
  assert.equal(noticeFromLog("[watchdog] conexao com o servidor caiu: reiniciando o jogo...", 0)?.level, "info");
  assert.equal(noticeFromLog("jogo congelado; reiniciando o jogo...", 0)?.level, "info");
});

test("linha comum nao vira aviso", () => {
  for (const l of ["[treino] chegou no ponto 2", "[treino] morreu (1/3).", "Firm concluido (2 entregue(s) nesta passada).", "treino parado.", "[continental] concluido (sem dados): 3 rolagem(ns)"])
    assert.equal(noticeFromLog(l, 0), undefined, l);
});

test("bot iniciado limpa; aviso leve nao cobre um grave", () => {
  assert.equal(clearsNotice("[09:00:00] bot iniciado: rodando atividades ativas."), true);
  assert.equal(clearsNotice("bot parado."), false);
  const stop = noticeFromLog("[treino] concluido: limite de mortes (3/3).", 1)!;
  const info = noticeFromLog("jogo congelado; reiniciando o jogo...", 2)!;
  assert.equal(nextNotice(stop, info), stop);
  assert.equal(nextNotice(info, stop), stop);
  assert.equal(nextNotice(null, info), info);
});
