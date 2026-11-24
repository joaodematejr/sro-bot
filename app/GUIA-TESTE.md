# SRO Bot: guia de teste

Versão de teste do bot para Silkroad Origin Mobile em emulador Android no Windows.
Ele funciona chamando o próprio jogo por dentro, sem clicar na tela.

**Antes de tudo:** usar bot quebra os termos do jogo e pode banir a conta. Teste
com uma conta que você aceita arriscar.

## 1. O que precisa

- Windows 10 ou 11, 64 bits.
- **LDPlayer 9** (testado) ou **MuMu Player** (suporte novo, ainda em teste).
- O Silkroad Origin Mobile instalado no emulador, com a conta já logada uma vez.

## 2. Preparar o emulador (uma vez)

Os nomes dos menus podem mudar um pouco de uma versão para outra.

**LDPlayer 9**
1. Configurações, Outras configurações:
   - **Permissão ROOT**: ligada;
   - **Depuração ADB**: "Abrir conexão local".
2. Reinicie o emulador.

**MuMu Player**
1. Configurações da instância, aba de opções avançadas/outras:
   - **Root**: ligado;
   - **ADB**: ligado (no MuMu costuma vir ligado).
2. Reinicie a instância.

Depois, nos dois:
1. Instale o Silkroad Origin Mobile pela Play Store do emulador.
2. Abra o jogo e faça o login da conta à mão uma vez (Google ou ID). O bot não faz
   esse login da conta; ele só entra no servidor e no personagem depois disso.
3. Feche o jogo.

## 3. Abrir o bot

1. Rode o `SRO-Bot-0.1.0-portable.exe`. Não precisa instalar.
2. O Windows pode mostrar "O Windows protegeu o computador" (o programa não tem
   assinatura digital). Clique em **Mais informações** e depois em **Executar assim mesmo**.

## 4. Configurar (uma vez)

1. No bot, aba **Ferramentas**, painel **Configuração**:
   - **Emulador**: LDPlayer 9 ou MuMu Player;
   - **Pasta**: onde o emulador está instalado. Padrões:
     - LDPlayer: `C:\LDPlayer\LDPlayer9`;
     - MuMu: `C:\Program Files\Netease\MuMuPlayer`;
   - **Instância**: 0 é a primeira do emulador;
   - **adb**: deixe vazio (usa o do próprio emulador).
2. Clique em **Salvar** e depois em **Testar conexão**. Os 5 itens precisam
   aparecer como `[ok]`: emulador, adb, instância online, root e jogo instalado.
   Se algo der `[falha]`, a linha diz o que fazer.

## 5. Usar

1. Marque **Auto-login** no topo.
2. Clique em **Abrir jogo** e depois em **Iniciar bot**. O bot prepara o jogo, abre
   e entra no personagem sozinho. Na primeira vez escolha o servidor e o
   personagem à mão; ele lembra nas próximas. Esse é o **personagem principal**:
   é nele que rodam o Firm e o Treino.
   - Numa instalação nova o jogo baixa uma atualização grande (uns 500 MB, mais
     de 10 minutos). O bot confirma e mostra o progresso no log; é só esperar.
   - Se o log disser **"a conta não está logada neste emulador"**, abra a janela
     do emulador e faça o login da conta (Google, ID ou Convidado). O bot
     continua sozinho depois.
   - Para o bot logar a conta sozinho quando ela deslogar: aba **Ferramentas**,
     painel **Conta do jogo**, preencha o **ID** (o e-mail da Gamo) e a **senha** e
     clique em **Salvar**. A senha fica criptografada pelo Windows e não aparece
     mais. Só vale para conta com "Login with ID" (não Google nem Convidado).
     Se o jogo disser que a senha está errada, o bot para na hora (para não
     bloquear a conta) e avisa no log.
3. Na aba **Atividades**, marque o **Ativa** do que quiser e ajuste o painel:
   - **Demon Locking Tower**: sobe a torre e faz o sweep;
   - **Continental Exploration**: rola o dado mirando em baú, dado extra e fim,
     e cuida dos baús. No campo **Personagens** dá para pôr vários personagens
     da conta (separados por vírgula), porque os dados são por personagem.
     Personagem de outro servidor vai como `Nome@Servidor` (ex.:
     `Fulano@Lunar, Ciclano@Lunar`). No fim do ciclo o bot volta pro
     personagem principal;
   - **Firm**: tarefa diária da guilda (precisa de guilda). Só entrega item
     comum por padrão; Tablets e Elements ficam protegidos (dá para liberar um
     item pelo ID no painel). Com 3 ou mais entregas, conclui o dia (o "Submit"
     da janela), que dá o prêmio total com bastante EXP;
   - **Missão principal**: aceita a main quest, vai até o NPC pelo próprio
     jogo, caça os monstros do objetivo, entrega e segue pra próxima. Roda a
     cada Iniciar bot, antes do Treino, até a linha acabar ou a próxima pedir
     nível maior (no máximo 1 h por vez). Objetivos de usar item, escolta ou
     fase ficam pra fazer na mão: o log avisa qual. Ainda sem prova ao vivo de
     aceitar e entregar uma main quest;
   - **Guild utilities**: sign-in da guilda (Normal ou Luxury, em gold), baús do
     sign-in e salário. Nunca o sign-in de Silk;
   - **Baús de atividade diária**: pega os baús de 30 a 150 pontos assim que
     liberam;
   - **Grátis do dia**: pega o que o jogo dá de graça: pacotes grátis do Event
     (Premium Shop, só preço 0), o attendance do Welfare e os prêmios de 7, 14,
     21 e 28 dias, a caixinha grátis do Daily Pack, os baús do sign-in da guilda
     quando o progresso sobe e os red envelopes do Lucky Money da guilda (das
     09:00 às 11:15 de Brasília). Confere o Diamond e o Silk depois de cada
     pedido e para se algum mudar;
   - **Qigong**: pede e aceita Qigong com membros da guilda a 10 níveis ou mais
     de diferença (2 vezes como mestre e 2 como aluno por dia). Quem recusa 2
     vezes no dia só recebe pedido de novo no dia seguinte;
   - **Treino**: caça com o auto-play do jogo. Leve o personagem até um lugar
     com monstros do nível dele (fora da cidade) e clique em **Salvar ponto
     atual**. Logo depois de entrar no jogo, espere alguns segundos antes de
     salvar. Se a área for fraca demais ou não tiver monstro, o log avisa.
     Opções do painel do Treino:
     - **Ponto de reserva**: salve um segundo ponto. O bot troca para ele se o HP
       cair abaixo do limite no ponto (proteção de HP) ou se ficar preso sem
       ganhar EXP;
     - **Ao parar, ir pra cidade**: salve a cidade (ponto atual) e o bot vai até
       lá antes de parar ou de rodar outra atividade;
     - **Sem time, entrar num time aberto**: o bot entra sozinho no time com mais
       gente (bônus de 5% com 2 membros até 25% com 6). Se ficar sozinho num
       time, ele sai e procura outro. Vem ligado;
     - **Itens de buff**: caçando no ponto, o bot ativa da mochila, um de cada
       vez e quando o anterior acaba: **Exp Booster** (200% de 1 h primeiro),
       **pergaminho de dano 20%** (30 min) e **VIP Scroll +40 STR/INT** (1 h).
       Cada um tem seu próprio checkbox. Gastam itens; deixe desligado o que
       quiser guardar.
     - **Skills no level-up**: ao subir de nível, o bot sobe as maestrias que
       você já usa até o nível do personagem e as skills que elas liberam
       (gasta SP; não aprende skill nova nem mexe em maestria zerada).
     - **Berserk** e **Devil** automáticos em combate (não gastam item);
     - **Vender o lixo**: com menos de 15 espaços livres, vende equipamento de pet
       comum e restos de monstro. Nada mais;
     - **Training time x10**: caçando no ponto, o bot abre sozinho o tempo de x10
       guardado (30 min por vez). Sem x10, ele fica no ponto de reserva, que é
       mais seguro.
     Depois de cada atividade (Tower, Continental, Firm, Guild) o log mostra
     quanto EXP ela rendeu (linha "[exp]"), e o Histórico guarda isso.
     O bot cuida sozinho do resto: liga a caça de novo se o EXP parar, desliga e
     religa se travar, prende o auto-play na área do ponto (sem isso ele voltava
     para onde o personagem reviveu) e avisa quando faltar poção.
4. Clique em **Iniciar bot**.
5. Para encerrar, clique em **Parar bot** e depois em **Fechar jogo**. O "Fechar
   jogo" devolve o jogo exatamente como estava antes do bot.

## 6. O que o bot nunca faz

- Não gasta Silk nem compra nada pago (Special Chest, "Open now", reviver
  pago, conclusão instantânea, troca de tarefa paga).
- Não clica na tela: tudo é chamada direta ao jogo. A única exceção é a tela de
  login da conta (ela é do Android, fora do jogo), e só se você salvar o ID e a
  senha em Ferramentas.
- Não vende item seu além do lixo (equipamento de pet comum e restos de monstro,
  só com "Vender o lixo" ligado). No Continental, com os espaços de baú cheios,
  pode descartar baú de cor que você marcou para ignorar.
- Não pega pacote pago: nos pacotes do Premium Shop só os de preço 0, e nunca os
  pacotes em dinheiro do Daily Pack.

Viagem entre cidades e compra de poção usam **gold**.

## 7. Problemas comuns

- **"Testar conexão" diz que a instância não responde:** abra a instância no
  emulador e confira se o ADB está ligado.
- **Sem root:** ligue o root nas configurações do emulador e reinicie a instância.
- **O jogo pediu atualização:** o bot confirma e espera o download sozinho.
- **"Need to download package" ao entrar com um personagem:** numa instalação
  nova o jogo baixa o pacote de cada mapa na primeira vez que um personagem
  entra nele (até uns 750 MB). O bot confirma e espera; nas próximas vezes não
  pede mais.
- **Usa outro bot?** Não rode os dois ao mesmo tempo na mesma
  instância. O SRO Bot devolve o jogo como estava ao clicar em "Fechar jogo".
- **MuMu:** o suporte é novo. Se o jogo abrir mas as atividades não andarem,
  abra uma issue no repositório do projeto.
- **"Connection failed" toda hora, com a internet de casa boa:** a rota até os
  servidores da Ásia oscila. O bot reconecta sozinho, mas cada queda custa
  1 a 2 min. Em Ferramentas, "Rota do jogo (VPN gratuita)":
  1. instale o WireGuard (https://www.wireguard.com/install, gratuito);
  2. clique em "Ligar VPN" e aceite o pedido de administrador do Windows;
  3. use "Medir ping" e acompanhe "Quedas de conexão" para comparar.
  Só o tráfego do jogo passa pela VPN (Cloudflare WARP, gratuita). Se trocar de
  servidor e aparecer o aviso de IP fora do túnel, clique em "Atualizar IPs".
  "Desligar VPN" volta tudo para a rota direta.

- **Selo "mochila" vermelho no topo:** a mochila está enchendo (menos de 10
  espaços) ou cheia (menos de 3). Com ela cheia o jogo não compra poção e o
  personagem para na zona segura. Libere espaço; o selo some sozinho. O campo
  "Mochila (livres)" no painel do personagem mostra quantos espaços sobram.
- **"sem poção de HP/MP nos espaços do auto-play":** compre poção ou libere a
  mochila para o AutoBuy do jogo repor.
- **O personagem ficou fora de mundo numa viagem entre mapas:** às vezes o jogo
  trava no voo do teleporte. Depois de duas tentativas de login sem sucesso
  (uns 8 minutos), o bot reinicia o jogo sozinho.

## 8. Onde ficam os dados

Em `%APPDATA%\sro-bot-app`:
- `settings.json`: a configuração;
- `login-profile.json`: servidor e personagem lembrados;
- `game-backup\`: a cópia do arquivo original do jogo, para o "Fechar jogo"
  devolver;
- `vpn\`: a conta gratuita do WARP e a configuração do túnel (não compartilhe
  esses arquivos);
- `login-cred.bin`: o ID e a senha da conta, criptografados pelo Windows (só
  abrem neste usuário do Windows; não compartilhe);
- `booster.json`: até quando vale o Exp Booster ativado pelo bot;
- `qigong-asks.json`: a quem o bot já pediu Qigong hoje;
- `ai.json` e `ai-key.bin`: a configuração da IA opcional e a chave dela,
  criptografada (não compartilhe);
- `history.sqlite`: o histórico de EXP por área e os eventos (aba IA).

Apagar essa pasta faz o bot começar do zero. Faça isso só com o jogo fechado pelo bot.
