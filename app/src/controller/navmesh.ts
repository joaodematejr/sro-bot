// Paredes e areas bloqueadas do Mapa: o navmesh da cena (o mesmo que o jogo usa
// pra achar caminho, NavMesh.CalculateTriangulation pelo engine NAVM). O que esta
// no navmesh da pra andar; o resto fica escuro. Parede = aresta de triangulo sem
// vizinho do outro lado.

// Texto do engine: "v x,z,x,z,...|t a,b,c,...|a area,...".
export interface NavRaw {
  v: number[]; // x,z por vertice
  t: number[]; // 3 indices por triangulo
  a: number[]; // area de cada triangulo (pode faltar)
}

export interface NavMap {
  tris: number[]; // x1,z1,x2,z2,x3,z3 por triangulo andavel
  walls: number[]; // x1,z1,x2,z2 por parede
}

// Area 1 do Unity e "Not Walkable": nao entra.
const NOT_WALKABLE = 1;

export function parseNavText(s: string): NavRaw | null {
  const parts = new Map<string, string>();
  for (const p of s.split("|")) {
    const k = p.slice(0, 1);
    parts.set(k, p.slice(2));
  }
  const nums = (k: string) => {
    const x = parts.get(k);
    return x ? x.split(",").map(Number) : [];
  };
  const v = nums("v");
  const t = nums("t");
  if (!v.length || !t.length || v.length % 2 || t.length % 3 || v.some(Number.isNaN) || t.some(Number.isNaN)) return null;
  return { v, t, a: nums("a") };
}

export function buildNav(raw: NavRaw): NavMap {
  // O navmesh vem em blocos com vertices repetidos na emenda: junta pela posicao
  // (0,1 m) pra emenda nao virar parede.
  const weld = new Map<string, number>();
  const id: number[] = [];
  for (let i = 0; i < raw.v.length / 2; i++) {
    const key = `${Math.round(raw.v[i * 2] * 10)},${Math.round(raw.v[i * 2 + 1] * 10)}`;
    let w = weld.get(key);
    if (w === undefined) {
      w = weld.size;
      weld.set(key, w);
    }
    id.push(w);
  }
  const tris: number[] = [];
  const edges = new Map<string, { n: number; a: number; b: number }>();
  const nv = raw.v.length / 2;
  for (let k = 0; k < raw.t.length / 3; k++) {
    if (raw.a[k] === NOT_WALKABLE) continue;
    const c = [raw.t[k * 3], raw.t[k * 3 + 1], raw.t[k * 3 + 2]];
    if (c.some((i) => i < 0 || i >= nv)) continue;
    if (id[c[0]] === id[c[1]] || id[c[1]] === id[c[2]] || id[c[0]] === id[c[2]]) continue; // degenerado
    for (const i of c) tris.push(raw.v[i * 2], raw.v[i * 2 + 1]);
    for (let e = 0; e < 3; e++) {
      const a = c[e], b = c[(e + 1) % 3];
      const wa = id[a], wb = id[b];
      const key = wa < wb ? `${wa}:${wb}` : `${wb}:${wa}`;
      const cur = edges.get(key);
      if (cur) cur.n++;
      else edges.set(key, { n: 1, a, b });
    }
  }
  const walls: number[] = [];
  for (const e of edges.values()) {
    if (e.n === 1) walls.push(raw.v[e.a * 2], raw.v[e.a * 2 + 1], raw.v[e.b * 2], raw.v[e.b * 2 + 1]);
  }
  return { tris, walls };
}
