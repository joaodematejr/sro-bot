import assert from "node:assert";
import { test } from "node:test";

import { EVENT_GATE_MAX_MS, eventHolding, nextEventGate, NO_EVENT } from "../eventgate";

const T0 = Date.UTC(2026, 10, 24, 12, 56); // 09:56 em Brasilia

test("portao abre com o evento lido aberto e segura a fila", () => {
  const g = nextEventGate(NO_EVENT, "Sekhmet War", T0);
  assert.deepEqual(g, { name: "Sekhmet War", since: T0 });
  assert.equal(eventHolding(g, T0 + 60_000), "Sekhmet War");
});

// 2026-11-24: a Sekhmet fechou e a fila ficou parada ate o app ser reaberto.
test("portao fecha quando a leitura diz que nada esta aberto", () => {
  const g = nextEventGate(NO_EVENT, "Sekhmet War", T0);
  const closed = nextEventGate(g, "", T0 + 5 * 60_000);
  assert.deepEqual(closed, NO_EVENT);
  assert.equal(eventHolding(closed, T0 + 5 * 60_000), "");
});

test("mesmo evento seguido mantem o inicio; outro evento reinicia a contagem", () => {
  const g = nextEventGate(NO_EVENT, "Guild Boss", T0);
  assert.equal(nextEventGate(g, "Guild Boss", T0 + 10 * 60_000).since, T0);
  const other = nextEventGate(g, "Sekhmet War", T0 + 10 * 60_000);
  assert.deepEqual(other, { name: "Sekhmet War", since: T0 + 10 * 60_000 });
});

test("validade de 40 min: leitura presa em aberto nao segura a fila pra sempre", () => {
  let g = nextEventGate(NO_EVENT, "Sekhmet War", T0);
  assert.equal(eventHolding(g, T0 + EVENT_GATE_MAX_MS - 1), "Sekhmet War");
  assert.equal(eventHolding(g, T0 + EVENT_GATE_MAX_MS), "");
  // A leitura segue dizendo aberto: nao volta a segurar (o inicio nao muda).
  g = nextEventGate(g, "Sekhmet War", T0 + EVENT_GATE_MAX_MS + 5000);
  assert.equal(eventHolding(g, T0 + EVENT_GATE_MAX_MS + 5000), "");
  assert.equal(eventHolding(g, T0 + 20 * 3600 * 1000), "");
});

test("sem evento a fila fica livre", () => {
  assert.equal(eventHolding(NO_EVENT, T0), "");
  assert.deepEqual(nextEventGate(NO_EVENT, "", T0), NO_EVENT);
});
