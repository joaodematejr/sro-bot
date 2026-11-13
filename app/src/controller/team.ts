// Time (party) no Treino: o jogo da bonus de EXP e SP por membro (2 = 5% ate
// 6 = 25%). Modo membro: sem time, entra num time aberto da lista do jogo.
// Logica pura; o main le a lista e manda entrar.
//
// Por metodo (ver engine/DISCOVERY.md, "Time (party)"):
//   lista:  callsi XTeamDocument ReqTeamList 1 1  -> XTeamDocument _TeamList
//   entrar: callx XTeamDocument ReqTeamOp 7 -- i:2 q:<teamID> n i:1 s: i:0 u:0
//           (TeamOperate JOIN, membro NORMAL; provado ao vivo 2026-11-07 12:15 no #7777).
//           O TryJoinTeam (XTeamView) entrava ate a atualizacao do jogo das 07:52;
//           depois dela o servidor recusa calado.
//   sair:   callp XTeamView _MyTeamHandler _DoLeaveFromTeam 1  (o botao Leave; provado ao vivo)

export interface TeamConfig {
  join: boolean; // sem time, entra num time aberto
  sameMapOnly: boolean; // so times com o lider no mesmo mapa (prefixo do canal)
  // Party (controller/party.ts):
  lead?: boolean; // sem time, cria um e fica de lider (no lugar do join)
  openAutoJoin?: boolean; // lider: entrada automatica ligada (quem pede entra sozinho)
  acceptRequests?: boolean; // lider: aceita os pedidos de entrada
  invite?: string[]; // lider: convida estes nomes quando ha vaga
  acceptFrom?: string[]; // sem time: aceita convite destes nomes
  acceptFriendsGuild?: boolean; // sem time: aceita convite de amigo ou da guilda
  follow?: boolean; // membro: segue o lider (o Follow do jogo)
}

export interface TeamBrief {
  teamID: number;
  cur: number;
  total: number;
  line: number; // canal do lider; o mapa e o prefixo (304 -> mapa 3)
  autoJoin: boolean; // entra sem o lider aceitar
  pwd: boolean;
  minLv: number;
  maxLv: number;
}

// Bonus de EXP e SP por numero de membros (tela do jogo).
export function teamBonusPct(members: number): number {
  return [0, 0, 5, 10, 15, 20, 25][Math.max(0, Math.min(6, members))] ?? 0;
}

const mapOf = (line: number) => Math.floor(line / 100);

// Times que da pra entrar agora (vaga, sem senha, aceita o nivel e entra sozinho),
// do melhor pro pior: mesmo mapa (membros cacando perto) e depois o maior bonus.
// `skip`: times que recusaram ha pouco (o #6003 recusou calado a manha toda e
// era sempre o escolhido).
export function rankTeams(teams: TeamBrief[], level: number, line: number | undefined, cfg: TeamConfig,
  skip: ReadonlySet<number> = new Set()): TeamBrief[] {
  const same = (t: TeamBrief) => line !== undefined && mapOf(t.line) === mapOf(line);
  const ok = teams.filter(
    (t) => t.autoJoin && !t.pwd && t.cur < t.total && t.minLv <= level && level <= t.maxLv && (!cfg.sameMapOnly || same(t))
      && !skip.has(t.teamID),
  );
  const score = (t: TeamBrief) => (same(t) ? 1000 : 0) + teamBonusPct(t.cur + 1) * 10 + t.cur;
  return ok.sort((a, b) => score(b) - score(a));
}

export function pickTeam(teams: TeamBrief[], level: number, line: number | undefined, cfg: TeamConfig,
  skip?: ReadonlySet<number>): TeamBrief | undefined {
  return rankTeams(teams, level, line, cfg, skip)[0];
}

// Time que recusou fica de fora por isso; tentativas por checagem.
export const TEAM_REFUSED_MS = 30 * 60 * 1000;
export const TEAM_TRIES = 3;

export function joinTeamBody(teamID: number): string {
  return `callx XTeamDocument ReqTeamOp 7 -- i:2 q:${Math.floor(teamID)} n i:1 s: i:0 u:0`;
}

export const TEAM_LIST_BODY = "callsi XTeamDocument ReqTeamList 1 1";
export const LEAVE_TEAM_BODY = "callp XTeamView _MyTeamHandler _DoLeaveFromTeam 1";

// Num time so com ele (visto 2026-11-07 09:13: o char principal ficou lider de um time de
// 1, bonus 0%, e o Treino nao procurava outro): sai pra entrar num com gente na
// proxima checagem. Com 2 ou mais fica: sair e garantido, entrar nao (o servidor
// recusa calado as vezes), e trocar 5% por 0% e pior.
export function shouldLeaveTeam(members: number | undefined, cfg: TeamConfig): boolean {
  return cfg.join && !cfg.lead && members !== undefined && members <= 1;
}

type Query = (tag: string, body: string) => Promise<Record<string, unknown>>;
const num = (r: Record<string, unknown>) => (typeof r.int === "number" ? r.int : undefined);

export async function readInTeam(q: Query): Promise<{ inTeam: boolean; members?: number }> {
  const r = await q("GETP", "XTeamDocument get_bInTeam");
  if (r.bool !== true) return { inTeam: false };
  return { inTeam: true, members: num(await q("GETP", "XTeamDocument _MyTeam members get_Count")) };
}

// Le a lista ja pedida (ReqTeamList). Le primeiro o que filtra (vaga e auto-join)
// pra nao gastar leituras com time cheio.
export async function readTeamList(q: Query, max = 100): Promise<TeamBrief[]> {
  const n = Math.min(max, num(await q("GETP", "XTeamDocument _TeamList get_Count")) ?? 0);
  const out: TeamBrief[] = [];
  for (let i = 0; i < n; i++) {
    const it = `XTeamDocument _TeamList get_Item:${i}`;
    const g = async (f: string) => q("GETP", `${it} ${f}`);
    const cur = num(await g("currentMemberCount")) ?? 0;
    const total = num(await g("totalMemberCount")) ?? 0;
    const autoJoin = (await g("IsAutoJoin")).bool === true;
    if (cur >= total || !autoJoin) continue;
    out.push({
      teamID: num(await g("teamID")) ?? 0,
      cur,
      total,
      line: num(await g("leaderLine")) ?? 0,
      autoJoin,
      pwd: (await g("hasPwd")).bool === true,
      minLv: num(await g("teamSettingInfo get_min_level")) ?? 0,
      maxLv: num(await g("teamSettingInfo get_max_level")) ?? 999,
    });
  }
  return out;
}
