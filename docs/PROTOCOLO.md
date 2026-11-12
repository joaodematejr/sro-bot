# Protocolo do engine

O engine escuta na porta 27100 do aparelho. O app abre um `adb forward` da porta
27105 do PC para ela.

## Quadro

Cabeçalho de 16 bytes, little endian, e depois o corpo em UTF-8:

| Offset | Tamanho | Campo |
|---|---|---|
| 0 | 4 | tag ASCII (`CONN`, `GETP`, `SKIL`, ...), completada com `\0` |
| 4 | 4 | reservado (0) |
| 8 | 4 | reservado (0) |
| 12 | 4 | tamanho do corpo em bytes |

A resposta vem com a tag `RESP` e um JSON. Com a conexão aberta, o engine
também manda, a cada ~1 s, um `RESP` com o estado do jogador
(`{"player":{...}}`). Quem espera a resposta de um comando deve ignorar esses
quadros.

## Comandos

| Tag | Corpo | O que faz |
|---|---|---|
| `CONN` | vazio | Estado do jogador: `ok` (em mundo), `name`, `level`, `exp`, `hp`, `maxHp`, `mp`, `dead`, `inCombat`, `autoPlayOn`, `corrected` (x, altura, z). |
| `GETP` | caminho | Lê um valor seguindo o caminho. Devolve `int`, `bool`, `str` ou `float`. |
| `OBJV` | caminho | Despeja os campos do objeto no fim do caminho. |
| `KEYS` | caminho | Chaves de um `Dictionary`. |
| `ENUM` | classe | Nomes e valores de um enum. |
| `FIND` | texto | Classes cujo nome contém o texto, com métodos, tipos dos parâmetros e se têm singleton (grava em `files/sro_find.txt` no aparelho). |
| `SKIL` | ação | Liga ou desliga a caça (`{"on":1}` ou `{"on":0}`), ou chama um método (abaixo). |
| `MOVE` | `x y z` | Anda até o ponto (mesma cena). |
| `ENTS` | raio em m (padrão 120) | Tudo o que o mapa precisa numa consulta: `me` (x, z, id e `target`, o alvo do auto-play), `ents` = `[tipo, id, x, z, nível, morto, hp, maxHp, "nome"]` (até 150, nome em UTF-8) e `drops` = `[x, z, item, qtd]` (itens no chão, até 80). Ids são os 32 bits de baixo. Engine antigo responde o estado do jogador (tag desconhecida). |

## Caminho do `GETP`

Palavras separadas por espaço, a partir de uma classe:

```
XBagDocument GetItemCount:351002102,0
XEntityMgr GetAll get_Item:0 get_Attributes get_Level
ChannelDocument _listLine get_Item:2 _state+4
XStringTable GetString:"ERR_ROLE_IN_COMBAT_STATUS"
```

- Primeiro a classe. O engine acha o singleton ou o documento do jogo com esse
  nome.
- Cada passo pode ser um campo, um getter sem argumento ou um método com
  argumentos inteiros (`Metodo:1,0`) ou com um texto (`Metodo:"chave"`). Com
  texto, o engine escolhe a versão do método cujo parâmetro é `string`.
- **Métodos da Unity** (`Find`, `GetComponent`, `gameObject` e outros, de
  `Transform`, `GameObject` ou `Component`) não podem rodar no `GETP` nem no
  `callx`: os dois resolvem o caminho na thread do socket, e isso já deixou o
  engine preso até reiniciar o jogo. Para chegar num objeto de tela, use o
  `callxm`.
- `campo+N` lê N bytes depois do campo, por exemplo o valor de um `Nullable<T>`
  ou o z de um `Vector3`.
- `[#n]` lê o elemento n de um array de int. `[#n:w:k]` lê o int k do elemento
  n num array de struct com w ints por elemento.
- **Arrays C# (`T[]`):** use só `get_Length`, `GetValue:i` ou `[#n]`. Chamar
  `Get:` ou `get_Item:` num array travou o jogo nos testes.
- `get_Item:i` serve para `List<T>`. Índice fora da lista devolve erro sem
  chamar o jogo.
- O `GETP` lê só os 32 bits de baixo de um `ulong`. Para o id inteiro, use o
  `OBJV`.

## Chamadas pelo `SKIL`

Rodam na thread principal do jogo, no próximo frame:

| Forma | Uso |
|---|---|
| `calls Classe Metodo 0` | método sem argumento no singleton |
| `callsn Classe Metodo N` | método no singleton com N argumentos de referência nulos (handlers de UI `On...(XUIEvent)`) |
| `callsi Classe Metodo argc a b c` | até 3 argumentos int, casando a quantidade exata de parâmetros |
| `callp Classe campo... Metodo 0` | método num objeto achado por caminho |
| `callpi Classe campo... Metodo argc a b` | idem, com argumentos int |
| `callv3 Classe Metodo 3 x y z cena 0` | método que recebe `Vector3` (navegar até um ponto em outro mapa) |
| `callx Classe [campo...] Metodo argc -- args` | argumentos tipados (abaixo) |
| `callxm Classe [campo...] Metodo argc -- args` | igual ao `callx`, mas os caminhos (do objeto e dos `o:`) são resolvidos na thread principal, onde métodos da Unity podem rodar. A resposta só confirma a fila; erro de caminho vai para o logcat (`SROENGINE`), e quem chama confere o efeito no estado do jogo |
| `getv Classe getter` | lê o retorno de um getter (leitura, não ação) |

Tipos dos argumentos do `callx`:

| Prefixo | Tipo |
|---|---|
| `i:` | int32 |
| `u:` | uint32 |
| `q:` | uint64 (ids de char, de item) |
| `b:` | bool (0 ou 1) |
| `s:` | texto sem espaço (`s:` sozinho é texto vazio) |
| `o:` | objeto por caminho, com `\|` no lugar do espaço (`o:XBagDocument\|ItemBag\|Items\|get_Item:5`; no `callxm`, também `o:...\|m_AfterBuy\|Find:"Chest"\|GetComponent:"XUISprite"`) |
| `n:` | nulo |

## Cuidados

- Um caminho novo se testa um por vez: uma chamada errada no jogo pode
  travá-lo.
- O servidor recusa algumas ações em "combat mode"
  (`ERR_ROLE_IN_COMBAT_STATUS`), até 6 s depois do último golpe, dano ou skill
  (`XLevelStatistics get_IsInFightingState`).
- Texto do jogo: `Localization Localize:"<chave>"` ou
  `XStringTable GetString:"<chave>"`.
