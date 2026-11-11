# sro-bot

[![CI](https://github.com/joaodematejr/sro-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/joaodematejr/sro-bot/actions/workflows/ci.yml)

Bot de código aberto para o **Silkroad Origin Mobile** rodando em emulador
Android no Windows (LDPlayer ou MuMu Player). Um app desktop em Electron
controla o jogo por um engine nativo que roda dentro do processo do jogo e
chama os métodos do próprio cliente. Não há toque simulado na tela nem
reconhecimento de imagem.

> **Aviso.** Projeto independente, sem relação com a desenvolvedora ou a
> publicadora do jogo. Automatizar e injetar código no cliente viola os termos
> de uso do jogo e pode levar ao banimento da conta. Use por sua conta e risco.

## O que faz

- **Treino**: configura o auto-play do próprio jogo (cura, poção, coleta,
  reviver na cidade, voltar ao ponto), vigia a caça e mantém o char no ponto
  salvo. Vários pontos com raio e canal, troca de ponto por mortes, poucos
  monstros ou HP baixo, ponto de reserva quando falta o training time x10,
  troca de canal quando outro jogador caça perto, time automático pelo bônus de
  EXP, Exp Booster e buffs, Berserk e devil, subida de maestrias e skills no
  level-up, venda do lixo com a mochila cheia, parada por nível, gold ou mortes.
- **Diárias**: Demon Locking Tower, Continental Exploration, Firm (tarefa diária
  da guilda, com entrega e prêmio total), Guild utilities (sign-in, baús e
  salário), baús de atividade diária, Qigong entre membros da guilda.
- **Grátis do dia**: pacotes de preço zero do Event, attendance do Welfare,
  caixinha do Daily Pack, baús do sign-in da guilda, red envelopes da guilda e,
  opcional, doação no Support da guilda. Nada pago, nunca.
- **Sessão**: auto-login (inclusive na tela nativa do SDK, com a senha guardada
  criptografada pelo Windows), reconexão, vigia de jogo congelado, atualização
  do jogo, VPN opcional (WireGuard + WARP) para rotas ruins.
- **Painel**: estado ao vivo, estatísticas, histórico em SQLite com EXP/h por
  área e um assistente de IA opcional (Ollama, Gemini, OpenRouter, Groq ou
  Mistral) que lê o estado real do bot.

O passo a passo de uso para quem só quer rodar o EXE está em
[app/GUIA-TESTE.md](app/GUIA-TESTE.md).

## Como funciona

```
 Windows                                   Emulador Android (arm64 sob tradução)
 +---------------------------+   adb       +--------------------------------+
 | app/ (Electron)           |  forward    |  jogo (Unity IL2CPP+HybridCLR) |
 |  main: adb, injeção,      | 27105 <---> |   libmain.so = loader          |
 |        atividades, IPC    |   TCP       |   libsroengine.so = engine     |
 |  renderer: painel         |  tag+JSON   |     lê estado, chama métodos   |
 |  controller: lógica pura  |             |     na thread principal        |
 +---------------------------+             +--------------------------------+
```

1. "Abrir jogo" guarda o `libmain.so` do aparelho, põe um loader no lugar e
   sobe o engine junto do jogo. "Fechar jogo" devolve exatamente o que estava.
2. O engine resolve classes e métodos pela API C do IL2CPP e atende comandos
   por TCP: ler um campo seguindo um caminho (`GETP`), chamar um método na
   thread principal (`SKIL`), listar enums, objetos e dicionários.
3. O app decide o que fazer com lógica pura e testável (`app/src/controller`) e
   manda os comandos. Toda ação no jogo é uma chamada de método do cliente.

Detalhes em [docs/ARQUITETURA.md](docs/ARQUITETURA.md) e
[docs/PROTOCOLO.md](docs/PROTOCOLO.md). O mapa de classes, campos e métodos do
jogo levantado até aqui está em [engine/DISCOVERY.md](engine/DISCOVERY.md).

## Requisitos

- Windows 10 ou 11.
- LDPlayer 9 (ou MuMu Player 12) com root ligado e o jogo instalado.
- Node.js 20 ou mais novo, para compilar o app.
- Android NDK r27c (vem com o Unity), só para recompilar o engine.

## Baixar pronto

Cada [Release](https://github.com/joaodematejr/sro-bot/releases) traz, com o
engine dentro:

- **`SRO-Bot-Setup-X.Y.Z.exe`** (recomendado): instala para o seu usuário do
  Windows e **se atualiza sozinho**. O app confere os Releases ao abrir e a cada
  2 h, baixa a versão nova em segundo plano e mostra o botão "Atualizar para
  vX.Y.Z" no topo; a troca só acontece quando você clica (o jogo continua aberto).
  Sem assinatura digital, o Windows avisa na primeira instalação ("Mais
  informações" > "Executar assim mesmo").
- **`SRO-Bot-X.Y.Z-portable.exe`**: roda sem instalar, mas não se atualiza.
- **`LEIA-ME.md`**: o guia de uso.

As configurações ficam em `%APPDATA%/sro-bot-app/` e valem para as duas formas.
O engine compilado de cada commit também fica como artefato
`engine-build` nas execuções do [CI](https://github.com/joaodematejr/sro-bot/actions/workflows/ci.yml).

## Compilar e rodar

Primeiro o engine (a pasta `engine/build/` não vai no repositório; o app e o EXE
pegam o engine dali). Funciona no Git Bash do Windows, no Linux e no macOS:

```
NDK_HOME="/caminho/do/NDK" bash engine/build.sh
# saída: engine/build/libsroengine.so e engine/build/libsroloader.so
```

Depois o app:

```
cd app
npm install
npm start          # compila e abre o app
npm test           # testes da lógica (node:test)
npm run typecheck  # tsc --noEmit
npm run dist:win   # EXE portátil em app/release/, com o engine embutido
```

Veja [engine/README.md](engine/README.md) para injeção e restauração manuais.

## Estrutura

```
app/
  src/main/         processo principal: adb, injeção, auto-login, atividades
  src/renderer/     painel (HTML + TypeScript + Tailwind)
  src/controller/   lógica pura de cada atividade, com testes em __tests__/
  GUIA-TESTE.md     guia de uso que acompanha o EXE
engine/
  src/              engine nativo (C++), loader e protocolo
  DISCOVERY.md      mapa do cliente do jogo
docs/               arquitetura e protocolo
.claude/skills/     instruções de projeto para o Claude Code
```

## O que o bot nunca faz

- Gastar Silk, Diamond ou qualquer moeda paga, ou comprar pacote em dinheiro.
- Tocar na tela por posição. Toda ação é por método do cliente (a única
  exceção é digitar no login nativo do SDK).
- Extrair chave, decifrar pacote protegido ou contornar proteção. Só lê o que o
  jogo já colocou descriptografado na memória (ver
  [.claude/skills/re-safe](.claude/skills/re-safe/SKILL.md)).
- Desligar a caça com o char em combate ou com monstro perto.
- Mandar login, senha ou token para a IA, para log ou para a tela.

## Contribuir

Veja [CONTRIBUTING.md](CONTRIBUTING.md). As mudanças de cada versão estão no
[CHANGELOG.md](CHANGELOG.md).

## Licença

[MIT](LICENSE).
