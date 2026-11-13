import assert from "node:assert";
import { test } from "node:test";

import { buildNav, parseNavText } from "../navmesh";

test("navmesh: le o texto do NAVM (vertices x,z, triangulos e areas)", () => {
  const r = parseNavText("v 0,0,10,0,10,10,0,10|t 0,1,2,0,2,3|a 0,0");
  assert.deepEqual(r, { v: [0, 0, 10, 0, 10, 10, 0, 10], t: [0, 1, 2, 0, 2, 3], a: [0, 0] });
  assert.equal(parseNavText("v 0,0,1|t 0,1,2|a "), null); // vertice pela metade
  assert.equal(parseNavText(""), null);
});

test("quadrado de 2 triangulos: a diagonal nao e parede, os 4 lados sao", () => {
  const n = buildNav(parseNavText("v 0,0,10,0,10,10,0,10|t 0,1,2,0,2,3|a 0,0")!);
  assert.equal(n.tris.length, 12); // 2 triangulos x 3 pontos x (x,z)
  assert.equal(n.walls.length / 4, 4);
});

test("emenda de blocos: vertice repetido na mesma posicao nao vira parede", () => {
  // mesmo quadrado, mas o segundo triangulo usa copias dos vertices 0 e 2
  const n = buildNav(parseNavText("v 0,0,10,0,10,10,0,10,0,0,10,10|t 0,1,2,4,5,3|a 0,0")!);
  assert.equal(n.walls.length / 4, 4);
});

test("triangulo nao andavel (area 1) e degenerado ficam de fora", () => {
  const n = buildNav(parseNavText("v 0,0,10,0,10,10,0,10|t 0,1,2,0,2,3,0,0,1|a 0,1,0")!);
  assert.equal(n.tris.length, 6); // so o primeiro
  assert.equal(n.walls.length / 4, 3);
});
