# Descoberta em runtime (passo 1)

O engine, rodando in-process, enumera o IL2CPP por nome e grava um dump das
classes de gameplay com os offsets dos campos. Tudo lido da metadata que o
jogo ja carregou e decifrou na memoria. Nada decifrado em disco.

Feito na tela de titulo (sem login). Achados:

## Assemblies

- `XMainClient.dll`: 9589 classes. E o assembly hot-update (HybridCLR) com a
  logica do jogo. So fica disponivel depois do hot-update, no titulo.
- `Core.dll`: 1624 classes. `Assembly-CSharp.dll`: utilitarios Unity.

## Classes de entidade

- `XMainClient.XRole`: classe base das entidades (tem `_capsule1/2`, `RoleLayer`,
  `Team`, timers). Posicao e vida NAO sao campos diretos aqui: devem vir de uma
  classe-base/atributos ou do `transform` da Unity.
- `XMainClient.XPlayer`: o jogador (deriva de XRole). Campos diretos sao de job
  (sumpter, teleport, channel change), nao atributos.

## Protocolo de rede: namespace `KKSG`

Centenas de mensagens ProtoBuf em `KKSG.*` (ex.: `BMRoleEnter`, `DragonGroupRoleInfo`,
`Buff`, `ChatInfo`). Muitas tem campos de posicao/vida/nivel. E o estado
autoritativo vindo do servidor (posicao X/Y/Z, mapa, linha).

## Mapa do objeto do jogador (observado em mundo)

Cadeia de classes: `XPlayer -> XRole -> XEntity -> XObject -> System.Object`.

Acesso ao jogador local:

- `XMainClient.XEntityMgr`, campo `<Player>k__BackingField` no offset **0xf8**,
  aponta para o `XPlayer` local.

Campos de posicao no `XEntity`:

- `_correctedPosition` offset **0x204** (Vector3, 3 floats)
- `_next_pos` offset **0x138** (Vector3)
- `_movement` 0x168, `_server_movement` 0x174, `_moveComponent` 0xb0,
  `_xobject` 0x180 (GameObject da Unity)

Atributos: em `XObject._attr` offset **0x18**, aponta para
`XMainClient.XPlayerAttributes`. Campos lidos vivos (batendo com a tela):

- `_level` 0x184 (int) = 23
- `<Exp>` 0x1d0 / `<MaxExp>` 0x1d8 (int) = 376420 / 964570 = 39.02% (= tela)
- `_profession` 0x238, `_gender` 0x280 (int)
- `_name` 0x80 (ponteiro de Il2CppString), `appear_pos` 0x188 (float)
- `_name` 0x80 lido como Il2CppString = o nome do char (len em +0x10, chars UTF-16 em +0x14).
- HP/MP: ACHADOS via METODO (scan de memoria falhou porque sao doubles num
  container indexado por enum). A classe `XAttributes` (base de XPlayerAttributes)
  tem `GetAttr(XMainClient.XAttributeDefine) -> double`. O enum XAttributeDefine:
  - 2012 = XAttr_CurrentHP_Total, 2011 = XAttr_MaxHP_Total
  - 2016 = XAttr_CurrentMP_Total, 2015 = XAttr_MaxMP_Total
  - (os `_Basic` 11/12/15/16 sao a base; `_Total` 20xx e o valor final da tela)
  Chamada: `il2cpp_runtime_invoke(GetAttr, attr, {&enumInt})` devolve um System.Double
  BOXED; o valor sao os 8 bytes em ret+0x10 lidos como double. Display: round no
  atual, ceil no maximo. Resultado (testado): engine HP 2638/2638, MP 8555/8556
  = identico a tela. No RESP: hp/maxHp/mp/maxMp.
  Licao: valores de atributo sao DOUBLE, nao int/float, e so acessiveis por
  GetAttr(enum), nao por offset de campo.

Falta so o ponteiro do singleton do `XEntityMgr`. Ele usa o padrao
`XSingleton<T>` (classe generica `Singleton` com estaticos `Value`/`ThreadValue`).

### Como achar o singleton (resolvido)

Resolver o singleton pelo getter: `il2cpp_class_get_method_from_name(XEntityMgr,
"get_singleton", 0)` e `il2cpp_runtime_invoke`. Isso dispara so o cctor do
proprio XEntityMgr (esperado) e devolve a instancia.

NAO varrer todos os campos estaticos da cadeia com `field_static_get_value`:
ler um estatico nao inicializado dispara o cctor daquela classe e pode travar
a thread do engine (foi o que aconteceu antes).

### Leitura viva validada

Caminho confirmado em mundo, posicao variando enquanto o personagem anda:

    XEntityMgr.singleton -> +0xf8 (XPlayer) -> _correctedPosition +0x204 (Vector3)

Exemplo (3 leituras andando): `[2021.71,49.46,2379.71]`,
`[2051.56,49.44,2371.26]`, `[2087.91,49.44,2348.07]`. `_next_pos` (+0x138)
veio zero; usar `_correctedPosition`.

## Agir (chamar metodos): mecanismo ok, movimento precisa da thread principal

Metodos de gameplay enumerados (comando DMET -> sro_methods.txt), com assinatura:

- Movimento: `XNavigationComponent.Navigate(UnityEngine.Vector3)`,
  `XPlayer.PositionTo(UnityEngine.Vector3)`, `XEntity.Move()`,
  `XPlayer.MovePlayer()`.
- Skill: `XSkillComponent.FireSkill(4)`, `OnAttack(1)`, `get_SkillCanCast()`.
- Combate (auto-hunt): mapa PROVADO ao vivo (char nivel 60, Traveler's Hill).
  O toggle real do botao de auto-hunt do client sao DOIS metodos, e so os dois
  juntos ligam do zero:
  - **Ligar:** `XAIComponent.EnableBehaviorTree(true)` religa o cerebro da IA,
    depois `SetAutoEnable(1,1)` no `_ai` (0xd8) engaja e
    `XPlayerAttributes.set_AutoPlayOn(1)` no `_attr` (0x18) sustenta a caca
    continua. So os tres juntos ligam do zero: `SetAutoEnable(1,1)` sozinho so
    engaja uma vez; `set_AutoPlayOn(1)` sozinho nao inicia; e se a BT estiver
    desligada por um stop anterior, sem `EnableBehaviorTree(1)` nao recupera.
  - **Parar:** `set_AutoPlayOn(0)` + `SetAutoEnable(0,0)` + **`EnableBehaviorTree(false)`**.
    O passo decisivo e desligar a behavior tree: so os flags sao sobrepostos, a
    BT continua rodando e **re-engaja ~3 s depois**. Com a BT desligada o char
    para e fica parado (provado 14s+). Candidatos que NAO param (todos re-engajam):
    `SetAutoEnable(0,0)`, `set_AutoPlayOn(0)`, `SendAutoFightMsg(0)`, `ResetAIData`,
    `ClearAllTimer`, `ResetBehaviorTree`.
  - `XAIComponent.SendAutoFightMsg(System.Boolean)` NAO liga/desliga a IA local:
    e um "Send...Msg" que so notifica o servidor. Descartado como toggle.
  - Sinais de estado NAO confiaveis: `get_AutoPlayOn()` oscila a cada leitura
    (nao usar) e nao reflete o estado do botao; `get_IsFighting()` fica grudado
    em true depois do stop. Deteccao de "caçando" fica por delta de MP/posicao.
    No RESP: `autoPlayOn`, `aiFighting` ficam so como informativo bruto.
  - LIMITACAO (nao resolvida): o botao de auto-hunt do client reflete estado
    SERVER-SIDE (via a RPC `RpcC2G_ReqPlayerAutoPlay` e o handler
    `XMainClient.XAutoPlayDocument.OnAutoFight(bool)`), nao os flags locais. Parar
    pela BT para o char mas o botao continua aceso. Apagar o botao exigiria
    chamar `OnAutoFight(false)` no document, que esse engine guarda atras de
    `XUtliPoolLib.XInterfaceMgr.GetInterface(id)` (id do document desconhecido),
    ou tocar no botao por `adb input tap`. E so visual: o char fica parado.
  - Ferramentas de RE no engine (comando SKIL): `call <metodo> <argc> <a1> <a2>`
    chama metodo no `_ai`; `calls <Classe> <metodo> <argc> <a1> <a2>` chama num
    singleton; `FIND <kw>` lista classes de gameplay cujo nome casa a keyword.
  - `FireSkill` pede 4 objetos (XSkill, XEntity, XSkillCore, XAttackEventArgs),
    caro de montar; fica para um cast manual depois. Na mesma classe:
    `SetTarget(XEntity)`, `get_TargetMonster()`, `HasTargetInRange(float)`.

Invocacao via `il2cpp_runtime_invoke` a partir da thread do engine:

- `PositionTo(Vector3)` roda SEM excecao e SEM crash, mas NAO move o personagem
  (posicao e minimapa inalterados). Movimento e server-authoritative: setar
  posicao local nao dispara o move em rede.
- `Navigate(Vector3)` lanca EXCECAO: opera NavMesh, que na Unity exige a thread
  principal. Chamar da thread do engine quebra.

Conclusao: o mecanismo de chamar metodos funciona (nao trava), mas mover de
verdade precisa rodar na THREAD PRINCIPAL do jogo.

### Tentativa de hook de Update (fila de acoes) e a parede do HybridCLR

Implementado: fila de acoes (tag "MOVE x y z" enfileira) + hook por troca do
`methodPointer` (offset 0 do MethodInfo, via mprotect) de `XEntity.Update(float,bool)`,
para drenar a fila e rodar `Navigate` na thread principal.

Resultado: o hook INSTALA (methodPointer original nao-nulo, sem crash) mas NUNCA
e chamado (log "hook_update CHAMADO" nao aparece). Motivo: `XEntity.Update` e um
metodo INTERPRETADO (HybridCLR, assembly XMainClient) chamado de dentro de outro
codigo interpretado (o loop do XEntityMgr). O interpretador despacha direto, sem
passar pelo `methodPointer` nativo. Trocar o methodPointer so intercepta a
fronteira AOT->interpretado (quando codigo nativo chama o metodo via methodPointer).

### RESOLVIDO: hook de UnityMainThreadDispatcher.Update (MOVER FUNCIONA)

O ponto de hook certo e uma MonoBehaviour AOT cujo Update() (0 params) a Unity
NATIVA chama todo frame via methodPointer. Enumerando MonoBehaviours com
Update()/LateUpdate() (comando "DMB "), achamos no Core.dll:

    Core.dll | UnityMainThreadDispatcher  Update()   <- este
    Core.dll | UIRoot  Update()

Hook: trocar o methodPointer de `UnityMainThreadDispatcher.Update()`
(namespace vazio, Core.dll) pelo nosso. Como e AOT e chamado pela Unity nativa,
o hook DISPARA (ao contrario de XEntity.Update, interpretado).

Resultado (testado): comando `MOVE x y z` enfileira; o hook drena na thread
principal e chama `Navigate(Vector3)` SEM excecao; o personagem ANDA por
pathfinding ate o ponto. Ex.: de (2064,2949) para (2144,3030), chegando em ~14s.

Logs: "hook_update CHAMADO" e "exec Navigate main-thread ... exc=nao".

Feito e TESTADO ao vivo: comando `SKIL` liga/desliga o auto-hunt pela mesma fila
de thread principal. `{"on":1}` -> START (SetAutoEnable(1,1) + AutoPlayOn=1) faz
o char caçar do zero; `{"on":0}` -> STOP para. O corpo tambem aceita, para RE,
`setauto A B` / `autoplay N` / `fightmsg N` / `enterfight` para disparar cada
metodo isolado. Logs: `exec START ...` / `exec STOP ...`.

## Demon Locking Tower: estado lido por metodo (2026-11-05)

Tudo confirmado contra a tela. Prefixos: `D` = `ActivityTeamTowerSingleDlg`,
`B` = `D m_uiBehaviour`, `T` = `D _doc _SingleTowerData` (`XMainClient.TeamTowerData`).

| Dado | Leitura | Como foi confirmado |
|---|---|---|
| Reward multiple do sweep | `GETP T refreshResult` (System.Single; o GETP devolve os 32 bits no `int`) | 0x3F800000 = 1.0 com a tela em "1.0x"; depois de um Free refresh, 0x3FA66666 = 1.3 com a tela em "1.3x" e recompensas 2600/195 (2000 e 150 x 1.3) |
| Label do multiple | `GETP B mRewardAlpha GetText` | anima valores aleatorios por ~3 s (mostrou "1.4x") e fixa no `refreshResult`; o botao fica cinza enquanto anima |
| Refreshes gratis | `GETP B mRewardFreeTime GetText` ("4/5") | 5/5 -> 4/5 no Free refresh; `T refreshcount` sobe 0 -> 1 |
| Frame do resultado do sweep | `GETP B mSweepResult IsVisible` | true com o frame "Sweep / Reward multiple" aberto |
| Claim do sweep | `callsn D OnGetReward 1` | fecha o frame; `_sweep_finished` 1 -> 0, `T sweepfloor` 1 -> 0, `refreshcount` -> 0, `refreshResult` -> 1.0; chat "Receive Gold*195" |
| Sweeps restantes | `GETP B mResetNum GetText` ("Sweep[6acb3b] 0/1") | bate com o "Sweep 0/1" da tela |
| Sweep rodando | `GETP D _in_sweeping` | |
| First Bonus pendente | `getv D HasFirstRewardRedPoint` | bolinha vermelha do botao; vale com o Dlg na tela (escondido fica velho) |
| Andar mais alto passado | `GETP T maxlevel` | 1 com a tela em "Floor 2"; 13 depois de cair no 14 |
| Topo da torre | `GETP D _tower_max_floor` | 300 |
| Na torre / andar | `GETP XScene _scene_type` = 16, `_scene_id` = 102000 + andar | mundo aberto (Jangan) = 76 / 100001; subiu 102002 -> 102014 sozinho |
| Queda | `getv XLevelRewardView IsVisible` + `GETP XLevelRewardView _doc get_IsStageFailed` | tela LOSE "Current floor: 14"; o handler e `LevelRewardStageFailHandler` (`_StageFailHandler`, nao singleton) |

Comportamento observado:
- A vitoria num andar passa sozinha (Continue 5s) e o auto-hunt sobe andar a
  andar (~35 s cada). A derrota NAO sai sozinha: o char fica morto na tela LOSE
  (Return / Challenge again) dentro da cena da torre ate alguem agir.
- Modo sono do jogo (`XSleepModeUI`, "Slide to unlock") liga sozinho com o jogo
  parado e esconde o dialogo da torre. Sai por `calls XSleepModeUI SetVisible 1 0`;
  depois aparece o resumo `XBattleRewardDlg`, fechado por `callsn XBattleRewardDlg _OnClicked2 1`.
  A subida continua normal com o modo sono ligado.
- Logo depois de fechar o resumo o `SetVisible` do dialogo da torre pode nao
  pegar (animacao); repetir resolve.

Engine: `SKIL callp <Classe> [campo...] <metodo> <argc>` chama metodo com args
de referencia nulos num objeto achado por caminho (o handler do LOSE nao e
singleton). Caminho e metodo resolvidos na thread do socket; a chamada vai pra
fila da main thread com o ponteiro.

Engine (2026-11-06): `SKIL callpi <Classe> [campo...] <metodo> <argc> <i1> <i2>`
e o mesmo com args int32 (sempre os dois no fim). Primeiro uso: trocar de char na
selecao. O `SelectDefaultChar(info)` so muda o destaque da tela; quem decide o
char que entra e o `XSelectCharacterDocument._currentSelectedIndex`, mudado por
`callpi XSelectCharView _doc set_SelectCharIndex 1 <info> 0` (info =
`ConvertSlotToInfoIdx:<slot>`). O documento nao tem singleton, por isso o callsi
nao alcanca.

## Continental Exploration (SuperRisk), 2026-11-05

Nome interno **SuperRisk** (`FIND Risk`; "Continental" nao acha nada). Sem horario:
o limite e o dado (10, regenera com o tempo, "Get the following extra turns").

Tabuleiro de 32 casas numa grade 12x6 (so a borda), sentido horario a partir
de Start (0,0) ate END (0,1). O char fica no tabuleiro entre sessoes.

| Dado | Como ler | Observado |
|---|---|---|
| Dados restantes | `GETP XSuperRiskDocument m_leftDiceTime` | 10 -> 6 rolando; -1/0 ate o mapa carregar |
| Maximo | `GETP XSuperRiskDocument m_maxLeftTimes` | 10 (-1 = mapa ainda nao pedido; tambem fica -1 com o jogo recem-aberto e 0 dados, mesmo com o tabuleiro carregado) |
| Mapa carregado | `GETP XSuperRiskDocument CurrentDynamicInfo get_Count` | 32 com o tabuleiro recebido (vale mesmo com o maximo em -1) |
| Mapa | `GETP XSuperRiskDocument m_curMapID` | 3 = Desert |
| Estado | `GETP XSuperRiskDocument GameState` | 2 parado, 6 animacao do dado, 8 andando |
| Valor do dado | `GETP SuperRiskDlg _GameHandler m_DiceAnimValue` | ultimo valor rolado |
| Posicao | `GETP XSuperRiskMapMgr CurrentMap PlayerCoord` (x) e `PlayerCoord+4` (y) | `Coordinate` {x,y} embutido; o `+4` e do GETP (0.55.0) |
| Tamanho | `GETP XSuperRiskMapMgr CurrentMap StaticInfo get_Width` / `get_Height` | 12 x 6 |
| Casa usada | `CurrentDynamicInfo get_Item:N get_boxState` | 1 disponivel (colorida), 2 usada (cinza na tela) |
| Casas | `XSuperRiskDocument CurrentDynamicInfo get_Item:N` (32, `KKSG.RiskGridInfo`) | `get_x`, `get_y`, `get_gridType`, `get_boxState`, `_rewardItem get_itemID` |
| Baus guardados | `KEYS XSuperRiskDocument SlotBoxInfo` + `get_Item:slot` (`ClientBoxInfo`) | `itemID` 0x14, `state` 0x1c, `leftTime` 0x20 (Single, s) |

Tipo de casa (`gridType`, `ENUM RiskGridType`): 1 EMPTY, 2 NORMALREWARD ("?"),
3 REWARDBOX (bau), 4 ADVENTURE (caveira), 5 DICE (dado extra). O itemID do bau
muda por mapa (Chinese 200..203, Desert 350..353; o 352 do Desert tambem e o END).
A cor sai do proprio jogo: `GETP SuperRiskDlg _GameHandler GetBoxSprNameByState:<itemID>`
devolve `chest_0` verde, `chest_1` azul, `chest_2` roxo, `chest_3` laranja (vazio
para id que nao e bau). Cronometro do destrave: verde 1 h, laranja 8 h. Os campos do `RiskGridInfo` sao `Nullable<int>`:
ler pelo getter, o campo cru so traz o flag.

Acoes provadas (por metodo, sem tap):
- Abrir: `calls SuperRiskDlg SetVisible 2 1 1` (abre na selecao de mapa) e
  `calls SuperRiskDlg ShowGameMap 0` (tabuleiro; e o que pede o mapa ao servidor).
- Rolar: `callsi XSuperRiskDocument RequestDicing 1 <n> 0`. Gasta 1 dado. O
  argumento NAO escolhe a faixa do medidor (1 deu 3, 2 deu 1, 1 deu 2 e 4):
  tratar o resultado como sorteado. `GetRollResult(float)` devolveu 6 pra
  qualquer valor. `_OnRollClick(null)` nao e confiavel (rolou 1 vez, depois so
  abriu o `ItemAccessDlg` do dado; fechar com `callsn ItemAccessDlg OnCloseClicked 1`).
- Cair no bau guarda no espaco livre (state 1, leftTime 3600).
- Destravar: `callsi XSuperRiskDocument ChangeBoxState 2 <slot> 2` -> state 2 e o
  cronometro corre. "Open now" (10 Silk) e o acelerador PAGO: nao usar.
- Estado do bau (`ENUM RiskBoxState`): 1 LOCKED, 2 UNLOCKED (destravando),
  3 CANGETREWARD, 4 GETREWARD, 5 DELETE. Pegar = `ChangeBoxState(slot, 4)` so com
  o bau em 3; descartar = `ChangeBoxState(slot, 5)`.
- Estado do jogo (`ENUM SuperRiskState`): 0 Invalid, 1 Start, 2 ReadyToMove,
  3 ManualSelect, 4 Rolling, 5 SendingRollMes, 6 Dicing, 7 Moving, 8 Event,
  9 RefreshMap, 10 GetBoxAnimation, 11 End.
- Tela: `GETP SuperRiskDlg _GameHandler IsVisible` (tabuleiro) e
  `GETP SuperRiskDlg _SelectMapHandler IsVisible` (selecao de mapa).
- Trocar de mapa: so com a SELECAO na tela. `callsi XSuperRiskDocument
  set_CurrentMapID 1 <id> 0` + `calls SuperRiskDlg ShowGameMap 0`. Com o tabuleiro
  na tela o `ShowGameMap` nao recarrega e o doc fica com um id e a tela com
  outro: fechar (`calls SuperRiskDlg SetVisible 2 0 1`) e reabrir antes.
- Mapas (`GetMapIdByIndex:0..6` = 1..7; `GetCurrentMapData` traz `NeedLevel` e a
  chave do nome; o nome traduzido sai no `_GameHandler m_mapTittleLab GetText`):
  1 Chinese (Lv30), 2 Hotan (Lv45), 3 Desert (Lv60), 4 Roc Mountain (Lv75),
  5 Eastern Europe (Lv80), 6 Asia Minor (Lv85), 7 Central Asia (Lv90). Dados e
  baus sao compartilhados entre mapas; a posicao e por mapa.
- Nome sem abrir o tabuleiro: `GetMapIdByIndex:<i> MapTittleName` e a chave, e
  `Localization Localize:"<chave>"` traduz. `GetMapIdByIndex:<i> BoxPreview` e a
  previa dos baus do mapa.
- Levantamento de 2026-11-11 (char Lv.87, abrindo os 6 mapas liberados pela
  selecao, sem rolar): todos tem o mesmo tabuleiro, 5 baus (2 Bronze, 1 Silver,
  1 Golden, 1 Diamond), ~7 "?", 3 dados extras e 1 caveira. Muda o conteudo: cada
  mapa tem os proprios baus (Chinese 200..203, Hotan 204..207, Desert 350..353,
  Roc Mountain 563..566, Eastern Europe 6168..6171, Asia Minor 6172..6175) e os
  "?" dao cartas dos monstros da regiao (ex.: Pirate e Dark Wolf no Asia Minor),
  alem de Card Fragment, Recast Stone e Grinding Stone. A descricao dos baus nao
  diz o conteudo ("cards or special items").
- `RpcC2G_GetRiskMapInfos` responde com uma lista de mapas, mas o cliente so
  guarda o pedido (`OnGetMapDynamicInfo` filtra por `mapID`): pra ver outro
  mapa, abrir o tabuleiro dele.
- Modo sono (`XSleepModeUI`) liga sozinho com o jogo parado; sair igual a torre.

### Mirar o dado e casa caveira (2026-11-06, 47 rolagens em 4 chars)

- **Os dados sao por personagem**: cada char da conta tem os seus 10 (os 5 chars
  lv60 da conta tinham 10/10, exceto o ja usado). Trocar de char da mais dados.
- `CurrentDynamicInfo` vem por linha (y, depois x), so a borda: (x,0) = x;
  (0,y)/(11,y) do meio = 12 + 2(y-1) (+1 na direita); (x,5) = 20 + x. O caminho
  e horario de Start (0,0) ate END (0,1), 32 casas.
- **`RequestDicing(n)` mira a faixa do medidor**: faixa = ceil(n/2) (1-2, 3-4,
  5-6). Em 47 rolagens 70% cairam na faixa pedida (acaso: 33%); o resto desvia
  quase sempre uma casa (n=6 deu 4 em 4 de 10). Dentro da faixa a face nao e
  controlavel. `n=0` nao rola (o dado nao e gasto). Por faixa: 1-2 15/21, 3-4
  9/12, 5-6 9/14. E a "mira" do dado.
- `GetRollResult(float)` devolve 6 pra qualquer float: nao serve pra mirar.
- **END**: cair nele guarda o bau roxo de chegada (352 no Desert), o mapa
  recarrega (GameState 9) e volta pra 2 sozinho. O bot so precisa esperar.
- **Casa caveira (ADVENTURE)**: leva o char pra uma arena fora do tabuleiro
  (`SuperRiskDlg` some). No fim aparece `XLevelRewardView` com o `_DlgHandler`:
  - derrota = `LevelRewardSuperRiskFailHandler` (tela LOSE): `OnReturnButtonClicked`
    = "Back" (gratis); `OnChallengeAgainButtonClicked` = "Try Again" por 10 Silk
    (PAGO, nunca). Detectar pelo campo `m_ChallengeAgainButton`.
  - vitoria = `LevelRewardSuperRiskHandler` (`OnReturnButtonClicked`, `RefreshReward`).
  - O Back as vezes volta pro tabuleiro, as vezes pro mundo (dialogo fechado).
  - Chars lv60 perderam 2 de 2 (um sem auto-fight, outro com o auto-fight
    ligado na arena). A caveira e casa a evitar na mira.
- O `_StageFailHandler` da torre fica nulo aqui; nao reaproveitar o caminho da torre.

Nao exercitado: descartar bau (`SuperRiskGameHandler.OnClickDiscardBox`/`SendDiscardBoxMes`),
vencer a caveira, Special Chest (`ReqBuyOnlineBox`, pago), troca de mapa pela
selecao (`SuperRiskSelectMapHandler.OnMapClick`, "Lv90 is open").

## Treino: auto-play do proprio jogo (2026-11-06)

O jogo ja tem o auto-play completo no `XAutoPlayDocument`; o bot so configura e
vigia. As opcoes sao o enum `XOptionsDefine` (4001..4042) no `XOptionsDocument`:
`GetValue:<id>` le e `SetValue(id, valor, 1)` grava (persiste no relogin). Os dois
documentos nao tem singleton: o engine acha em `XDocuments.internalIterator`
(`find_document`, 0.56.0). O `XAutoPlayDocument.ProccessOption(id, v)` NAO grava.

| Opcao | Id | Valor |
|---|---|---|
| AutoHeal / AutoBuy / AutoPickUp | 4001 / 4002 / 4003 | 0/1 |
| AutoRevive | 4004 | 0/1 |
| AutoReturnCity / AutoSell | 4005 / 4007 | 0/1 |
| HealHp1/HP2/MP1/MP2Threshold | 4009..4012 | % (30) |
| ReviveTime | 4017 | s (15) |
| RangeFind | 4018 | indice de 20/50/100/200 m (3 = 200 m) |
| PriorTarget | 4020 | 0 Normal, 1 Monster, 2 Player |
| RevivePlace | 4022 | `KKSG.ReviveType`: 1 OnTheSpot (custa item 900), 2 BackCity |
| HpHealItem1/2, MpHealItem1/2 | 4034..4037 | itemID da pocao (0 = espaco vazio) |
| ReturnFarming | 4039 | 0/1 (voltar a cacar no ponto depois de reviver) |
| HealHp/MpSkillThreshold | 4041 / 4042 | % (60) |

- Tela: `calls XAutoPlaySettingDlg SetVisible 2 1 1`; aba Recover =
  `callpi XAutoPlaySettingDlg m_uiBehaviour m_medicine_tab set_bChecked 1 1 0`.
- Pocoes do inventario: com a tela aberta, `SetMedicinePanelVisible(1)` enche
  `XAutoPlaySettingDlg m_XItemListUpdate` (XNormalItem: `itemID`, `itemCount`,
  `itemConf ItemDescription` "Use to restore 820 HP..."). HP X-Large 351002105,
  MP X-Large 351002110. Depois do `SetValue` o `SetupMedicinePanel` redesenha.
- `XReviveDocument`: `get_NormalCostID` 900 x1 (reviver no local),
  `get_SpecialCostID` 7 x3 (pode ser moeda paga: nunca). `ReviveDlg`:
  `OnBtnBackCityClicked` (gratis), `OnBtnOnTheSpotClicked`, `OnCostReviveClicked` (pago).
- Cena: `XScene get_SceneID` (100001 = Jangan). Ponto de treino = cena + CONN
  `corrected`; voltar = `MOVE x y z` (Navigate, mesma cena).
- **Morte provada ao vivo (2026-11-07, char de teste Lv.60 no Lunar, Roc Mountain cena
  100005, area 98 com monstros Lv.82-83, sem pocao)**: com AutoRevive 4004 = 1 e
  RevivePlace 4022 = 2 o jogo revive sozinho na cidade da mesma cena em ~12 s, de
  graca (nao abre o ReviveDlg). O treino viu "longe do ponto (256 m)", parou a
  caca, andou ate o ponto e religou; na 2a morte parou pelo limite e devolveu as
  opcoes (o char ja tinha revivido). Ponto salvo dentro de cidade (so NPC
  XNpcList_NPCName_601..609 por perto) deixa o auto-play parado: o treino so
  religava a caca por "EXP parado".

## Areas de monstro e nivel (2026-11-06)

- `MiniMapDocument` (get_Doc): `GetMonsterPositionIDByScene:<cena>` = List<uint> de
  areas; `GetMonsterPositionByID:<id>` = RowData {ID, SceneID, Name (chave de
  traducao "MonsterPositionList_Name_N"), Position (float[]), Level (sempre 1,
  nao e o nivel do monstro), Texture}. 203 areas em 16 cenas: 100001..100008 sao
  os mapas principais (100001 Jangan, 23 areas), 103001..103004 e 104001..104004
  as menores.
- `callsi MiniMapDocument SetNaviDestMonsterPositionByID 1 <id> 0` = o proprio
  jogo navega ate a area (get_IsNavigating true, ~11 m/s). Area 1 de Jangan =
  Grassland (2375,1551), cheia de Mangyang. Entre cenas nao testado.
- Nivel de entidade: `XEntityMgr GetAll get_Item:N get_Attributes get_Level`;
  `get_IsEnemy` separa monstro. `ToString` da "modelo nome id". Mangyang = nivel 1:
  pro char 60 da EXP 0.
- Traducao: `XStringDefineProxy`/`XStringTable`/`XStringTableAOT GetString:"chave"`
  respondem "StringTable not set up yet <chave>" pras chaves das areas (o
  `_inited` e 1); nao resolvido. Os mapas do guia oficial sao imagens sem nivel.
- Engine (0.60.0): GETP aceita `Metodo:"texto"` (arg System.String por
  `il2cpp_string_new`) e `Classe MetodoEstatico[:arg]` com classe sem instancia.

## Firm (tarefa diaria de guilda), 2026-11-06

Nome interno **GuildDailyTask** ("Firm" no FIND so acha "Confirm"). Exige guilda
(o char principal tem; os chars alternativos nao). 6 tarefas por dia no NPC Leebaek, 3
pedidos de ajuda, 3 trocas.

- `XGuildDailyTaskDocument` (get_Doc): `SendGetDailyTaskInfo()` pede o estado;
  `_curGuildDailyTaskList` (List<GuildDailyTaskInfo>, vazia antes de aceitar),
  `_count` (1 no char principal hoje), `_curScore` 2, `_taskRoleLevel` 87, `_askedNum`,
  `_helpNum`, `_refresh_num` 3, `_refresh_silk` 5 (trocar pode custar Silk:
  nunca), `_isRewarded`. Acoes: `GoToTakeTask()` (ir ao NPC),
  `SendToGetMyTaskReward(3)`, `SendDailyTaskAskHelp(PeriodTaskType, id)`,
  `SendToRefreshTaskOp(DailyRefreshOperType, ulong)`, `GiveUpTask()`.
- `XGuildDailyTaskView` (singleton): `OnclickSubmmitBtn`, `OnConfirmToSubmit`,
  `OnclickCompleteBtn`, `OnclickReqHelpBtn`, `OnClickRefreshBtn`, `Onclose`.
- Enums: `GuildTaskType` None 0, DailyTask 1, WeeklyTask 2;
  `PeriodTaskType` Daily 1, Weekly 2, Scroll 3; `DailyRefreshOperType`
  Refresh 1, Refuse 2, BuyCount 3 (pago?), AskHelp 4.
- **Fluxo provado ao vivo (char principal, 2026-11-06)**:
  1. Ir ao NPC: `callsi XTaskDocument DoTask 2 2222 1` (missao 2222 = "[Daily] Firm",
     TaskType 4, cena 100001 Jangan). Fora de Jangan abre o mapa com a viagem
     ("From Taklamakan To Jangan, Cost 1500 Gold"); confirmar =
     `callsn MiniMapView OnClickButtonInternationalMapTeleport 1`. Teleporta e anda
     ate o Leebaek (diálogo "Open Firm"). O `GoToTakeTask()` do documento nao
     move nada. Com o auto-hunt ligado o char nao anda: desligar antes.
  2. Aceitar: `callsi XTaskDocument OperateTask 2 2222 1` (TaskOPEnum TAKE 1,
     DONE 2, FINISH 3; TaskStatus CanTake 1 -> Taked 2). Isso cria as 6 tarefas.
     O "Create new task" da tela (`OnClickToRefreshTask`) e o
     `SendToRefreshTasks()` nao criam com a missao ainda nao aceita.
  3. Tela: `calls XGuildDailyTaskView SetVisible 2 1 1`.
  4. Tarefas: `_curGuildDailyTaskList get_Item:N` (GuildDailyTaskInfo:
     `taskID`, `step`, `isRewarded`, `hasAsked`). Todas de "Collect N <item>"
     (Ruby/Jade Tablet Lv.9, Bronze Chimes, Wing Tribe Bill, Wind Element Lv.9),
     ~3,4 a 3,9 M EXP + ~10 a 13 mil gold cada; 3 tarefas dao +2,46 M EXP e
     20000 gold.
  5. Entregar: `callsi XGuildDailyTaskDocument SendToGetMyTaskReward 3 1 <taskID> 0`
     (tipo 1 = DailyTask, id, sem item de conclusao instantanea). Provado: +3.749.251
     EXP (exato), "Completion schedule" 1/6, Silk sem mudar.
- Item pedido por tarefa: `GetDailyTaskTableInfoByID:<taskID>` (RowData:
  `taskquality`, `tasktype`, `conditionId` uint[] -> `conditionId [#0]` = itemID,
  `conditionNum` = quantidade). Estoque: `XBagDocument GetItemCount:<itemID>,0`
  (Bronze Chimes 366, Wind Element 220); o `GetBodyItemCountByID` da 0 (nao e o
  inventario). Nome: `GetItemConf:<id> ItemName [0]` e chave de traducao. Pra
  decidir o que entregar sem o nome: `GetItemConf:<id> ItemQuality` (Tablets e
  Wind Element = 4, Bronze Chimes = 2, Wing Tribe Bill = 1).
- Engine (0.63.0): GETP com `[n]`/`[#n]` no fim (array de referencia ou de int) e
  `Metodo:a,b[,c]` (2 ou 3 args int).
- Nao exercitado: pedir ajuda (`SendDailyTaskAskHelp`), renovar, comprar o item
  que falta, e a recompensa das 3 tarefas.

## Atualizacao do jogo (hot update do launcher), 2026-11-05

Tudo no `Core.dll` (AOT), que existe antes do `XMainClient`. Por isso o engine
libera os comandos genericos (FIND/OBJV/GETP/ENUM/KEYS/SKIL) e o socket assim
que a API do il2cpp fica pronta, sem esperar o XMainClient.

- `XUpdater.XUpdater` (get_singleton):
  - `_phase` (0x158, `eUPdatePhase`): 0 None, 1 Prepare, 2 FetchCheckVersion,
    3 FetchUpdateVersion, 4 LoadUpdateVersion, 5 CompareUpdateVersion,
    6 DownLoadConfirm (dialogo "A new version ... is available"), 7 AppsplitPrepare,
    8 DownLoadBundle, 9 ExtractBundle, 10 ShowVersion, 11 FetchRegion,
    12 LaunchGame, 13 Ending, 14 Finish, 15 Error.
  - `_update_pakcage_size` (0x120, UInt64): bytes do pacote (512194311 = 488,47 MB).
  - `_remainingTime` (0x1b0, float): a estimativa que o jogo mostra em "Estimated".
  - `_target_version` (0xd8): "2.3.14.41.303".
  - `OnUpdateAssetConfirmCallBack()`: Confirm do dialogo. Provado: fase 6 -> 8.
  - `OnRetry()`: "Get check version failed (Click retry)". Provado: recomeca do
    `ReadLocalVersion` (fase 15 -> fluxo de novo).
- `XUpdater.XLoadingUI` (get_singleton): `mTotalProgress get_value` (0..1),
  `mStatusText GetText` ("Downloading 13,7%... (66/488MB)"), `mEstimateLabel`,
  `mAssetUpdateTransform` (dialogo de recursos), `mAppUpdateTransform` (APK novo
  pela loja), `OnAssetUpdateOkClick(IXUIButton)` (o botao de verdade: esconde o
  dialogo e chama o callback; nao testado com botao nulo).
- O GETP devolve campo float como os 32 bits crus em `int`.
- Chamar o callback do XUpdater direto deixa o dialogo desenhado por cima do
  download (cosmetico); ele some quando a cena de login carrega.
- Log do proprio updater: `/storage/emulated/0/Android/data/com.silkroad.mb/files/log/*.log`
  (CheckVersion, URL do serverVersion.txt, LoadCheckVersionFail).
- CDN: `http://cdn.n52srom.com/checkVersion.txt` e `/Android/serverVersion.txt`.
  "Error! (OPGLx2)" nativo + "Get check version failed" apareceram com o NAT do
  LDPlayer quebrado (VBoxNetNAT.exe velho: ping e DNS ok, TCP nenhum). Reiniciar
  a instancia nao bastou; parar a instancia, matar VBoxNetNAT/VBoxNetDHCP e
  subir de novo resolveu.

## Dois caminhos para ler o estado do jogador (passo 1b)

Ambos exigem o jogo LOGADO e no mundo (no titulo nao existe objeto de jogador
nem trafego de gameplay).

1. **Rota entidade**: achar a instancia de `XPlayer` no mundo e ler posicao
   (provavelmente via `transform` da Unity ou um holder de atributos) e vida
   (classe de atributos). Mais navegacao de grafo de objetos.
2. **Rota protocolo (recomendada)**: hookar a desserializacao das mensagens
   `KKSG` de posicao/sync e ler a posicao/vida autoritativa quando chegam. Mais
   estavel entre versoes.

## Como reproduzir o dump

Injetar o engine (ver README), deixar na tela de titulo, e puxar
`/data/data/com.silkroad.mb/files/sro_dump.txt`. O engine espera o XMainClient
carregar antes de despejar.

## Entidades em volta (mapa ao vivo), 2026-11-11

- `XEntityMgr GetAll` (List<XEntity>): `_eEntity_Type` (bits do `EnitityType`),
  `_correctedPosition` (x em +0, z em +8), `get_ID`, `get_IsDead`, `get_Name`,
  `get_Attributes get_Level`; HP por `XAttributes.GetAttr` (2011 MaxHP, 2012 HP).
- Bits: Role 0x2, Player 0x4 (o proprio char), Enemy 0x8, Opposer 0x10, Boss 0x20,
  Puppet 0x40, Elite 0x80, Npc 0x100, Affiliate 0x2000, Mount 0x4000, Spirit 0x10000,
  Scavenger 0x20000.
- **Pets tem o bit de inimigo**: lido em Jangan, pet de combate (Elite Penguin, Gray
  Wolf, o Night Fang do char principal) = 0x10019 (Spirit + Enemy + Opposer) e pet
  de coleta (Cat, Brownie, Myowon) = 0x20019 (Scavenger + Enemy + Opposer). Jogador
  = 0x3, o char = 0x7. Contar "inimigo" pelo `get_IsEnemy` conta os pets (o do
  proprio char a 0 m): descontar Spirit e Scavenger.
- Alvo do auto-play: `XAIComponent._target` (o `_ai` do jogador fica em +0xd8).
- Itens no chao: `XLevelDoodadMgr._doodads` (List<XLevelDoodad>: `pos`, `id` =
  item, `count`, `dropped`, `picked`); 400 registros em Jangan, so os `dropped` e
  nao `picked` sao itens no chao.
- Nome do mapa: `Localization Localize:"SceneList_Comment_<cena>"` (100001 Jangan,
  100003 Taklamakan). Nome de NPC vem como chave (`XNpcList_NPCName_200` = "Jowi").
- Pelo GETP a leitura de ~50 entidades leva ~13 s (~45 ms por consulta, conexao
  nova a cada uma): por isso o comando `ENTS`, que faz tudo numa consulta.

## Cartoes de privilegio (Premium Shop > Privilege), 2026-11-11

- Tabela `XWelfareDocument get_PayMemberTable Table` (array: `GetValue:i`): 1
  Silver Card, 2 Golden Card, 3 Premium Card, 28 dias cada (`Name` e chave:
  `Localization Localize:"PayMember_Name_3"` = "Premium Card - 4 weeks").
- Cartoes da conta: `XWelfareDocument _payMemberInfo` (List<PayMemberRecord>);
  campos `Nullable`, ler pelo getter: `get_id`, `get_expiretime` (s),
  `get_begintime`, `get_lastfetchdailyreward` (dia). Pedir antes:
  `calls XWelfareDocument ReqPayAllInfo 0`.
- Ativo: `expiretime - agora > 1` (`CheckMemberPrivilegeType`). Premio de hoje por
  pegar: `lastfetchdailyreward != floor((agora_ms + (fuso*3600 - 18000)*1000) /
  86400000)` (`CheckPayMemberChest`): vira as 05:00 do servidor. Fuso:
  `XServerTimeMgr get_ServerTimeZone` (8).
- O Premium Card da: +100% de EXP, +5% HP/MP/dano absorvido/ataque/aprimoramento,
  training time x10 +2 h por dia, +4 dados do Continental por dia, +2 respawns e
  +2 refresh da loja por dia, e o premio diario (3 itens; um parece Silk x20).
- Premio diario: so pelo botao do bau da aba, `XWelfareKingdomPrivilegeHandler.OnChestClick
  (IXUISprite)`, que manda `RpcC2G_FetchPayMemberReward` com o ID do botao (= indice
  da aba = id do cartao). Sem metodo de documento pra isso. Abrir a aba:
  `callsi XPremiumShopDlg ShowWorkGameSystem 1 568 0`; com ela aberta o handler fica
  em `XWelfareDocument _payMemberPrivilegeHandler` (`_curTableIdx` = cartao mostrado).
  O botao so se alcanca por metodo da Unity (`m_AfterBuy` Find:"Chest" GetComponent:
  "XUISprite"): usar `callxm` (thread principal). O mesmo caminho por `GETP`
  (thread do socket, e na epoca o texto no meio do caminho ainda virava `0`)
  prendeu o engine ate reiniciar o jogo. Depois do premio o jogo mostra o `RewardDlg`.

## Guild Store (2026-11-11)

- E a loja generica (`XNormalShopDocument`) no sistema `XSys_Mall_Guild` (324),
  `ShopType_Guild` (2). Lista: `callsi XNormalShopDocument ReqGoodsList 1 324 0`
  (seta `m_curSysType` 324 e enche o `m_goodsList`, 34 itens).
- Item (`XNormalShopGoods`): `item itemID`, `item uid` (= ID da ShopTable),
  `priceType` (moeda: 22 = contribuicao da guilda), `priceValue` (float; o GETP
  devolve os bits), `soldNum` (dia), `totalSoldNum`, `weeklyBuyCount`.
- Limites na ShopTable: `XNormalShopDocument GetDataById:<uid>` `DailyCountCondition`,
  `CountCondition`, `WeekCountCondition`, `ItemOverlap` (unidades por compra, 1).
- Comprar: `callsi XNormalShopDocument ReqBuy 1 <indice> 0` (1 unidade; manda o
  `RpcC2G_BuyShopItem`). Nao usar `DoBuyItem`: tem as versoes (XNormalShopGoods,
  uint) e (ulong, uint), as duas com 2 args.
- Semanais que o bot compra: Pet Eggs - Precious (605) 500 x8, Pet Eggs - Rare (606)
  1000 x3, Dimension Hole - Forgotten World (85) 400 x2 = 7.800 de contribuicao. Ha
  um segundo Dimension Hole pago com a moeda 89 (fica de fora).
- Provado ao vivo: 13 compras, cada uma com a semana +1 e a contribuicao caindo o
  preco exato (247.070 -> 239.270), Silk e Diamond iguais.

## Guild utilities (2026-11-07, char principal no servidor principal)

- Na guilda: `XGuildDocument get_bInGuild` (vem false nos primeiros segundos depois
  do login; esperar).
- Itens virtuais (`XBagDocument GetItemCount:<id>,0`): 1 = gold, 7 = Silk, 22 =
  contribuicao da guilda. Os nomes sao chaves (`ItemList_ItemName_N`).
- Sign-in: `XGuildSignInDocument` (sem singleton; achado pelo XDocuments).
  `ReqAllInfo` pede o estado; `get_SignInSelection` 0 = nao assinou hoje (senao o
  tipo); `get_CurrentCount`/`get_TotalCount` assinaturas da guilda (48/120);
  `get_Progress` (87). `ReqSignIn(tipo)`. Tabela `GetSignInTableData [n]`: `type`,
  `consume`/`reward` sao `SeqRef<uint>` (array compartilhado em +0x18, inicio em
  `campo+8`, ler `campo [#inicio]` e `[#inicio+1]`): tipo 1 = 25.000 gold -> 200 de
  contribuicao; tipo 2 = 50.000 gold -> 500; tipo 3 = **20 Silk** -> 1000 (nunca).
- Baus do sign-in: `GetBoxTableData [n] process` = 20, 40, 80, 120 contra o
  `get_Progress`; `IsBoxOpen:n`; `ReqFetchBox(n)`; `get_bHasAvailableChest`.
- Salario: `XGuildSalaryDocument SendAskGuildWageInfo`; `get_RewardState`
  (`KKSG.WageRewardState`: cannot 1, rewarded 2, notreward 3);
  `SendGuildWageReward`. Deu +161.500 gold e +2.500 de contribuicao (grau 4).
- Red packet: `XGuildRedPacketDocument ReqList`, `get_PacketList`,
  `get_bHasAvailableRedPacket`, `ReqFetch(id)`. Pegar nao foi visto (lista vazia).
  `SendGuildBonusInSend`/`GetSendGuildBonus` sao de ENVIAR: nao usar.
- Doacao (aba "Support" da guilda): `XGuildDonateDocument` (get_Doc),
  `SendGetDonateBaseInfo`, `get_DailyDonateOverviewList`, `GuildDonateType`
  (DailyDonate 0, WeeklyDonate 1, GrowthDonate 2). Doa item do inventario pra pedido
  de membro: nao implementado.
- `XLoginDocument` tem `_account`, `_pwd` e `_token_cache` (aparecem no OBJV): nunca
  ler nem guardar.

## Treino: canal e navegacao entre mapas (2026-11-07)

- Canal: `ChannelDocument` (get_Doc). `RequestSceneLineInfo` pede a lista;
  `_listLine` (List<KKSG.SceneLineInfo>: `_line+4`, `_state+4`, `_mapid+4`, campos
  Nullable com o valor em +4); `get_CurrentLineID`; `LineIDToLine:<id>` = numero do
  canal. O id muda por mapa: Jangan 101..104, Roc Mountain 501..504.
  `ReqChangeLine(id)`: troca de graca em ~2 s, mas SO FORA DE COMBATE (em combate o
  pedido e ignorado, mesmo com a caca desligada).
- Ir ate um ponto em outro mapa: `TeleportDocument` (get_Doc)
  `TeleportNavigate(Vector3 pos, uint cena, uint)`; o jogo escolhe o teleporte e
  anda. Engine 0.82.0: `SKIL callv3 TeleportDocument TeleportNavigate 3 x y z
  <cena> 0`. Jangan -> Roc Mountain (1325, 365, 620): chegou em ~30 s a ~12 m do
  ponto, custou 2.000 gold.
- Morte do principal: o char principal (Lv.87) morreu em Roc Mountain com a caca desligada
  em combate e perdeu 59,7 M de EXP (60,3 M -> 615 mil). Nunca desligar a caca do
  principal perto de monstro.
- Fechar o jogo com o char cacando tambem mata: o char fica no mundo sem auto-play
  depois que o cliente cai. Em 2026-11-07 20:36 a troca de char do Continental
  fechou o jogo com o char principal em combate (monstros 71-73); ele voltou morto as 20:40.
- Preso no ponto com o servidor vivo: em 2026-11-07 06:13 o char principal parou no 74-76
  sem ganhar EXP, no mesmo lugar e apanhando (HP 83-94%, o time mudou de 6 pra 5).
  `{on:1}` com a caca ja ligada nao muda nada. O vigia (EXP parado 8 min) reiniciou
  o jogo e o char morreu sozinho (27,8 M de EXP). Desde a 0.93.0: desliga/religa a
  caca aos 6 min, troca de ponto aos 10 e so reinicia com EXP, HP e posicao parados.
- Pocoes do Recover: `XAutoPlaySettingDlg m_XItemListUpdate get_Item:i itemConf
  ItemDescription` veio como a chave (`ItemList_ItemDescription_351002203`), sem
  texto. `ReqLevel`/`ItemType` vem empacotados (nao separam HP de MP). Espacos:
  4034/4035 HP, 4036/4037 MP; `XOptionsDocument GetValue:<id>` le e `callsi
  XOptionsDocument SetValue 3 <id> <item> 1` grava (com o jogo conectado).
  MP do char principal: 351002203 (2.530); HP: 351002102.
- EXP: o `CONN` manda `exp`/`maxExp` como int32; o maximo do Lv.87 (2.258.820.361)
  chega negativo. O app le como sem sinal.

## Skills e maestrias (2026-11-07, char principal Lv.87)

- Maestrias: `XSkillTreeDocument` `_skillGroupsID get_Item:<g>` (7 grupos chineses:
  Sword, Spear/Glaive, Bow, Cold, Lightning, Fire, Water/Force): `Level`,
  `MaxBranchCount`, `IconGroup` (mastery_<x>_skill), `rowData ID/Name`.
  `_003CTotalMasterySkillPoint_003Ek__BackingField` 300 (= 3 x 100) e
  `_masterySkillPointUsed` 261 (= 3 x 87: cada maestria vai ate o nivel do char).
- Skills aprendidas: `XEntityMgr GetAll get_Item:0 get_Attributes SkillLevelInfo
  get_LearnedSkills` = Dictionary<uint id, uint nivel> (95 no char principal). Leitura
  crua: `_entries [#i:4:2]` id, `[#i:4:3]` nivel (engine 0.84.0; hash < 0 = vazio).
- Config: `XSkillEffectMgr GetSkillConfig:<id>,<nivel>` (engine 0.84.0 aceita
  `Metodo:a,b` no meio do caminho) -> RowData: `SkillScript`
  (chinaman_Fire_HoaTienBaoDiemBa), `ScriptName`/`CurrentLevelDescription` (chaves de
  traducao; a StringTable nao responde de fora), `SkillType` (SkillTypeEnum: 0 None,
  1 Normal, 4 SceneBuff, 6 Buff, 7 Versatility, 8 Artifact), `Element`, `CostMP`,
  `LevelupCost` (SP), `BranchId` (linha da arvore: 2001..2008 Glaive, 5001..5007
  Lightning, 6001..6008 Fire), `SkillGroupLevel` (maestria exigida). Pedir nivel alto
  devolve a ultima linha: `GetSkillConfig:<id>,200 SkillLevel` = nivel maximo.
- char principal: as 24 skills fora do maximo exigem maestria 88+ no proximo nivel; nada sobe
  no nivel 87. Maximizar tudo (ate maestria 110) custa 1.608.575 SP. Item virtual 5 =
  3.980.652 (provavel SP, nao confirmado). Subir: `XSkillTreeDocument
  SendSkillLevelup(id)`; maestria: `SendGroupSkillLevelup(grupo)` (nao testados).
- Nome e efeito traduzidos: com a tela aberta (`calls XSkillTreeView SetVisible 2 1
  1`), `callsi XSkillTreeDocument set_CurrentSkillID 1 <id> 0` + `callsi
  XSkillTreeView SetupDetail 1 0 0`, depois `XSkillTreeView m_uiBehaviour
  m_SkillName_L GetText` ("Flame Wave - Bomb (9/16)"), `m_SkillType_L` (Active,
  Support, Passive), `m_txtSkillDes`, `m_txtSkillCD` e `m_txtSkillRequest get_Item:n`.
  Fechar: `SetVisible 2 0 1`.
- Atributos: ATTR grava `sro_attrvals.txt`; o valor e o double nos bits do campo `l`.
  char principal: STR 139, INT 410, HP 16.181, ataque fisico 2.273..2.523 e magico
  4.468..5.173 (build INT).
- Barra de skills: `get_Attributes _skillFullSlots [#0..17]` (18 posicoes): 0 =
  ataque basico, 1 = fixa (nao aceita skill), pagina 1 = 2..9, pagina 2 = 10..17.
  Trocar: `callsi XSkillTreeDocument SendBindSkill 3 <skill> <posicao> 0`; vai pro
  servidor (relogado, a barra voltou igual). Provado no char principal em 2026-11-07 (barra
  INT: pagina 1 com 8 ataques de fogo/raio, pagina 2 com 8 buffs).

## Traducao e areas de monstro (2026-11-07)

- `GETP Localization Localize:"<chave>"` traduz qualquer chave do jogo de fora (NGUI
  `Localization`, Core.dll). Ex.: `MonsterPositionList_Name_64` = "Niya Sniper (74)",
  `ItemList_ItemDescription_351002203`. O `XStringDefineProxy GetString` responde
  "StringTable not set up yet". Idioma: `Localization get_language` = EN.
- Areas de monstro: `MiniMapDocument GetMonsterPositionByID:<id>` (RowData: `ID`,
  `SceneID`, `Name` = chave, `Position` float[3], `Level` sempre 1). 192 areas (ids
  1..~200) em 16 cenas; o nivel vem no nome traduzido ("(74)").
  North Taklamakan (100003): 61-80; Roc Mountain (100005): 70-88; 104001..104004:
  81-99. Ex.: #62/#63 Niya Soldier 71 / Guard 73 em (2191, 1302); #64/#65 Niya
  Sniper 74 / Hunter 76 em (1314, 1200); #98 Antelope 83 em (1325, 620).

## Time (party) (2026-11-07)

- `XTeamDocument` (get_Doc): `get_bInTeam`, `get_bIsLeader`, `get_MyTeam`,
  `get_bAutoMatching`, `get_AutoRejectInvite`, `get_TeamJoinList`, `ReqTeamList(uint)`.
- Tudo passa por `ReqTeamOp(KKSG.TeamOperate, ulong, object, TeamMemberType, string,
  int, uint)` (7 args). `ENUM TeamOperate`: 1 CREATE, 2 JOIN, 3 LEAVE, 6 KICK,
  12 INVITE, 15 GET_FULL_DATA, 26 CHANGE_SETTING, 27 MEMBER_ASK_LEADER,
  28 MEMBERS_FOLLOW_LEADER, 29 LEADER_CALL_MEMBERS, 35 FAST_JOIN, 36 SET_AUTO_JOIN,
  38 JOIN_REQ_FETCH_LIST, 39 ACCEPT_ONE, 40 ACCEPT_ALL, 41/42 IGNORE. `TeamMemberType`:
  1 NORMAL, 2 HELPER, 3 USETICKET.
- Convite recebido: `TeamNotifyModalDlg` (`_OnInviteAgreeBtnClick`).
- Bonus de party (tela do jogo): 2 membros 5%, 3 10%, 4 15%, 5 20%, 6 25% de EXP e SP.
- Lista de times: `callsi XTeamDocument ReqTeamList 1 <expID>` (expID 1 = "Hunt") e
  `XTeamDocument _TeamList` (XTeamBriefData: `teamID` int, `currentMemberCount`,
  `totalMemberCount` 4 ou 6, `leaderLevel`, `leaderLine` = canal do lider (o mapa e o
  prefixo: 1xx Jangan, 3xx North Taklamakan, 5xx Roc Mountain), `IsAutoJoin`, `hasPwd`,
  `teamSettingInfo get_min_level/get_max_level/get_is_share_point/get_is_share_item`).
  Em 2026-11-07 ~21:52: 79 times, todos "Hunt"; 36 em Roc Mountain, 4 no North Taklamakan.
- ENTRAR: `callsi XTeamView TryJoinTeam 2 <teamID> 1` (PROVADO ao vivo: char principal entrou no
  #6003, auto-join, 4/6 -> 6/6, em ~4 s; `get_bInTeam` true). Sem extensao no engine.
- Meu time: `XTeamDocument _MyTeam` (`members` List<XTeamMember>: `briefData name/level/
  uid`, `sceneID` do membro, `currHp`). O `ReqTeamOp` (7 args) segue sem uso.
- Party completa (2026-11-13, codigo do cliente; caminhos do GETP conferidos ao vivo, so leitura):
  criar = `ReqTeamOp` op 1 com `o` nulo (usa o ajuste padrao, expID 1 "Hunt"; o jogo abre a
  `XTeamView` no sucesso); convidar = op 12 com `q:<roleid>`; entrada automatica = op 36 `q:1`
  (liga/desliga; ler `_MyTeam teamBrief IsAutoJoin`); pedidos = op 38 (busca, enche
  `XTeamDocument _joinList`) e op 40 (aceita todos). Quem da pra convidar:
  `callx XTeamInviteDocument ReqInviteList 1 -- i:<3 amigo|2 guilda|1 mapa>` e
  `XTeamInviteDocument m_InviteList` (so livres; `name`, `uid` 64 bits).
- Convite recebido: `TeamNotifyModalDlg m_CurrentInviteData` (`inviteID`, `invitorName`,
  `invitorRelation m_Relation` 1 amigo, 2 guilda, 4 outro; nulo sem convite). Aceitar:
  `callp TeamNotifyModalDlg _OnInviteAgreeBtnClick 1` (o botao; fecha a janela). Sem resposta a
  janela recusa sozinha no fim do tempo.
- Seguir o lider (Auto Trace): op 28 `TEAM_MEMBERS_FOLLOW_LEADER` e liga/desliga; estado em
  `XTeamFightMgr get_IsFollowing`. Seguindo, `XTeamFightMgr.StartFollow` troca a arvore da IA
  pela `AutoFight_Team` e liga a IA: anda atras do lider (ate de mapa, pelo TeleportNavigate)
  e caca em volta dele (18 m). `StopFollow` DESLIGA a IA: quem parar de seguir perto de
  monstro precisa religar a caca. O `ResetBehaviorTree` (e o `SetAutoEnable` do liga caca)
  respeita o Follow.

## Auto-play: ponto de nascimento da IA (2026-11-07)

- `XEntityMgr get_Player _ai` e o `XAIComponent`: `_born_pos` (Vector3 em 0x9c), `_is_wander`,
  `_wander_range` (20 m), `_target`, `_targets`. Sem alvo, o auto-play vaga em volta do `_born_pos`,
  que fica onde o char apareceu ao logar ou reviver. Metodos: `ResetBornPosition()` (fixa no lugar
  atual), `SetBornPostion(Vector3)`, `get_BornPosition`, `IsOutOfWanderRange`, `ResetAIData`.
- Visto: depois de relogar no pilar de reviver do oasis do North Taklamakan (1475, 1050; zona Peace),
  o char saia de qualquer ponto do mapa pro oasis e parava. `callp XEntityMgr get_Player _ai
  ResetBornPosition 0` no ponto resolveu (app 0.99.0).
- Mochila: `XBagDocument ItemBag Items` (List<XItem>: `itemID`, `itemCount`, `bBinding`, `uid`, `itemConf`
  com `ItemType`/`ItemQuality` (byte), `ReqLevel` (int16), `CanSell`, `SellGoldPrice`); o GETP le byte e
  int16 como int32 (mascarar). Nome: `Localization Localize:"ItemList_ItemName_<id>"`.
  `GetEmptySlotCount` (ja veio -97 logo depois de reconectar).
- Time: sair = `callp XTeamView _MyTeamHandler _DoLeaveFromTeam 1`; criar = `callp XTeamView
  _TeamListHandler _OnCreateClick 1` (sai sem entrada automatica). Depois da atualizacao das 07:52 o
  `TryJoinTeam` e o match automatico (`ForceMatching`/`ToggleMatching`) nao entram em time nenhum.
- Login da conta: tela NATIVA do SDK da Gamo (Android). Menu "Login with Google/Login with ID/Play as
  Guest"; formulario EditText ID, EditText senha (password=true), Button Login. O uiautomator devolve o
  texto do campo de senha em claro: nunca imprimir texto de EditText.

## Travamento na troca de cena (2026-11-07)

- Sintoma: no voo do teleporte entre mapas o cliente para no ceu, o char sai de mundo e a cena
  (`XScene get_SceneID`) nao muda. Causa (logcat): `XGame.SwitchTo` -> `XWorldStage.OnLeaveScene` ->
  `UIManager.OnLeaveScene` -> `DlgBase.UnLoad` com NullReferenceException. A janela quebrada era o
  `Team/TeamInputPasswordDlg` ("UI missing" a cada frame), aberto pelo `TryJoinTeam 2 <id> 1` (o bool
  pede senha) e ausente no cliente 2.3.14 depois da atualizacao. Entrar por
  `callx XTeamDocument ReqTeamOp 7 -- i:2 q:<id> n i:1 s: i:0 u:0` nao abre a janela.
- Qualquer dialogo quebrado ("UI missing" no logcat) derruba a proxima troca de cena: so reiniciar o jogo limpa.
