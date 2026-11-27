# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/). Uma linha por versao com o que ela trouxe.

## [Nao lancado]

- **App:** escolha da **Versao do jogo** nas configuracoes: **Global** (`com.silkroad.mb`, como sempre foi) ou **Europa** (`com.hive.silkroad`, o APK da Hive que lanca em 2026-11-30). Sao APKs separados e os dois podem estar no mesmo emulador (visto em 2026-11-27 no MuMu: Global 2.3.12 com Unity 6000.0.60f1, Europa 0.0.12 com Unity 6000.0.77f1, o mesmo conjunto de libs e o mesmo `libmain.so` de 6696 bytes). Antes o pacote estava fixo em tres arquivos do main; agora injetar, restaurar, abrir, fechar, trazer pra frente, o teste de conexao, o auto-login, a leitura dos arquivos do engine e os IPs da VPN usam o pacote escolhido. O backup do `libmain.so` fica separado por jogo: o Global segue em `game-backup\<serial>` (acha os backups ja guardados) e a Europa vai pra `game-backup\<serial>_com.hive.silkroad`, senao injetar um sobrescreveria a base do outro. `settings.json` antigo, sem o campo, continua no Global. O script de injecao aceita `SRO_GAME=eu` so naquela execucao. Arquivos: `app/src/controller/settings.ts` (11-60 `GameVersion`, `GAME_PACKAGES`, `gamePackage`, `parseGameVersion`, `backupDirName`; 94 normalizacao), `app/src/main/adbbin.ts` (23-27 `gamePkg`), `app/src/main/inject.ts` (18, 28, 47 pasta do backup; 181-461 os comandos com o pacote), `app/src/main/autologin.ts` (36, 171), `app/src/main/vpn.ts` (25, 203), `app/src/main/libscli.ts` (5, 11, 26-28 `SRO_GAME`), `app/src/renderer/index.html` (743-751, seletor), `app/src/renderer/renderer.ts` (261, 272, 281-282, 293) e `app/src/controller/__tests__/settings.test.ts` (98-118, 2 testes). Como testar: `cd app && npm run typecheck && npm test && npm run build` (368 testes, 0 falhas em 2026-11-27); no app, Configuracao > Versao do jogo > Europa > Salvar > Testar conexao mostra "com.hive.silkroad instalado". Status: testado por unidade e, em 2026-11-27 17:03 a 17:20, no cliente da Europa no MuMu (`emulator-5554`, root pelo `su`) pelo script com `SRO_GAME=eu`: a base foi guardada em `game-backup\emulator-5554_com.hive.silkroad` (libmain `1ba9bf57`, jogo limpo), o engine subiu e o restore devolveu o md5 original ("OK: restaurado (jogo limpo)"). A tela de login da Hive tem os mesmos controles que o `sdklogin` ja acha (menu e formulario do "Login with ID"). Sem prova: login de verdade (sem conta da Europa, servidor fecha ate 2026-11-30), telas de servidor e char, atividades em mundo, IPs da VPN e a tela de configuracao aberta no Electron. Detalhes no `engine/DISCOVERY.md`, secao "Versao Europa".

- **Engine:** os arquivos de saida (`sro_dump.txt`, `sro_objv.txt`, `sro_find.txt` e os outros 7) vao pra pasta de dados do proprio processo, `/data/data/<pacote>/files/`, com o pacote lido do `/proc/self/cmdline`, em vez de `com.silkroad.mb` fixo. Assim o mesmo engine serve o Global e a Europa; sem leitura cai no `com.silkroad.mb`. O logcat mostra "pasta de dados do jogo: ..." na primeira gravacao. Arquivo: `engine/src/engine.cpp` (61-87 `game_files_dir` e `open_game_file`; 361, 463, 745, 776, 1036, 1135, 1212, 2497, 2525, 2588). Como testar: `bash engine/build.sh` (sai 0; nesta maquina com `NDK_HOME` do Unity 6000.6.10f1, o 6000.6.8f1 do padrao ficou sem NDK); injetado, `OBJV` grava e o app le o `sro_objv.txt` pela pasta do pacote escolhido. Status: testado ao vivo na Europa em 2026-11-27: o logcat mostrou "pasta de dados do jogo: /data/data/com.hive.silkroad/files" e `FIND`/`OBJV` gravaram e foram lidos de la (65 classes que o app usa conferidas, todas presentes). No Global so compilado (o caminho sai igual ao antigo).

- **Docs:** secao "Versao Europa: com.hive.silkroad" no `engine/DISCOVERY.md`: pacote, Unity 6000.0.77f1, md5 do `libmain.so` original, boot do engine, as classes conferidas, o `+0xf8` do jogador e a tela de login do SDK.

- **App:** aba **Mapa** ganha uma faixa com **relogio do servidor**, **troca de canal na mao** e **Sair da cena**, que era a linha "Sair de cena, timer de mundo e canal" (SRO M BOT tem; nos so tinhamos a troca automatica de canal do Treino) da comparacao de features. Relogio: hora do servidor (`XServerTimeMgr get_ServerTimeZone`, UTC+8) e quanto falta pra virada do dia do jogo (05:00 do servidor, 18:00 em Brasilia). Canal: os canais do mapa com lotacao (bom, lotado, cheio) e o Activity Channel, o atual em dourado; clicar troca pelo `ReqChangeLine` e espera ate 30 s o jogo confirmar a linha nova. Sair da cena: aparece so em instancia (cena abaixo de 100000) ou na torre (`_scene_type` 16), pede confirmacao e usa o `XScene ReqLeaveScene` (o mesmo do Qigong no Guild Hall), esperando ate 30 s a cena mudar. Os dois so no clique, um por vez, e o main confere de novo antes de mandar: recusa com o jogo fora do mundo, char morto, em combate (`XLevelStatistics get_IsInFightingState`; o jogo ignoraria a troca), canal cheio ou o atual, e com Treino, Guild Boss, Sekhmet, Missao principal, diarias, Continental, Qigong ou o vigia rodando (eles escolhem canal e cena sozinhos). A leitura roda a cada 10 s so com a aba Mapa aberta e o jogo conectado; em instancia a lista de canais nao e pedida. Arquivos: `app/src/controller/world.ts` (1-141, regras e leitura), `app/src/controller/__tests__/world.test.ts` (1-119, 6 testes), `app/src/main/main.ts` (51-60 import; 256-314, IPC `engine:world`, `engine:worldchannel`, `engine:worldleave`), `app/src/main/preload.ts` (22-24), `app/src/renderer/renderer.ts` (24, 76-78, 3866-3977), `app/src/renderer/index.html` (82-92), `app/package.json` (listas de teste), `app/GUIA-TESTE.md`, `README.md` e `engine/DISCOVERY.md`. Como testar: `cd app && npm run typecheck && npm test` (366 testes, 0 falhas em 2026-11-26); ao vivo, com o char no mundo aberto e a caca desligada, abrir a aba Mapa: a faixa mostra a hora do servidor (UTC+8) e os canais; clicar num canal livre troca e o log diz "canal trocado pro N (na mao)"; com a caca ligada o clique recusa "em combate". No Guild Hall (depois de um Qigong) aparece "Sair da cena"; confirmar leva o char pro mundo aberto. Status: nao testado ao vivo. Typecheck, build e testes passam. Nada foi mandado ao jogo: o char principal estava cacando (cena 100003) e a troca de canal e a saida nao foram tentadas, entao a faixa, a troca na mao e a saida ficam sem prova ao vivo (as chamadas sao as mesmas ja usadas no Treino e no Qigong). Correcao: a versao anterior deste texto dizia que o jogo estava fora do mundo (`CONN` vazio); foi leitura errada, o cliente de teste parava no quadro `OKAY {}` que o engine manda ao conectar.

## [0.156.0] - 2026-11-25

- **App:** a fila de atividades de 1 min nao fica mais presa depois de um evento de hora marcada. Em 2026-11-24, depois da Sekhmet War das 09:56, pararam juntos o Gratis do dia (attendance, caixinha do Daily Pack, Premium Card), os baus de atividade, as diarias da virada das 18:00 (Tower, Guild, Firm), o Continental e o Album de Cards, ate o app ser reaberto no dia seguinte; so Treino, Guild Boss e Sekhmet seguiram. Causa: o `checkTimedEvents` saia sem atualizar o "evento aberto" quando o Guild Boss ou a Sekhmet estavam no meio da propria checagem de 5 s (quase todo tick) e so atualizava com uma atividade da fila rodando, que o proprio evento aberto impedia. Agora ele le os dois eventos mesmo nesses ticks (so leitura, com trava propria contra checagens sobrepostas), libera a fila quando nada esta aberto e, mesmo com a leitura dizendo aberto, nunca segura a fila mais que 40 min (o evento dura 30); ao passar disso o log avisa "segue aberto na leitura ha 40 min: liberando a fila de atividades". Arquivos: `app/src/controller/eventgate.ts` (1-34, logica), `app/src/renderer/renderer.ts` (12 import, 1181-1217 `checkTimedEvents`, 1222 `runScheduled`, 2370 `maybeRunDailies`), `app/src/controller/__tests__/eventgate.test.ts` (1-42, 5 testes) e `app/package.json` (listas de teste). Como testar: `cd app && npm run typecheck && npm test` (360 testes, 0 falhas em 2026-11-25); ao vivo, com Gratis do dia e Album de Cards marcados, deixar a Sekhmet War (ou o Guild Boss) abrir e fechar e conferir que em ate 1 min depois do fim o log volta a mostrar "gratis do dia: ..." e o Album de Cards. Status: testado por unidade; a passada ao vivo por um evento fica pra proxima Sekhmet ou Guild Boss.

- **App:** opcao nova no Treino, **Buff de skill na party**, que era a linha "Buffs na party" (nos nao temos) da comparacao de features. Lido ao vivo em 2026-11-24: o auto-play do proprio jogo ja buffa aliado (a arvore `AutoFight_Player` escolhe skill e aliado em `AIRuntimeDoSelectSkillAndAlly` e lanca com `AIRuntimeDoCastSkill`, andando ate ele se estiver longe), e quem vem primeiro e a opcao do jogo `PriorBuffTarget` (4040: 0 lider, 1 membros, 2 o proprio char). Entao o bot nao lanca skill na mao: no painel Time escolhe-se "o lider", "os membros" ou "o proprio char", e o Treino grava a opcao ao comecar e devolve o valor antigo ao parar, como as outras opcoes do auto-play. "Como esta no jogo" (padrao) nao mexe em nada. As skills de buff precisam estar na barra. Arquivos: `app/src/controller/team.ts` (24-29, `buffTarget`), `app/src/controller/train.ts` (44 `OPT.PriorBuffTarget`; 223-243 `BUFF_TARGET_VALUE` e `trainOptions`; 246-250 `optionFixes` recebe a lista), `app/src/main/train.ts` (367-371), `app/src/renderer/index.html` (252-260, seletor), `app/src/renderer/renderer.ts` (9, 1495, 1522-1525, 1555, 1661, 3214), `app/src/controller/__tests__/train.test.ts` (290-311, 1 teste), `app/GUIA-TESTE.md` e `README.md`. Como testar: `cd app && npm run typecheck && npm test` (341 testes, 0 falhas em 2026-11-24); ao vivo, num char em party com skill de buff na barra, escolher "os membros" e ligar o Treino: o log mostra "ligado: buff de skill primeiro nos membros da party." so se a opcao estava diferente, `GETP XOptionsDocument GetValue:4040` le 1 e o buff aparece no membro; ao parar, a opcao volta. Status: parcialmente testado. Leitura ao vivo (arvore, enum, opcao 4040 = 1 e `_priorityBuffType` = 1 no char principal, sem party); gravar a opcao e o buff caindo num membro ficam sem prova ao vivo.

- **Docs:** "Buff de skill na party" na secao "Time (party)" do `engine/DISCOVERY.md` (889-905): os nos da arvore da IA que buffam aliado, a opcao 4040 e o enum `PriorityBuffType`, e o que ficou sem prova.

- **App:** filtro de monstros no Treino, que era a linha "Filtro de monstros: ignorar alguns, categorias por skill" da comparacao de features. O auto-play do jogo continua escolhendo o alvo; quando ele pega um monstro ignorado, o bot manda a IA atacar o monstro permitido vivo mais perto (ate 50 m) pela tag nova `TARG` do engine (`XAIComponent.SetTarget`), sem desligar a caca. Ignora por especie (lista montada no botao "Ver monstros por perto", pelo `_type_id`, com o HP maximo pra separar especies de mesmo nome) e por categoria: normais, champion (Champion, Giant e Elite, a mesma classificacao do mapa) e boss. Roda num laco proprio a cada 300 ms (ENTS ~40 ms), so com o char cacando (vivo, sem viagem, sem parada nem pausa); no loop do Treino (1 a 3 s) quase todo ignorado morria antes da troca, porque ali o char mata em 1,5 a 3 s. Depois de cada troca espera 1,5 s o jogo aplicar antes de olhar o mesmo monstro de novo. Sem permitido ate 50 m, deixa matar o ignorado. Se o ignorado volta a ser alvo com o substituto ainda vivo (a lista de odio puxou de volta) 2 vezes em 30 s, desiste dele por 60 s (contado por ignorado, entao dois batendo ao mesmo tempo tambem caem); voltar depois que o substituto morreu nao conta (e so a IA escolhendo o mais perto de novo). Com o engine antigo o log avisa uma vez pra reinjetar e o Treino segue sem o filtro. Arquivos: `app/src/controller/monsterfilter.ts` (1-194, logica), `app/src/main/train.ts` (104-117 import, 367-430 laco do filtro, 521-530 porta, 750 porta aberta so com o passo "wait", reaberta depois da busca de monstro e do destravar), `app/src/controller/train.ts` (`TrainConfig.monsterFilter`), `app/src/controller/map.ts` (`MapEntity.typeId`, `parseEnts`), `app/src/renderer/index.html` (234-249, tela), `app/src/renderer/renderer.ts` (1508-1605 config e listas, 1648, 1754-1756, 3302), `app/src/controller/__tests__/monsterfilter.test.ts` (1-223, 14 testes) e `app/package.json` (listas de teste). Como testar: `cd app && npm run typecheck && npm test` (355 testes, 0 falhas em 2026-11-24, em cima da main com o #85); ao vivo, com o engine novo, no Treino clicar "Ver monstros por perto", ignorar uma especie, iniciar e conferir no log "filtro: largando <ignorado> (ignorado) e indo pro <permitido> a N m" e o char batendo no permitido. Status: testado ao vivo em 2026-11-24 13:28 a 13:31 (char Lv.87, North Taklamakan, ignorando Niya Mage 310011, 150 s com um observador lendo o alvo a cada 0,5 s): os 4 Niya Mage que viraram alvo foram trocados em menos de 0,5 s e nenhum morreu como alvo com o filtro ligado; sem falso "voltou a ser alvo". A tela (lista e botoes) nao foi aberta no Electron; a lista foi conferida com o ENTS ao vivo pelo mesmo codigo (`parseEnts` + `nearbySpecies`).

- **Engine:** o ENTS manda a especie de cada entidade (`XAttributes._type_id`) como 10o elemento, e a tag nova `TARG <id>` troca o alvo do auto-play: acha o monstro pelo id na hora (o indice do `GetAll` muda), so aceita monstro vivo (recusa jogador, pet e morto) e chama `SetTarget` na thread principal. Tag propria e nao subcomando do SKIL: no engine antigo um SKIL desconhecido liga/desliga a caca pelos digitos do corpo; a tag desconhecida so devolve o estado do jogador. Arquivos: `engine/src/engine.cpp` (2264-2305 especie no ENTS, 2391-2463 `set_ai_target`, 2634-2637 tag) e `docs/PROTOCOLO.md`. Como testar: `bash engine/build.sh` (sai 0); injetado, `ENTS` mostra `[..., "Niya Mage", 310011]` e `TARG <id>` responde `{"ok":true,"targ":id}` com o `_target` mudando. Status: testado ao vivo em 2026-11-24 13:19 no LDPlayer 5559: especie no ENTS (Niya Mage 310011, Niya Shaman 310012, pet Cat 10001), TARG recusando pet ("nao e monstro"), id inexistente e id 0, e trocando o alvo nas rodadas do Treino acima. Ficou injetado a pedido do usuario.

- **Docs:** secao "Filtro de monstros" no `engine/DISCOVERY.md`: quem escolhe o alvo, os campos do `XAIComponent`, a troca por `SetTarget` provada ao vivo, o id UInt64 com bit alto, a especie pelo `_type_id` e a especie diferente com o mesmo nome (Niya Mage de 111700 de HP).

- **App:** atividade nova, **Missao principal** (main quest), que era a linha "Missao principal: SRO M BOT tem, nos nao temos" da comparacao de features. Com "Ativa" marcada, o bot acha a main quest na lista (a entrada com `m_TableData TaskType` = 1), para a caca com o char seguro, vai ate o NPC com o `DoTask` do jogo (confirma a viagem paga se precisar trocar de mapa), aceita (`OperateTask` TAKE), segue o objetivo e entrega (`OperateTask` FINISH), uma missao atras da outra. Objetivo de matar monstro ou juntar drop: vai ate o objetivo e liga a caca do jogo; sem nenhum step subir em 3 min volta ao objetivo (2 vezes) e depois desiste. Falar com NPC: DONE duas vezes e depois a entrega. Usar item, escolta e fase: o bot nao faz e avisa no log qual objetivo ficou. Cada operacao tem 3 tentativas e cada parte da missao desiste com 15 min sem nenhum step subir (caca longa que segue progredindo nao cai por tempo). Sem main quest aberta conclui: "linha principal concluida" (`GetTaskStatue:1` = 4) ou esperando nivel. Roda a cada Iniciar bot, depois do Firm e antes do Treino, no maximo 1 h por vez; marcar "Ativa" com o bot rodando pausa o loop do Treino e religa no fim, segurando as outras atividades como as diarias. Com outra atividade ja rodando, ou com o Treino que nao para a tempo, a missao nao entra junto e o log avisa (roda na fila do Iniciar bot ou ao marcar "Ativa" de novo); no segundo caso o Treino volta sozinho quando o loop sair. Leitura da lista que falha no meio nao conta missao entregue nem conclui a passada: espera a proxima leitura e, falhando seguido por 1 min, desiste avisando. Entrada da lista que nao se le (ex.: missao fora da tabela) so e pulada, sem esconder a main. Main ja fechada (status 4) que ainda aparece na lista e pulada. Parar bot, Guild Boss e Sekhmet param a missao, e o Qigong nao entra enquanto ela roda. Arquivos: `app/src/controller/mainquest.ts` (1-339, logica e leitura), `app/src/main/mainquest.ts` (1-82, runner), `app/src/main/main.ts` (494-501, IPC `engine:mainquest`), `app/src/main/preload.ts` (61-63), `app/src/renderer/renderer.ts` (715-789 config e atividade; 387, 1433, 2304, 2324, 2360, 2402-2428, 3259 integracao), `app/src/renderer/index.html` (325-345, painel), `app/src/controller/__tests__/mainquest.test.ts` (1-372, 20 testes) e `app/package.json` (listas de teste). Como testar: `cd app && npm run typecheck && npm test` (340 testes, 0 falhas em 2026-11-24); ao vivo, num char com a linha principal aberta, marcar "Ativa" em Missao principal e conferir no log "[missao] aceitar a missao principal N", "ligar a caca no objetivo (matar monstro M 0/5)" e "entregar a missao principal N". Status: parcialmente testado. A leitura rodou ao vivo em 2026-11-24 no char principal (nivel 87, linha ja acabada): pulou as missoes 2223 e 2224 e concluiu sem mandar nada. Aceitar, cacar o objetivo, DONE e FINISH numa main quest de verdade ficam sem prova ao vivo (o TAKE e o mesmo comando provado no Firm).

- **App:** o Firm passa a usar um modulo comum de missoes, `app/src/controller/quest.ts` (1-160): busca da missao na `m_TaskList`, corpos de `DoTask` e `OperateTask`, a viagem ate o NPC (ir, confirmar a viagem paga, chegar) e a guarda pra parar a caca so com o char seguro. Motivo: a missao principal precisa da mesma viagem e da mesma guarda, sem duplicar. Sem mudar o comportamento do Firm; unico texto mudado no log: "nao chegou ate o Leebaek". Arquivo: `app/src/controller/firm.ts` (35-40 import, 143-150 constantes, 152-194 `nextFirmStep`, 196-199 `trackFirm`). Como testar: `npm test` (os 11 testes do Firm passam sem alteracao). Status: testado por unidade.

- **Docs:** secao "Missao principal" no `engine/DISCOVERY.md` (452-506): campos do `XTaskDocument`, `XTaskRecord`, `XTaskInfo`, `KKSG.TaskConditionInfo` e da `TaskTableNew.RowData`, os enums `XTaskType`, `TaskStatus`, `TaskOPEnum`, `NpcTaskState` e `TaskConnType`, a faixa de IDs das main quests (1000000 a 4000105) e o que ficou sem prova. Lido ao vivo em 2026-11-24 so por GETP, OBJV, ENUM e FIND, sem mandar acao. Mais a linha da atividade no `README.md` e no `app/GUIA-TESTE.md`.

## [0.155.8] - 2026-11-24

- **App:** a busca de monstro do Treino nao vai mais ate a borda do ponto. Desde a 0.155.5 ela ia ate monstros em todo o raio (200 m no ponto 2); la o auto-play perseguia o monstro pra fora do raio e o Treino parava a caca e voltava andando ~215 m (2026-11-24 as 07:11, 07:48 e 07:52, ~30 s perdidos cada). Agora so busca ate 80% do raio (`SEEK_SPOT_FRAC` em `pickSeekTarget`, `app/src/controller/train.ts`). Como testar: `npm test`; ao vivo, o log quase nao mostra mais "longe do ponto (N m): parar a caca e voltar" com o char cacando no ponto.

- **App:** o Treino destrava o char preso em combate. Em 2026-11-24 07:27, de volta do Continental, o char ficou ~3,5 min "em combate" com a caca ligada, gastando MP, sem matar e sem tomar dano, com monstros parados a 2 m; a busca de monstro so age fora de combate e nao fazia nada. Agora, em combate por 30 s sem EXP e com o HP sempre acima de 90% (ninguem batendo), a IA larga o alvo (`XAIComponent.SetTarget` com nulo, pelo `callx` que ja existia; ela escolhe outro sozinha), a area da caca e recentrada e a caca e religada por cima, sem desligar nada; se continuar preso, tenta de novo a cada 30 s. O log diz a distancia e a altura do alvo travado (ou "IA sem alvo") pra achar a causa. Arquivos: `app/src/controller/train.ts` (`combatStuck`, `CLEAR_TARGET_BODY`) e `app/src/main/train.ts` (`targetInfo`). Como testar: `npm test`; ao vivo, preso assim, o log mostra "em combate ha N s sem matar e sem tomar dano (...): largando o alvo e religando a caca" e o EXP volta a subir. Comando provado ao vivo em 2026-11-24 07:57: a IA pegou outro alvo na hora e seguiu matando; o travamento em si ainda sem prova.

## [0.155.7] - 2026-11-24

- **App:** a busca de monstro do Treino sai mais rapido. A pedido do usuario em 2026-11-24 (com 6 s ainda ficava parado): sem EXP e sem combate por 2 s (antes 6 s), anda ate o monstro mais perto; 4 s entre buscas (antes 8 s); e, fora de combate no ponto, o loop le o char a cada 1 s (antes 3 s), entao a busca sai em ~2 a 3 s em vez de ~6 a 9 s. Arquivos: `app/src/controller/train.ts` (`SEEK_IDLE_MS`, `SEEK_COOLDOWN_MS`) e `app/src/main/train.ts` (`IDLE_POLL_MS`). Como testar: `npm test`; ao vivo, depois de matar o ultimo monstro em volta, o log mostra "parado sem monstro por perto: indo ate o mais perto (N m)" em ~3 s.

- **App:** opcao nova no Treino, **Lure** (juntar monstros): cacando no ponto, usa uma Demonic Domain Flower da mochila (puxa monstro num raio de 40 m por 20 min; a Normal primeiro, a Legendary I de 1 h depois). Diferente dos outros itens de buff, decide pelo buff 338 no char (lista `_ServerBuffList`, conferida a cada 1 min) e nao so pela validade guardada: se o buff sumir antes da hora, por exemplo depois de reconectar, usa outra. Sem leitura do buff, vale a validade como nos outros. Os testes de 2026-11-10 nao mostraram ganho de EXP nos pontos 2 e 1 (HP minimo 87%); ligada a pedido do usuario. Arquivos: `app/src/controller/booster.ts` (grupo `lure`, `buffDue`), `app/src/main/booster.ts` (`hasBuff`), `app/src/main/train.ts`, `app/src/controller/train.ts` e a tela do Treino. Como testar: `npm test`; ao vivo, com "Lure" marcado e o char no ponto, o log mostra "flor (lure) ativado: Demonic Domain Flower - Normal (sobram N)" em ate 1 min e outra 20 min depois. Prova ao vivo do comando e da leitura em 2026-11-24 06:36: estoque 53 -> 52 e o buff 338 apareceu.

## [0.155.6] - 2026-11-24

- **App:** o Treino ainda ficava parado com monstro a 20 e poucos metros. Visto ao vivo em 2026-11-24 06:15 (0.155.5): 20 s parado com um monstro a 22 m que o auto-play do jogo nao atacava (ele so pega ate ~16 m), e a busca nao saia porque qualquer monstro a menos de 25 m contava como "perto". Agora "perto" e ate 15 m, o tempo parado conta do ultimo EXP ou da ultima leitura em combate e a busca sai depois de 6 s (antes 15 s), com 8 s entre buscas (antes 15 s). Arquivos: `app/src/controller/train.ts` (`SEEK_CLEAR_M`, `SEEK_IDLE_MS`, `SEEK_COOLDOWN_MS`, `shouldSeek`) e `app/src/main/train.ts` (`lastCombatAt`). Como testar: `npm test`; ao vivo, com o monstro mais perto entre 15 e 25 m e o char parado, o log mostra "parado sem monstro por perto: indo ate o mais perto (N m)" em ate ~8 s.

## [0.155.5] - 2026-11-23

- **App:** Guild Boss e Sekhmet War entram assim que abrem. Em 2026-11-23 o Guild Boss entrou 42 s depois de abrir e a Sekhmet abriu 09:30 mas o bot so tentou 09:44 (com outras atividades na frente). Agora a checagem dos dois roda a cada 5 s (antes 15 s); aberto um deles, o app para o Continental, o Album de Cards e as diarias em andamento e segura a fila ate entrar (`checkTimedEvents` em `app/src/renderer/renderer.ts`); e, de 1 min antes ate o fim do horario da Sekhmet (lido da lista, no fuso do servidor), o estado e pedido ao servidor a cada 5 s em vez de 1 por minuto (`inActivityWindow` em `app/src/controller/sekhmet.ts`). Uma diaria interrompida assim volta na proxima tentativa. Como testar: `npm test`; ao vivo, o log mostra "Guild Boss aberto: entrando." ate ~5 s depois da abertura (09:00 de Brasilia, seg/qua/sex) e "Sekhmet War aberta: entrando." ate ~10 s depois das 09:30.

- **App:** o Treino ficava parado esperando monstro renascer. Agora, sem EXP por 15 s (antes 45 s), fora de combate e sem monstro a menos de 25 m, ele anda ate o monstro vivo mais perto em todo o raio do ponto (antes so ate 70 m do char) e religa a caca; a caminhada espera ate 30 s conforme a distancia (antes 6 s fixos) e a leitura olha ate 80 entidades (antes 40). Arquivos: `app/src/controller/train.ts` (`SEEK_IDLE_MS`, `pickSeekTarget`, `seekWalkMs`, `readEnemyPositions`) e `app/src/main/train.ts`. Como testar: `npm test`; ao vivo, com o ponto limpo o log mostra "parado sem monstro por perto: indo ate o mais perto (N m)" em ate ~15 s, inclusive com N acima de 70.

## [0.155.4] - 2026-11-22

- **App:** a Sekhmet War nao era detectada. O app lia `XActivityDocument IsMulActivityOpening`, mas esse estado e um cache que o jogo so renova com a tela de atividades aberta; sem ela ficava no "vai abrir" do login e o bot perdeu a Sekhmet de 2026-11-22 (todo dia das 20:30 as 21:00 do servidor, UTC+8, ou seja 09:30 as 10:00 de Brasilia). Agora a checagem pede a lista ao servidor (`SendQueryGetMulActInfo`, o mesmo pedido da tela) no maximo 1 vez por minuto antes de ler (`app/src/controller/sekhmet.ts`, `refreshActivities`). Como testar: `npm test` (teste do limite de 1 pedido por minuto); ao vivo, com a atividade Sekhmet ligada, as 09:30 de Brasilia o log mostra "Sekhmet War aberta: entrando." em ate 1 min e 15 s. Sem prova ao vivo (a proxima abre em 2026-11-23 09:30).

## [0.155.3] - 2026-11-21

- **App:** barra do **Berserk** no painel do char, ao lado do HP e do MP: mostra os pontos de raiva (ex.: "3/5"), "5/5 pronto" com a barra cheia e "ativo" com o modo ligado. Lida por metodo (`ArtifactDocument get_AngerPoint`, `get_AngerPointMax` e `get_AngerPointCD`, os mesmos que o jogo usa pra mostrar o botao), junto com a leitura do char a cada segundo. Antes so dava pra saber se o botao estava na tela. Ao vivo em 2026-11-21 (0.155.1) a barra enchia ~1 ponto a cada 8 min no ponto 74-76 e o Treino apertou sozinho com ela cheia. Como testar: com o char cacando, o painel mostra "Berserk 3/5" subindo ate "5/5 pronto" e vira "ativo" quando o Treino aperta. Sem prova ao vivo da tela nova.

## [0.155.2] - 2026-11-21

- **Engine:** blindagem contra a proxima atualizacao do jogo: o char atual (`XEntityMgr.<Player>`), os atributos (`_attr`) e, neles, nivel, nome, EXP, EXP maximo e o flag de morto agora sao achados pelo nome do campo, como a posicao e a IA na 0.155.0 e 0.155.1. Esses offsets nao mudaram em 2026-11-20, mas se mudarem o bot deixaria de achar o char (parece fora de mundo), o HP, o nivel e a morte. Os offsets antigos ficam de reserva. O PLYR passa a mandar o EXP com os 8 bytes do jogo (antes chegava negativo no Lv.87; o app ja corrigia). Como testar: com o jogo aberto pelo app nesta versao, o PLYR mostra `level` 87, o nome do char, `exp` positivo igual ao EXP do app e `dead` falso; o Treino caca normal. Sem prova ao vivo.

## [0.155.1] - 2026-11-21

- **Engine:** a IA da caca (`_ai`), a navegacao (`_nav`) e o flag de combate (`_bInCombat`) do `XEntity` agora sao achados pelo nome do campo, como a posicao no 0.155.0. A mesma atualizacao do jogo de 2026-11-20 andou esses campos 0x10 (`_ai` 0xd8 -> 0xe8, `_nav` 0xa8 -> 0xb8, `_bInCombat` 0x234 -> 0x244): ligar a caca so marcava o auto-play, sem engatar a IA, e o char ficava parado no ponto com monstro em volta (visto ao vivo em 2026-11-21 com o 0.155.0); o `aiFighting` e o `inCombat` do PLYR liam sempre falso e a ida ao ponto pelo `MOVE` nao achava o `_nav`. Os offsets antigos ficam so de reserva. Como testar: com o jogo aberto pelo app nesta versao e o Treino ligado no ponto, o PLYR mostra `aiFighting` verdadeiro, o char troca de alvo e mata; o log nao fica so em "caca ligada" com o char parado. Sem prova ao vivo do engine novo (a IA foi engatada por metodo, `callpi ... _ai SetAutoEnable`, com o 0.155.0).

## [0.155.0] - 2026-11-20

- **Engine:** a posicao do char e dos monstros (`_correctedPosition` e `_next_pos` do `XEntity`) agora e achada pelo nome do campo, nao pelo offset fixo. Na atualizacao do jogo de 2026-11-20 o layout mudou e o 0x204 fixo passou a ler (0, y, 1) pra todo mundo: o Treino via o char longe do ponto e nao religava a caca (char parado no ponto, com monstro em volta), e o mapa e a arena do Guild Boss liam tudo em (0, 1). O offset antigo fica so de reserva. Como testar: com o jogo aberto pelo app nesta versao, o PLYR devolve `corrected` igual as coordenadas do minimapa (ex.: 1314,1200 no North Taklamakan) e o Treino volta a cacar no ponto.
- **App:** Guild Boss: opcao **sair da arena depois de N mortes** (padrao 3; 1, 3, 5 ou nunca). Na arena a morte nao tira EXP e o jogo revive no lugar em ~20 s, mas o char principal Lv.87 morria a cada ~35 s contra o JeonUk Lv.155 (ao vivo em 2026-11-20) e o Treino ficava parado a luta inteira. Agora o bot conta as mortes e, ao renascer depois da ultima, sai pelo `ReqQuitScene` (ate 3 pedidos, 10 s entre eles; recusado, volta a lutar) e o Treino volta. Como testar: no Guild Boss o log mostra "morte 1 de 3 na arena" ate "3 mortes na arena: saindo e voltando pro Treino" e o char sai da arena. Sem prova ao vivo.
- **App:** Guild Boss: **Berserk e Devil na arena** (ligado por padrao, desligavel no card). Eles so rodavam no loop do Treino, que fica parado durante o Guild Boss, entao o char lutava sem os +100% de dano do Berserk. Mesmas regras do Treino: Berserk com a barra cheia, Devil uma vez por minuto, so vivo, em combate, com o auto-play e fora da fuga do golpe; nenhum gasta item. Como testar: com a barra do Berserk cheia na arena, o log mostra "Guild Boss: modo Berserk ativado (barra cheia)". Sem prova ao vivo.

## [0.154.0] - 2026-11-19

- **App:** **Sekhmet War** (World Boss, 20:30 do servidor), atividade nova e desligada por padrao. Quando abre (`XActivityDocument IsMulActivityOpening` 524): para o loop do Treino, sai da party, entra na arena (cena 2200), liga o auto-play e compra os buffs por gold escolhidos (padrao nenhum; 20 mil cada, nunca o de Silk). No fim (`isEnd`) sai da arena, e o Treino so volta com o char fora dela. Uma vez por dia do jogo; o Guild Boss e o Qigong esperam ela terminar. Ideia de um contribuidor (patch da 0.154.0), refeita no molde do Guild Boss: o patch entrava de novo a cada 10 s depois de sair, mandava pedido de batalha em cada leitura e pausava o Treino pela ida pra cidade. Como testar: marcar "Ativa" no card; as 20:30 do servidor o log mostra "Sekhmet War aberta: entrando.", o char luta e no fim aparece "saiu da arena; fim da luta." e o Treino volta. Sem prova ao vivo.
- **App:** Continental Exploration: rola tambem antes das 12 h quando ha dado guardado (`XSuperRiskDocument m_leftDiceTime`, que o servidor atualiza a cada dado novo pelo `RiskRecoverDiceNtf`), com pelo menos 1h30 desde a ultima rodada; e novo botao **Rolar agora** no card. Antes os dados ficavam parados ate a janela de 12 h. O Treino pausa o loop mais vezes (a rodada continua no ponto, com a caca ligada). Ideia de um contribuidor (patch da 0.154.0); o patch rolava a cada minuto enquanto sobrasse dado. Como testar: com o Continental marcado e um dado guardado, o log mostra "Continental: N dado(s) guardado(s); rolando antes das 12 h." e a proxima so vem 1h30 depois. Sem prova ao vivo.
- **App:** Guild Boss: compra o **buff de ataque por gold** na arena, na quantidade escolhida no card (padrao nenhum; 20 mil gold cada, limite do jogo 10). Compra com o char ja lutando e fora do aviso do golpe, espera a conta subir entre os pedidos e desiste se o servidor recusar. O de Silk nunca. O valor antigo do card (5, que nunca comprou nada) nao vale: e preciso escolher de novo. Ideia de um contribuidor (patch da 0.154.0); o patch comprava antes da fuga do golpe e sem limite. Como testar: escolher 3 buffs no card; na arena o log mostra "comprando buff de ataque por gold (1/3)" ate 3/3 e o gold cai 60 mil. Sem prova ao vivo.
- **App:** Firm: opcao **roleta gratis da cartela** (desligada por padrao). Antes do premio total, gira a roleta (`SendToRefreshTaskOp` DROT_Refresh com o roleid do proprio char, o mesmo do botao do jogo) ate a nota escolhida (B, A ou S), so enquanto `_refresh_num` mostra giro gratis e no maximo 3 por passada. Com 0 giros o botao do jogo compra giro (DROT_BuyCount); o bot nunca manda. Ideia de um contribuidor (patch da 0.154.0), refeita sem as mudancas da entrega e da missao. Como testar: marcar a opcao no Firm com a cartela abaixo de A; o log mostra "girar a roleta gratis do Firm (nota X, alvo A; N giro(s) gratis)" e a nota sobe ou os giros acabam. Sem prova ao vivo.

## [0.153.0] - 2026-11-18

- **App:** Treino: nova opcao **reviver no local com Resurrection scroll** (desligada por padrao). Morto, com pergaminho na mochila e perda de EXP na morte, o bot revive no lugar em 2 s pelo `XReviveDocument SendReviveRpc(ReviveOnTheSpot)`, o mesmo do botao, e nao perde EXP: reviver na cidade tirava 59,7 M do char principal Lv.87. Gasta 1 pergaminho por morte. Sem pergaminho, sem perda de EXP ou sem sucesso ate 45 s, revive na cidade como antes. O RevivePlace do auto-play continua na cidade: no local sem pergaminho o jogo abria a compra com Diamond e deixava o char 5 min morto. Como testar: marcar a opcao no Treino; na proxima morte o log mostra "reviver no local com Resurrection scroll (N na mochila; nao perde X de EXP)" e o char volta a cacar no mesmo lugar, com um pergaminho a menos. Sem prova ao vivo (precisa de uma morte).

## [0.152.0] - 2026-11-18

- **App:** **Guild Boss**: a fuga pra safe zone agora segue o aviso do golpe forte (a notice "<boss> is going to destroy the place, quickly find a safezone" do script da arena, lida no `BattleMain NoticeTime` e no `XLevelScriptMgr`). A 0.151.0 seguia o `_isEffectSafeZoneActive`, que em 2026-11-18 ficou ligado a luta inteira: o char ia pro circulo e ficava la sem atacar (dentro dele o jogo bloqueia as skills). Agora, no aviso, para o auto-play, corre pro circulo mais perto, fica ate 10 s depois do aviso sumir e religa o auto-play pra voltar pro boss.
- **App:** Guild Boss: com o evento fechado e o char ainda na arena, sai dela (`XGuildDragonDocument ReqQuitScene`). O Treino so religa com o char fora da arena: em 2026-11-18 ele voltou la dentro, tirou o char do circulo e o char morreu a cada 30 s ate o fim. Uma leitura falha da cena nao encerra mais a luta (precisa de 2 seguidas fora da arena), e marcar o Guild Boss com ele ja rodando nao abre um segundo loop.
- **App:** Guild Boss entra sozinho quando abre: a checagem saiu da fila de 1 min das atividades e roda num timer proprio a cada 15 s. Em 2026-11-18 ele nao entrou as 12:00 UTC e o usuario teve de desmarcar e marcar a caixa; a janela dos envelopes da guilda (12:00 a 14:15) segura o Gratis do dia na fila bem nessa hora, e um erro em qualquer atividade da fila pulava o resto. Agora cada atividade da fila roda mesmo se a anterior falhar, o log avisa "Guild Boss aberto: entrando" (ou que o Treino nao parou a tempo) e o Qigong nao roda durante o Guild Boss (ele leva o char pro Guild Hall, de onde o jogo nao deixa entrar).

## [0.151.0] - 2026-11-16

- **App:** Treino: o limite de mortes soma as mortes do Treino no dia, entre as rodadas. O Treino recomeca depois de cada evento e a conta zerava, entao com limite 1 o char podia morrer uma vez por rodada. Agora zera na virada do dia do jogo ou quando o usuario liga o Treino na mao.
- **App:** Treino: se o char ja esta morto quando o Treino comeca (morreu em outra atividade, como o golpe do Guild Boss), essa morte nao conta pro limite de mortes. Em 2026-11-16 o Treino voltou do Guild Boss com o char morto, contou 1/1, parou e deixou o char na cidade por 22 min.
- **App:** **Guild Boss** corrigido: a primeira versao olhava o World Boss (`XWorldBossDocument`), outro evento, e por isso nao entrava quando o Guild Boss abria. Agora o aberto vem do `XGuildDragonDocument bCanFight` e a entrada e o `ReqEnterScene` dele (o mesmo do Challenge), com nova tentativa a cada 10 s (ate 6). Na arena, quando o servidor abre a safe zone (golpe do boss), o bot para o auto-play, corre pro circulo mais perto (4 na arena, raio 6) e religa assim que ela fecha. O MOVE ia em JSON e o engine espera `x y z`: o char nunca andava. Parado ou no fim do tempo dentro da arena, religa o auto-play.
- **Engine:** o `GETP` le campo **estatico** (antes lia o objeto no deslocamento do campo, ou seja, lixo); a resposta traz `"static":true`. Usado pelo aviso da safe zone do Guild Boss (`XSafeZoneDocument _isEffectSafeZoneActive`).
- **App:** **Gratis do dia** tambem pega o **premio por tempo online** (faixa liberada, `XOnlineRewardDocument SendGetReward`) e os **anexos do correio** (`XMailDocument ReqMailOP` Claim, ate 5 paginas de 7 mensagens, volta pra primeira no fim). Nesses dois o Diamond e o Silk podem subir (compensacao de evento), nunca cair; caiu ou mudou em outro pedido, o card para como antes. O premio do dia seguinte nao existe neste servidor e o Battle Pass gratis fica pra depois.

## [0.150.0] - 2026-11-14

- **App:** **party** no Treino (Treino > Time), tudo pelos metodos do proprio jogo e desligado por padrao. Sem time: **criar o time e ficar de lider** (no lugar de entrar num time aberto), ou **aceitar convite** de quem esta numa lista de nomes ou de amigo/guilda. Lider com vaga: **entrada automatica ligada**, **aceitar pedidos de entrada** e **convidar** uma lista de nomes (o jogo acha o nome nos amigos, na guilda ou no mesmo mapa; so quem esta livre). Membro: **seguir o lider** pelo Follow do jogo, que anda atras dele (ate de mapa) e caca em volta. Seguindo, o ponto salvo fica de lado e o Treino nao desliga a caca; se o jogo parar de seguir (lider numa dungeon, troca de lider, saida do time) a caca e religada na hora e o pedido volta em 2 min. Pausa pra outra atividade para de seguir e deixa a caca ligada no lugar; a ida pra cidade so para de seguir depois da checagem de combate, HP e monstro perto.

## [0.149.0] - 2026-11-13

- **App:** atividade **Guild Boss** (Atividades > Guild Boss, desligada por padrao), por metodo: so com o evento aberto (ou o char ja na arena) para o Treino, sai da party (ReqTeamOp 7), abre o painel do World Boss e entra pelo Challenge, religa o auto-play na arena e pega a recompensa no fim. Fechado, nao mexe em nada e confere de novo a cada minuto. A opcao de buffs por gold e a safe zone do golpe supremo ja estao no painel, mas o fluxo ainda nao compra buff nem detecta o golpe. (contribuicao de `RicardoGuedes555`)
- **App:** Continental: com os espacos cheios de roxo ou melhor, so para de rolar se nao houver bau raro nas casas a frente; com bau dourado a frente, descarta um roxo trancado pra abrir vaga; bau dourado nao perde valor com os espacos cheios. Nova tentativa em 1 min depois de uma rodada que falhou (era 1 h). (contribuicao de `RicardoGuedes555`)
- **App:** Continental com **Foco de Build** (Equilibrado, INT ou STR) na regiao automatica por cards: soma 35% aos mapas impares (INT) ou pares (STR). (contribuicao de `RicardoGuedes555`)
- **App:** desmarcar uma atividade com o bot rodando tira o "feito hoje" dela e para o Guild Boss, a Torre ou o Continental; ligar a Torre (ou o Guild Boss) na hora para o loop do Treino antes e religa depois. As diarias pendentes sao conferidas ja no primeiro ciclo. (contribuicao de `RicardoGuedes555`)

## [0.148.0] - 2026-11-13

- **App:** o **Mapa** mostra **paredes e areas bloqueadas**: o navmesh da cena (o mesmo que o jogo usa pra achar caminho) pinta a area andavel um pouco mais clara, o resto fica escuro e a borda vira parede. Lido uma vez por mapa e guardado na pasta de dados (`navmesh/<cena>.txt`); nas proximas vezes abre na hora.
- **Engine:** comando `NAVM` (`start` pede `NavMesh.CalculateTriangulation` na thread principal; `get <pos>` devolve o resultado em pedacos de 60 mil caracteres).
- **App:** status do char: a aba Status mostra os **buffs ativos** com nome, nivel, pilha e tempo restante (descendo a cada segundo; lidos a cada 10 s), e a aba Estatisticas ganha **Abates** e **Abates / hora** da sessao.
- **Engine:** comando `BUFS` (buffs do char com o tempo restante pelo relogio do jogo, lido na thread principal) e `kills` no estado do jogador (o hook de morte conta so as mortes em que quem matou foi o char).
- **App:** o **Mapa** mostra o **caminho que o char esta andando**: uma linha azul do char ate o destino, so com o trecho que falta, e "andando: faltam N m" no topo. Vale pra viagem do Treino ate o ponto, missao e clique no mapa do jogo; parado, nao aparece. O caminho vem no mesmo ENTS do mapa (precisa do engine novo).
- **App:** aba **Chat** com o chat do jogo no painel: Mundo, Guilda, Party e Privado (quem mandou pra quem), com hora no seu fuso e nome de quem escreveu (o seu em dourado). Le com a aba aberta e o jogo conectado; a primeira abertura de um canal traz as ultimas 30 mensagens (uns 7 s) e depois so as novas, a cada 3 s. Da pra **responder** pela caixa embaixo (Enter ou Enviar): a mensagem sai pelo mesmo metodo do botao Enviar do jogo, com o filtro de palavras dele. No privado vai pra conversa escolhida (clique numa mensagem; sem escolha, a mais recente). O app respeita as regras do canal (Mundo pede Lv.10 e 20 s entre mensagens; ate 200 caracteres) e so manda quando voce clica.
- **Engine:** comando `CHAT` pra mandar mensagem no chat (canal, destino e texto em UTF-8). E o texto lido do jogo sai inteiro em UTF-8 (antes letra fora do ASCII vinha como "?"): nomes e mensagens em tailandes, arabe, com acento ou simbolo aparecem certos. Vale depois de abrir o jogo de novo pelo app (o engine novo entra na injecao).

## [0.147.0] - 2026-11-12

- **App:** Continental com a regiao **Automatico por cards**: escolhe o mapa cujos cards mais faltam no Album de Cards pra fechar combinacoes e subir estrela (grupo no maximo nao gasta dado; sem leitura do album, cai no automatico por nivel). A leitura do album fica guardada pra rodada usar, e cada passada de baus pede uma nova analise do album. Depois de cada passada so de baus a rodada de dados e antecipada pra checagem seguinte, mesmo com o char cacando (no ponto valem as travas de HP de sempre: so comeca com 90% e desiste abaixo de 60%).

## [0.146.1] - 2026-11-12

- **App:** o Firm ja entregue no dia deixa de aparecer como "falhou: missao do Firm nao achada (char sem guilda?)". Depois do premio total o jogo tira a missao da lista ate a virada do dia; agora o app le o premio do dia e a guilda, conclui com "Firm de hoje ja entregue" e nao tenta de novo a cada Iniciar bot. "Sem guilda" so aparece quando o char nao tem guilda mesmo.

## [0.146.0] - 2026-11-12

- **App:** faixa de **por que parou** no topo do painel: a ultima parada importante, a hora e o que fazer (treino concluido por limite de mortes ou outro motivo, conta em outro aparelho, jogo que nao reabriu, mochila cheia, EXP/h caindo, e em cinza as quedas que o app ja resolveu sozinho). Fica salva com o app fechado (quem abre de manha ve o que houve de noite) ate o "x" ou ate o bot ser iniciado de novo; um aviso leve nao cobre um mais grave.

## [0.145.1] - 2026-11-12

- **App:** voltam as duas mudancas do Continental da 0.144.0 que a 0.145.0 perdeu no merge do Album de Cards: a hora da proxima rodada de dados no painel e a passada de baus que rola os dados com o char fora da caca.
- **App:** aviso de monstro unico. Com o bot rodando, o app le as entidades em volta pelo `ENTS` a cada 15 s (ou a cada leitura da aba Mapa) e, quando aparece um chefe vivo, avisa uma vez no log, no Windows e no Telegram (grupo "Problemas") com nome, nivel e distancia. O mesmo unico so avisa de novo depois de sumir por 30 min. So avisa: o bot nao vai atras dele. Com engine antigo (sem `ENTS`) nao ha aviso.

## [0.145.0] - 2026-11-12

- **App:** aba **Mapa**, a visao de cima ao vivo do que esta em volta do char: voce no centro (norte pra cima), monstros com nivel e barra de HP (elite e chefe em cores proprias; Champion e Giant contam como elite pelo nome, porque o jogo nao os marca), o alvo atual marcado e ligado por uma linha, outros jogadores e a party com nome e nivel, NPCs e pets, itens no chao, os pontos de caca salvos com o raio, grade em metros, zoom e radar de 120 m. O topo mostra o mapa, o canal e as contagens. So le com a aba aberta e o jogo conectado.
- **Engine:** comando `ENTS`, que entrega numa consulta o jogador, o alvo do auto-play, as entidades ate 150 m (tipo, nivel, HP, nome em UTF-8) e os itens no chao. Sem ele (engine antigo), o mapa usa uma leitura mais lenta pelo GETP a cada 20 s, sem HP e sem itens no chao. O engine novo entra quando o jogo e reaberto pelo app. Provado no jogo: no ponto 74-76 o `ENTS` leu os mesmos 17 monstros que o GETP em 11 a 47 ms, contra 3 a 5 s.
- **App:** botao **Exportar diagnostico** (Ferramentas > Diagnostico): gera um `.txt` com versoes, configuracao (pasta de dados e painel), historico de 24 h e o log, pra mandar quando algo der errado. Senha, token e chaves ficam de fora: os `.bin` e a VPN nao entram, campo com nome de segredo ou de chat vira `***` e o texto perde o que tem formato de token do Telegram, chave de API ou chave WireGuard.
- **App:** atividade **Álbum de Cards** (Atividades > Álbum de Cards), por metodo e rodando mesmo cacando: ativa as combinacoes prontas, sobe a estrela do grupo quando completa e, se marcado, quebra so as cartas que sobram acima do total que ainda vai usar ate a estrela maxima de todos os grupos. Escolhe as raridades que podem ser quebradas (por padrao so C e B) e o grupo alvo; "Analisar cards" mostra o que faria sem mexer em nada. Os testes do modulo passam a rodar no `npm test` e no CI.

## [0.144.0] - 2026-11-12

- **App:** o painel do Continental mostra a hora da proxima rodada de dados (e da passada de baus, quando vem antes). Entre as rodadas de 12 h a passada de baus nao rola dado, de proposito (a caveira abre luta no meio da caca), e isso parecia travado.
- **App:** com o char fora da caca (sem o Treino rodando, fora de combate e sem lista de chars), a passada de baus tambem rola os dados, desde que tenha recarregado ao menos um (1h30) desde a ultima rodada. Cacando, segue so baus como antes.

## [0.143.0] - 2026-11-11

- **App:** avisos no celular pelo Telegram (Ferramentas > Avisos no Telegram). A pessoa cria um bot no `@BotFather`, cola o token (fica criptografado pelo Windows, nunca volta pra tela nem pro log), manda um "oi" pro bot e clica em Ligar: o app acha o chat sozinho e manda uma mensagem de teste. Dois grupos: "Problemas" (morte, queda da conexao, jogo congelado, falha ao reabrir, conta em outro aparelho, mochila cheia, EXP/h caiu), ligado por padrao, e "Fim de atividade" (treino e Continental concluidos). O mesmo aviso sai no maximo a cada 10 min, menos morte.
- **App:** pet de jogador (inclusive o do proprio char) deixa de contar como monstro. O jogo marca pet com o bit de inimigo, e ele entrava no "monstro a menos de 10 m" que segura a saida segura, na busca de alvo e no nivel da area. Agora o app le o tipo da entidade (`_eEntity_Type`) e ignora pet, montaria e invocacao, com o mesmo numero de leituras.

## [0.142.0] - 2026-11-11

- **App:** depois de atualizar pelo botao, o app volta como estava: reabre o jogo (so reconecta, com o char em mundo) e religa o bot se ele estava rodando. O aviso vale por 10 min. Passa a valer nas atualizacoes feitas a partir desta versao.

## [0.141.1] - 2026-11-11

Primeira versao com instalador que se atualiza sozinho. Quem usa o EXE portatil instala uma vez o SRO-Bot-Setup; as configuracoes continuam as mesmas.

- **App:** atualizacao automatica pelos Releases do GitHub (electron-updater). O Release passa a ter o instalador `SRO-Bot-Setup-X.Y.Z.exe`, que se atualiza sozinho: o app confere ao abrir e a cada 2 h, baixa em segundo plano e mostra "Atualizar para vX.Y.Z" no topo; instala so com o clique e reabre o app (o jogo continua aberto; com o Treino rodando, a caca do jogo e religada antes de fechar). O EXE portatil continua, sem auto-update. A versao do app aparece no topo.
- **CI:** o Release publica tambem o instalador, o `latest.yml` e o `.blockmap`.

## [0.141.0] - 2026-11-11

Primeira versao publicada em Releases: EXE portatil para Windows com o engine dentro.

- **App:** Guild utilities com a opcao "Guild Store toda semana": compra o limite semanal de Pet Eggs - Precious (8), Pet Eggs - Rare (3) e Dimension Hole - Forgotten World (2), so com contribuicao da guilda, uma unidade por vez, conferindo a semana, a contribuicao e que Silk e Diamond nao mudaram. A contagem da loja zera no domingo e o proximo Guild utilities compra de novo. Desligada numa instalacao nova.
- **App:** o card "Gratis do dia" pega o premio diario do cartao de privilegio (Silver, Golden ou Premium Card) no Premium Shop > Privilege: so com a loja fechada, abre a aba, aperta o Claim por metodo, confirma pelo servidor e fecha. O dia do premio vira as 05:00 do servidor. Diamond nao pode mudar e Silk nao pode cair.
- **Engine:** comando `callxm`, o `callx` com os caminhos resolvidos na thread principal (pra chegar em botao de tela por `Find`/`GetComponent`); no meio de um caminho, `Metodo:"texto"` passa a mandar texto de verdade e escolhe a versao do metodo com parametro `string`. Antes o texto virava `0` e prendeu o engine.
- **App:** Continental com mapa "Automatico": cada char rola no mapa mais alto que o nivel dele libera (Lv.87 no Asia Minor, Lv.60 no Desert), tambem no ciclo entre chars. Vem como padrao numa instalacao nova; os mapas 4 a 7 ganharam o nome real (Roc Mountain, Eastern Europe, Asia Minor, Central Asia).
- **Dev:** TypeScript 7 (`tsconfig` com `moduleResolution: bundler`), esbuild 0.28 e sql.js 1.15 (SQLite 3.54). O canal do engine aceita o `data` do socket como texto ou Buffer. Sem mudanca de comportamento no app.
- **Dev:** Electron 45 (Node 24) com `@types/node` 24.19 e electron-builder 26.
- **Dev:** Tailwind 4 com o `@tailwindcss/cli` e a configuracao de sempre (`@config`); o build do CSS tinha quebrado com o Tailwind 4. O painel ficou igual (cores, fontes, bordas, larguras), com tres ajustes pequenos do Tailwind 4: o conteudo de cada aba comeca 16 px mais acima (o `space-y` deixou de somar a margem dos paineis escondidos), os titulos de secao ficaram 4 px mais baixos e o cabecalho da tabela da IA 2 px. O cursor de mao nos botoes foi mantido.
- **CI:** testes, typecheck, build completo do app e guarda de conteudo em todo push e PR; Dependabot semanal.
- **CI:** o engine compila no Linux com o NDK r27c em todo push e PR (artefato `engine-build`); o `engine/build.sh` roda no Windows, no Linux e no macOS. Tag `v*` gera o EXE portatil com o engine dentro e publica o Release com as notas do CHANGELOG.

## [0.140.0] - 2026-11-11

- **App:** no Treino, com jogador de fora do time cacando a menos de 80 m por 2 min, o char troca para o canal mais vazio do mesmo ponto (nunca o Activity Channel); sem canal livre, vai para o proximo ponto.

## [0.139.0] - 2026-11-11

- **App:** a IA busca sozinha os modelos do Gemini e troca para um que exista; o campo Modelo vazio é automático; o erro de tempo esgotado ficou claro.

## [0.138.0] - 2026-11-10

- **App:** o card "Grátis do dia" ganha a opção "Doar no Support da guilda".

## [0.137.1] - 2026-11-10

- **Docs:** guia de teste (LEIA-ME) atualizado com as atividades atuais; o exemplo da caixa da IA ficou generico.

## [0.137.0] - 2026-11-10

- **App:** a conta de pedidos de Qigong sem aceite sobrevive a reabrir o app.

## [0.136.0] - 2026-11-10

- **App:** o card "Grátis do dia" pega os red envelopes do Lucky Money da guilda, conferindo a cada 5 min na janela das 09:00 às 11:15.

## [0.135.0] - 2026-11-10

- **App:** o Firm conclui o dia (Submit) e pega o prêmio total com 3 ou mais entregas; o card "Grátis do dia" abre os baús do sign-in da guilda ao longo do dia.

## [0.134.0] - 2026-11-10

- **App:** card "Grátis do dia" pega sozinho os pacotes grátis do Event (Premium Shop), o attendance do Welfare com os prêmios acumulados e a caixinha grátis do Daily Pack.

## [0.133.0] - 2026-11-10

- **App:** o Qigong para de pedir a quem nao aceitou 2 vezes no dia; comentario do ponto de reserva sem x10 corrigido com a medicao.

## [0.132.0] - 2026-11-09

- **App:** o Qigong reconhece a ida pro Guild Hall como aceite e sai de la no fim; char parado no Guild Hall sai sozinho; a etiqueta do Treino nao apaga mais na troca de cena.

## [0.131.0] - 2026-11-09

- **App:** o Firm espera o char andar ate a borda do mapa em vez de desistir da viagem; diaria que falha tenta de novo no mesmo dia; a virada das 18:00 nao fica mais presa ao Treino; o Qigong nao roda junto com as diarias.

## [0.130.0] - 2026-11-09

- **App:** o Qigong pede de qualquer lugar a cada 10 min (nao so na cidade depois do Firm) e aceita com HP de 60% ou mais.

## [0.129.0] - 2026-11-09

- **App:** nova atividade "Qigong" (pedir e aceitar), com os membros da guilda a 10 niveis ou mais de diferenca.

## [0.128.0] - 2026-11-09

- **App:** nova atividade "Baús de atividade diária": pega os baús de 30, 60, 90, 120 e 150 pontos assim que liberam.

## [0.127.0] - 2026-11-09

- **App:** reabrir o app nunca reinicia o jogo por uma falha do adb; o engine e perguntado primeiro.

## [0.126.0] - 2026-11-09

- **App:** na cidade salva, monstro fixo perto nao prende o Treino; booster, buffs e a abertura do x10 so dentro do raio do ponto.

## [0.125.0] - 2026-11-09

- **App:** sem o training time x10 o Treino caca no ponto 2; a parada da caca fora do Treino conta so monstro vivo e perto.

## [0.124.0] - 2026-11-08

- **App:** o Treino le o training time x10 e abre o tempo guardado, 30 min por vez, enquanto caca no ponto.

## [0.123.0] - 2026-11-08

- **App:** alarme de EXP/h, pra avisar quando o training time (x10) acabar.

## [0.122.0] - 2026-11-08

- **App:** o Continental rola no proprio ponto com a caca do jogo ligada, sem levar o char pra cidade.

## [0.121.0] - 2026-11-08

- **App:** Tower, Guild e Firm rodam na virada do dia do jogo (18:00) com o bot ligado; o Treino parado no meio de uma viagem religa a caca.

## [0.120.0] - 2026-11-08

- **App:** o Treino volta sozinho pro ponto 1 depois de 30 min num ponto de reserva, com o char seguro.

## [0.119.0] - 2026-11-08

- **App:** o EXP do nivel e lido com 64 bits; o maximo do Lv.87 e 6,55 G, nao 2,26 G.

## [0.118.0] - 2026-11-08

- **App:** nenhuma atividade desliga a caca ou viaja com o char em risco (volta ao ponto, Firm, fim da torre, Parar bot), o Treino comeca no ponto mais perto, a ida pra cidade que nao chega religa a caca e o Continental so roda na cidade; corpos de monstro deixam de contar.

## [0.117.0] - 2026-11-08

- **App:** o Treino so desliga a caca com o char seguro (ida pra cidade e troca de ponto), procura monstro quando fica parado, e o Continental reconhece a arena da caveira e luta.

## [0.116.0] - 2026-11-07

- **App:** o Firm so desliga a caca com o char seguro (fora de combate e sem monstro perto).

## [0.115.0] - 2026-11-07

- **App:** Berserk e devil automaticos no Treino (so em combate) e a opcao Demon do auto-play forcada.

## [0.114.0] - 2026-11-07

- **App:** a IA ve o ataque e a defesa de cada peca equipada (base no +0 e quanto cada +1 soma), e o retrato do personagem ficou bem mais rapido.

## [0.113.0] - 2026-11-07

- **App:** venda do lixo (equipamento de pet comum, drops de monstro, itens de evento encerrado e kits da Caravana; cartas ficam), pelo botao "Vender lixo agora" e, com a opcao ligada, automatica com a mochila abaixo de 15 livres.

## [0.112.0] - 2026-11-07

- **App:** a IA ve o personagem completo (atributos, equipamento, maestrias, skills com efeito), escolhe um modelo que o provedor tem e sabe quanto falta pro proximo nivel.

## [0.111.0] - 2026-11-07

- **App:** aba de IA com aviso de espera e tres provedores com plano gratis (OpenRouter, Groq, Mistral).

## [0.110.0] - 2026-11-07

- **App:** o vigia de "jogo congelado" conta a partir de quando o bot e o Treino comecam.

## [0.108.0] - 2026-11-07

- **App:** no level-up, o Treino sobe as maestrias que o char ja usa e as skills que elas liberam.

## [0.107.0] - 2026-11-07

- **App:** o bot mede o EXP que cada atividade rende (Tower, Continental, Firm, Guild) e grava no log e no Historico.

## [0.106.0] - 2026-11-07

- **App:** ao iniciar com o char longe do ponto, o Treino so viaja fora de combate.

## [0.105.0] - 2026-11-07

- **App:** login da conta pelo SDK confere a senha mascarada pelo tamanho e redigita uma vez; causa do travamento no voo entre mapas achada.

## [0.104.0] - 2026-11-07

- **App:** "Parar bot" nao desliga mais a caca com o char em combate ou com monstro perto.

## [0.103.0] - 2026-11-07

- **App:** pergaminho de dano e VIP Scroll automaticos no Treino, junto do Exp Booster (cada grupo com a propria validade).

## [0.102.0] - 2026-11-07

- **App:** entrar em time pelo `ReqTeamOp` (o `TryJoinTeam` parou de funcionar com a atualizacao do jogo); guia de uso com tudo de hoje.

## [0.101.0] - 2026-11-07

- **App:** Exp Booster automatico no Treino (cacando no ponto, um por vez).

## [0.100.0] - 2026-11-07

- **App:** auto-login que falha 2 vezes seguidas reinicia o jogo (cliente congelado no voo do teleporte entre mapas).

## [0.99.0] - 2026-11-07

- **App:** o Treino fixa o ponto de nascimento da IA no ponto de caca; o auto-play parou de levar o char pro oasis.

## [0.98.0] - 2026-11-07

- **App:** aviso de mochila cheia visivel (espacos livres na tela, selo no topo e notificacao do Windows).

## [0.97.0] - 2026-11-07

- **App:** ID e senha da conta salvos no app (criptografados) e login automatico na tela nativa do SDK da Gamo.

## [0.96.0] - 2026-11-07

- **Engine:** `callx`, chamada com argumentos tipados (inteiro, id de 64 bits, bool, nulo, texto e objeto achado por caminho).

## [0.95.0] - 2026-11-07

- **App:** time de 1 sai pra procurar outro; time que recusa fica de fora 30 min e o Treino tenta ate 3 por checagem.

## [0.94.0] - 2026-11-07

- **App:** o Treino vigia os suprimentos do auto-play (pocao dos espacos e mochila) e avisa antes do char empacar na zona segura.

## [0.93.0] - 2026-11-07

- **App:** preso no ponto nao reinicia mais o jogo. O Treino desliga e religa a caca e depois troca de ponto; o vigia so reinicia com o jogo congelado.

## [0.92.0] - 2026-11-07

- **App:** IA fase 2, historico em SQLite com EXP/h por area (Farm & Hunting) e eventos.

## [0.91.0] - 2026-11-07

- **App:** aba de IA (opcional), com assistente sobre o estado real do bot e acoes no jogo com travas.

## [0.90.0] - 2026-11-07

- **App:** protecao de HP no Treino, troca pro ponto de reserva quando o HP cai no ponto.

## [0.89.0] - 2026-11-07

- **App:** passada so de baus do Continental entre as rodadas de dado, agendada pelo cronometro do bau.

## [0.88.0] - 2026-11-07

- **App:** Team no Treino (modo membro): sem time, entra num time aberto pelo bonus de EXP e SP.

## [0.87.0] - 2026-11-07

- **App:** Continental por tempo com pausa segura do Treino; "Abrir jogo" nao reinicia um jogo em mundo; check de saude do tunel.

## [0.86.0] - 2026-11-07

- **App:** rota do jogo por VPN gratuita (WireGuard + WARP); atividades diarias nao repetem a cada reconexao; troca de char nunca com o char cacando.

## [0.85.0] - 2026-11-07

- **App:** reconexao automatica quando o jogo perde o servidor, e o Treino deixa de desligar a caca a cada perseguicao.

## [0.84.0] - 2026-11-07

- **Engine:** leitura de array de struct e metodo de 2 ou 3 args no meio do caminho. Skills e maestrias mapeadas; Firm pelo loop provado.

## [0.83.0] - 2026-11-07

- **App:** Treino fase 1. Varios pontos com canal e raio, troca de ponto, condicoes de parada e volta pra cidade.

## [0.82.0] - 2026-11-07

- **Engine:** `callv3` chama metodo com Vector3 (navegar ate um ponto em outro mapa). Mapeamento do Train, fase 1.

## [0.81.0] - 2026-11-07

- **App:** Guild utilities (sign-in da guilda, baus do sign-in e salario) como atividade, por metodo.

## [0.80.0] - 2026-11-07

- **Docs:** guia de teste atualizado com o que o teste numa instancia limpa mostrou.

## [0.79.0] - 2026-11-07

- **App:** o Continental diferencia chars de mesmo nome em servidores diferentes.

## [0.78.0] - 2026-11-07

- **App:** no fim do ciclo do Continental o bot volta pro char principal, onde rodam Firm e Treino.

## [0.77.0] - 2026-11-07

- **App:** o Treino avisa ponto sem monstro e recusa ponto com a posicao zerada.

## [0.76.0] - 2026-11-07

- **App:** o login espera o pacote do mapa inteiro, mesmo com a barra parada.

## [0.75.0] - 2026-11-07

- **App:** Continental com chars de outro servidor, pacote do mapa baixado no login e mira medida em uso.

## [0.74.0] - 2026-11-07

- **App:** o auto-login avisa quando falta logar a conta, e "Parar bot" cancela o login em andamento.

## [0.73.0] - 2026-11-07

- **App:** o Firm espera o estado do servidor antes da primeira leitura.

## [0.72.0] - 2026-11-06

- **Engine e app:** a primeira abertura com o emulador recem ligado nao trava mais (tela preta).

## [0.71.0] - 2026-11-06

- **App:** o "Abrir jogo" destrava sozinho os servicos presos do LDPlayer.

## [0.70.0] - 2026-11-06

- **App:** guia de teste copiado ao lado do EXE.

## [0.69.0] - 2026-11-06

- **App:** suporte ao MuMu Player na configuracao e pasta do jogo pelo `pm path` (Android novo).

## [0.68.0] - 2026-11-06

- **App:** EXE portatil pelo electron-builder.

## [0.67.0] - 2026-11-06

- **App:** configuracao de caminhos (pasta do LDPlayer, instancia, adb) e "Testar conexao".

## [0.66.0] - 2026-11-06

- **Repo:** nenhum arquivo nem dependencia de terceiros no repositorio.

## [0.65.0] - 2026-11-06

- **App:** injecao independente (guarda e devolve o que estava no aparelho; outro loader instalado e respeitado).

## [0.64.0] - 2026-11-06

- **App:** Firm (tarefa diaria de guilda) como atividade, por metodo.

## [0.63.0] - 2026-11-06

- **Engine:** GETP le elemento de array e chama metodo com 2 ou 3 args int.

## [0.62.0] - 2026-11-06

- **Docs:** fluxo do Firm (tarefa diaria de guilda) mapeado e provado por metodo.

## [0.61.0] - 2026-11-06

- **App:** o treino devolve as opcoes do auto-play que mudou quando para.

## [0.60.0] - 2026-11-06

- **App e engine:** o treino avisa quando a area e fraca pro char; GETP com arg texto e metodo estatico.

## [0.59.0] - 2026-11-06

- **App:** raio do ponto de treino de 60 m para 150 m.

## [0.58.0] - 2026-11-06

- **App:** o Continental so mira depois que o tabuleiro assenta.

## [0.57.0] - 2026-11-06

- **App:** chamadas ao adb com prazo.

## [0.56.0] - 2026-11-06

- **App e engine:** Treino completo por metodo (auto-play do jogo configurado, ponto de treino, vigia da caca e das mortes).

## [0.55.0] - 2026-11-06

- **App:** Continental mira o dado, trata a casa caveira e roda varios personagens; auto-login entra no char pedido.

## [0.54.0] - 2026-11-06

- **Engine:** `callpi` chama metodo com args int32 num objeto achado por caminho.

## [0.53.0] - 2026-11-06

- **App:** Continental Exploration le a cor do bau pelo jogo e aceita o tabuleiro sem o maximo de dados.

## [0.52.0] - 2026-11-06

- **App:** painel do Continental Exploration no Electron (config e IPC).

## [0.51.0] - 2026-11-05

- **App:** atualizacao do jogo tratada no auto-login, por metodo, com tempo restante.

## [0.50.0] - 2026-11-05

- **Engine:** comandos e socket disponiveis antes do XMainClient (tela de atualizacao do jogo).

## [0.49.0] - 2026-11-05

- **App:** Continental Exploration guiado por estado, 100% por metodo (logica, runner e goal).

## [0.48.0] - 2026-11-05

- **Engine:** `ENUM <Classe>` devolve nomes e valores de um enum do jogo.

## [0.47.0] - 2026-11-05

- **Engine:** documentos do jogo resolvem por nome de classe pelo `get_Doc` estatico.

## [0.46.0] - 2026-11-05

- **App:** Parar bot durante a torre mostra "parado", nao "falhou".

## [0.45.0] - 2026-11-05

- **App:** cada origem do log no main poe o proprio prefixo.

## [0.44.0] - 2026-11-05

- **App:** auto-login so dispara depois de 15 s fora de mundo.

## [0.43.0] - 2026-11-05

- **App:** Select Area com regiao salva troca pelo documento e fecha o frame.

## [0.42.0] - 2026-11-05

- **App:** a torre espera os dados do servidor antes de decidir.

## [0.41.0] - 2026-11-05

- **App:** Demon Locking Tower guiado por estado, sem espera por tempo e sem gasto.

## [0.40.0] - 2026-11-05

- **Engine:** `callp` chama metodo num objeto achado por caminho, na main thread.

## [0.39.0] - 2026-11-05

- **App:** o auto-login tambem volta pra regiao salva.

## [0.38.0] - 2026-11-05

- **App:** o auto-login escolhe o servidor e o personagem salvos quando o jogo estiver em outro.

## [0.37.0] - 2026-11-05

- **Engine:** o ultimo passo do `GETP` aceita `Metodo:N` (getter com 1 arg int).

## [0.36.0] - 2026-11-05

- **Engine:** `callsi` (args int), tipos de parametro no `FIND`, indices e argumentos int no caminho, e `KEYS` de Dictionary.

## [0.35.0] - 2026-11-05

- **Engine:** detecta o runtime pelo /proc/self/maps em vez de dlopen a cada segundo (crash no boot).

## [0.34.0] - 2026-11-05

- **App:** o auto-login nao repete "entrar no mundo" enquanto o mundo carrega.

## [0.33.0] - 2026-11-05

- **Engine:** a espera pelo XMainClient dura de verdade ate 15 min.

## [0.32.0] - 2026-11-05

- **Engine:** as threads do socket se registram no runtime do il2cpp (crash em excecao).

## [0.31.0] - 2026-11-05

- **App:** o auto-login salva regiao, servidor e personagem do login.

## [0.30.0] - 2026-11-05

- **Engine:** `GETP`/`OBJV` devolvem texto e aceitam getter de 0 args no meio do caminho.

## [0.29.0] - 2026-11-05

- **App:** auto-login 100% por metodo, guiado pelo sub-estado da tela de login (sem tap).

## [0.28.0] - 2026-11-05

- **Engine:** `OBJV` e `GETP` leem campos e getters seguindo um caminho de campos a partir de um singleton.

## [0.27.0] - 2026-11-05

- **Engine:** getv/calls/callsn nao invocam metodo de instancia sem singleton (crash do jogo).

## [0.26.0] - 2026-11-05

- **Engine:** inline hook arm64 para drenar acoes na main thread antes do mundo.

## [0.25.0] - 2026-11-05

- **App:** watchdog reabre o jogo e corrige o loop que travava com o engine fora.

## [0.24.0] - 2026-11-05

- **Engine:** `getv` le o valor de retorno de um getter (desbloqueia estado-guiado).

## [0.23.0] - 2026-11-05

- **App:** painel de config do Demon Locking Tower e atividades com checkbox "Ativa".

## [0.22.0] - 2026-11-05

- Demon Locking Tower: fluxo validado ao vivo ponta a ponta e claim corrigido.

## [0.21.0] - 2026-11-05

- Demon Locking Tower: atividade do bot, 100% por metodo (sem tap), + ferramentas de RE de UI no engine.

## [0.20.0] - 2026-11-05

- **App:** controle de jogo/bot em dois toggles, injecao pelo proprio app e auto-login.

## [0.19.0] - 2026-11-05

- Auto-hunt para de verdade (desliga a behavior tree) e ferramentas de RE no engine.

## [0.18.0] - 2026-11-05

- Auto-hunt real descoberto e ligado pelo engine (toggle provado ao vivo).

## [0.17.0] - 2026-11-05

- Reconciliacao do protocolo entre o engine persistente e os dois clientes TS (canal do controlador e one-shot do app).

## [0.16.0] - 2026-11-04

- Controle de treino (auto-battle) na aba Atividades do app.

## [0.15.0] - 2026-11-04

- Protocolo do engine persistente (push de estado) e atividade fiada na Instance.

## [0.14.0] - 2026-11-04

- Camada de atividades no controlador: goal de treino que mantem o auto-battle.

## [0.13.0] - 2026-11-04

- Comando SKIL no engine: liga/desliga o auto-battle pela fila de thread principal.

## [0.12.0] - 2026-11-04

- Migracao completa de Python para Electron/TypeScript. Python removido do repo.

## [0.11.1] - 2026-11-04

- Estados dead/inCombat no RESP; mortes e tempo de combate nas estatisticas.

## [0.11.0] - 2026-11-04

- Aba Estatisticas no app (derivadas do polling).

## [0.10.0] - 2026-11-04

- HP/MP achados e no RESP (via GetAttr, double); barras no app.

## [0.9.0] - 2026-11-04

- MOVER FUNCIONA: hook de UnityMainThreadDispatcher.Update na thread principal.

## [0.8.1] - 2026-11-04

- Hook de Update + fila de acoes (bloqueado pela parede do HybridCLR).

## [0.8.0] - 2026-11-04

- Agir (chamar metodos): enumeracao de metodos e invocacao; movimento precisa da thread principal.

## [0.7.1] - 2026-11-04

- Auto-login robusto com deteccao de tela (sem espera fixa).

## [0.7.0] - 2026-11-04

- RESP do engine com nivel, exp e nome; UI mostrando dados reais.

## [0.6.0] - 2026-11-04

- UI desktop em Electron (tema escuro), TypeScript + Tailwind.

## [0.5.0] - 2026-11-04

- Auto-login por toques (ADB), elimina o login manual.

## [0.4.2] - 2026-11-04

- Nome do jogador lido; scan seguro de valores; HP/MP ainda nao localizados.

## [0.4.1] - 2026-11-04

- Leitura de atributos do jogador (nivel, exp, profissao, genero).

## [0.4.0] - 2026-11-04

- Passo 1 fechado: leitura de posicao viva do jogador.

## [0.3.1] - 2026-11-04

- Mapa do objeto do jogador em mundo e tentativa de leitura viva.

## [0.3.0] - 2026-11-04

- Descoberta em runtime das classes de gameplay (passo 1).

## [0.2.1] - 2026-11-04

- Engine PoC validado de ponta a ponta no LDPlayer (jogo real, arm64 sob Houdini).

## [0.2.0] - 2026-11-04

- Engine PoC in-process (arm64), separado do controlador. Read-only: bootstrap do IL2CPP, enumeracao de assemblies e classes, resultado por socket.

## [0.1.0] - 2026-11-04

- Esqueleto inicial do controlador multi-instancia: maquina de estados por instancia, goals com preempcao, triggers e canal TCP com o engine.
