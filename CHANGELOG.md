# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/). Uma linha por versao com o que ela trouxe.

## [Nao lancado]

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
