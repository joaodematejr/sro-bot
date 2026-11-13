// Engine PoC: roda DENTRO do processo do jogo (injetado como .so arm64).
//
// O que ele prova:
//   1. bootstrap do IL2CPP in-process (dlsym nos simbolos il2cpp_*),
//      que e o que falha via Frida sob Houdini mas funciona aqui porque
//      roda no mesmo contexto traduzido do jogo;
//   2. introspecao por nome (enumera assemblies e classes);
//   3. o canal com o controlador (escuta TCP e fala o protocolo tag+JSON).
//
// Read-only: NAO chama metodos de gameplay e NAO decifra nada. O jogo ja
// carregou e decifrou os assemblios; aqui so lemos o que ja esta na memoria.

#include <cerrno>
#include <android/log.h>
#include <arpa/inet.h>
#include <dirent.h>
#include <dlfcn.h>
#include <netinet/in.h>
#include <sys/mman.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>

#include <ctime>

#include <csetjmp>
#include <csignal>
#include <cstdlib>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "il2cpp_api.h"
#include "protocol.h"

#define LOG(...) __android_log_print(ANDROID_LOG_INFO, "SROENGINE", __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, "SROENGINE", __VA_ARGS__)

namespace {

constexpr int kPort = 27100;
std::atomic<bool> g_started{false};

// Estado compartilhado para leitura sob demanda pelo socket.
Il2CppApi g_api{};
const void* g_xmain = nullptr;
std::atomic<bool> g_ready{false};
// API do il2cpp pronta com so os assemblies AOT (Core, Assembly-CSharp): libera
// os comandos genericos (FIND/OBJV/GETP/ENUM/KEYS/SKIL) antes do XMainClient.
// A tela de atualizacao do jogo (hot update) aparece antes dele carregar.
std::atomic<bool> g_boot_ready{false};

// Fila de acoes executadas na thread principal do jogo (via hook de Update).
struct Action {
    int type;   // 1 = move, 2 = auto-toggle
    float x, y, z;
    int skill;  // legado (move usa so x,y,z)
    int method; // type==2: 0=SetAutoEnable 1=set_AutoPlayOn 2=SendAutoFightMsg 3=SendEnterFightEvent 4=START 5=STOP 6=call 7=calls 8=callsn 9=callsi 10=callp 11=callpi 12=callv3 13=callx
    int a1, a2; // args bool do metodo de auto (int32 no callsi)
    int a3;     // method 9: terceiro int32 (bool no fim, ex.: XOptionsDocument.SetValue)
    int argc;        // method 6/7: numero de args bool (0..2)
    char name[48];   // method 6/7: nome do metodo
    char cls[48];    // method 7: nome da classe do singleton
    void* obj;       // method 10/11/13: objeto ja resolvido pelo caminho (thread do socket)
    const void* mi;  // method 10/11/13: MethodInfo ja resolvido em obj
    // method 13 (callx): args tipados. kind: i int32, u uint32, q uint64, b bool,
    // n nulo, s texto (criado na thread principal), o objeto achado por caminho.
    char xkind[8];
    uint64_t xval[8];
    void* xobj[8];
    char xstr[8][32];
    // method 14 (callxm): como o 13, mas os caminhos (do objeto e dos args 'o')
    // ficam em texto e sao resolvidos na thread principal, onde metodo da Unity
    // (Transform.Find, GetComponent) pode rodar.
    char xm_path[192];
    char xm_opath[8][160];
    // method 15 (CHAT): texto do chat em UTF-8 (a1 = canal) e o destino do privado.
    char say[1024];
    uint64_t say_to;
};
std::mutex g_queue_mu;
std::vector<Action> g_queue;
std::atomic<bool> g_has_actions{false};  // fast-path: evita lock todo frame
// Serializa as leituras de memoria do lado do socket (FaultGuard instala
// handler de sinal global; duas threads de conexao ao mesmo tempo o
// embaralhariam). So vale para o lado do socket; o exec na thread principal
// nao usa FaultGuard.
std::mutex g_read_mu;
// XEntity.Update(float dt, bool) e chamado todo frame por entidade (parado ou
// nao), diferente de MoveLateUpdate que so roda em movimento.
// Core.UnityMainThreadDispatcher.Update() (0 params) e chamado pela Unity
// NATIVA todo frame via methodPointer -> hook por troca de methodPointer pega.
using FnUpd = void (*)(void*, const void*);
FnUpd g_orig_update = nullptr;
std::atomic<bool> g_hook_installed{false};
// Segundo ponto de drain: UnityMainThreadDispatcher.Update() so ticka EM MUNDO,
// entao antes de logar nenhuma acao (callsn/calls) roda. UIRoot.Update() (NGUI)
// e metodo magico da Unity (chamado via methodPointer, logo o hook pega) e ticka
// em TODA cena com UI ativa: login, selecao de char e mundo. Com ele a fila
// drena tambem no pre-mundo (login por metodo). XLoginView.OnUpdate NAO serve:
// e chamada managed direta, nao passa pelo methodPointer.
FnUpd g_orig_login_update = nullptr;

// Hook do evento de morte: XNetComponent.OnDeathNotify(KKSG.DeathInfo).
using FnDeath = void (*)(void*, void*, const void*);
FnDeath g_orig_death = nullptr;
std::atomic<int> g_death_events{0};
// Mortes cujo Killer e o jogador local (abates do char, contados no hook).
std::atomic<int> g_kills{0};
// Relogio do jogo (Time.realtimeSinceStartup) lido na thread principal ~1x/s e o
// CLOCK_MONOTONIC (ms) da leitura: o BUFS conta o tempo restante dos buffs nele.
std::atomic<float> g_rt{-1.0f};
std::atomic<long long> g_rt_ms{0};

struct Introspection {
    bool ok = false;
    size_t assemblies = 0;
    std::vector<std::string> sample_classes;
    std::string player = "{\"ok\":false}";
};

void* lib_loaded(const char* name) {
    return dlopen(name, RTLD_NOW | RTLD_NOLOAD);
}

// Espera o runtime ficar PRONTO, nao so o libil2cpp aparecer. Chamar
// il2cpp_domain_get durante a inicializacao do runtime causa SIGSEGV e
// derruba o jogo. Criterio: libil2cpp e libunity carregados, depois uma
// folga fixa para a init terminar. O certo em producao e hookar il2cpp_init;
// aqui a folga basta para provar o conceito sem derrubar o processo.
void sleep_full(int secs);

// Le o /proc/self/maps em vez de perguntar ao linker: o dlopen(NOLOAD) a cada
// segundo, em paralelo com o jogo carregando as libs, derrubava o processo
// dentro do linker do Houdini (SIGSEGV na thread do engine 1 a 14 s apos subir).
bool lib_mapped(const char* name) {
    FILE* f = std::fopen("/proc/self/maps", "r");
    if (!f) return false;
    char line[512];
    bool hit = false;
    while (!hit && std::fgets(line, sizeof(line), f)) hit = std::strstr(line, name) != nullptr;
    std::fclose(f);
    return hit;
}

// Alguma thread do processo tem este nome? Le o /proc/self/task/*/comm, sem
// chamar nada do jogo.
bool thread_named(const char* name) {
    DIR* d = opendir("/proc/self/task");
    if (!d) return false;
    bool hit = false;
    while (!hit) {
        dirent* e = readdir(d);
        if (!e) break;
        if (e->d_name[0] == '.') continue;
        char path[64];
        std::snprintf(path, sizeof(path), "/proc/self/task/%s/comm", e->d_name);
        FILE* f = std::fopen(path, "r");
        if (!f) continue;
        char comm[32] = {0};
        if (std::fgets(comm, sizeof(comm), f)) hit = std::strncmp(comm, name, std::strlen(name)) == 0;
        std::fclose(f);
    }
    closedir(d);
    return hit;
}

// Fim da init do il2cpp: o Runtime::Init cria a thread "GC Finalizer" no final.
// Com o emulador recem ligado a init leva bem mais que a folga fixa de antes, e
// chamar o il2cpp no meio dela travou o UnityMain num rwlock (tela preta, engine
// parado em "aguardando init assentar"). Sem o sinal em 300 s, segue como antes.
bool wait_il2cpp_init() {
    for (int i = 0; i < 300; i++) {
        if (thread_named("GC Finalizer")) {
            LOG("init do il2cpp concluida (GC Finalizer apos %d s)", i);
            return true;
        }
        sleep_full(1);
    }
    LOGE("GC Finalizer nao apareceu em 300 s; seguindo com a folga fixa");
    return false;
}

void* wait_for_runtime() {
    for (int i = 0; i < 120; i++) {  // ate ~120 s
        if (lib_mapped("libil2cpp.so") && lib_mapped("libunity.so")) {
            // Espera a init do il2cpp terminar antes do nosso dlopen, depois
            // uma folga pro linker.
            wait_il2cpp_init();
            sleep_full(5);
            return lib_loaded("libil2cpp.so");
        }
        sleep_full(1);
    }
    return nullptr;
}

void dump_discovery(Il2CppApi& api, const void** assemblies, size_t count);
void dump_player_chain(Il2CppApi& api, const void* img);
std::string read_live_player(Il2CppApi& api, const void* img);
void install_update_hook();
void install_death_hook();
void serve();
bool contains_ci(const char* hay, const char* needle);
void sleep_full(int secs);
void* find_class_by_name(const char* name);
void* resolve_singleton(void* klass);
void* find_document(void* klass);
bool missing_this(const void* m, void* inst);

Introspection introspect() {
    Introspection r;
    void* h = wait_for_runtime();
    if (!h) {
        LOGE("runtime (libil2cpp/libunity) nao ficou pronto");
        return r;
    }
    LOG("runtime carregado, aguardando init assentar");
    // Folga para a inicializacao do il2cpp terminar. sleep_full: o sleep() puro
    // volta antes com o sinal do runtime e a folga sumia; o domain_get chamado no
    // meio da init derrubou o jogo no boot pelo app (SIGSEGV dentro do il2cpp,
    // tela preta).
    sleep_full(20);

    Il2CppApi api{};
    int missing = il2cpp_api_resolve(h, &api);
    if (missing) {
        LOGE("faltaram %d simbolos essenciais do il2cpp", missing);
        return r;
    }

    // domain_get pode voltar nulo logo depois da init; nulo so retorna e tenta
    // de novo. Chamado DURANTE a init ele derruba (por isso a folga acima).
    void* domain = nullptr;
    for (int i = 0; i < 20 && !domain; i++) {
        domain = api.domain_get();
        if (!domain) sleep(2);
    }
    if (!domain) {
        LOGE("il2cpp_domain_get seguiu nulo");
        return r;
    }
    api.thread_attach(domain);
    g_api = api;
    g_boot_ready = true;
    install_update_hook();  // fila na thread principal ja na tela de atualizacao
    LOG("api pronta (AOT); comandos genericos liberados antes do XMainClient");
    // Socket ja aqui: a espera pelo XMainClient abaixo leva minutos (ou nunca
    // termina se o jogo para na tela de atualizacao).
    std::thread(serve).detach();

    // Espera o XMainClient (gameplay, hot-update) aparecer antes de despejar.
    // Ele carrega depois do hot-update, no titulo.
    size_t count = 0;
    const void** assemblies = nullptr;
    const void* xmain_img = nullptr;
    // Espera o XMainClient sem prazo, checando a cada 5 s. Antes eram 15 min
    // desde o boot, e uma atualizacao do jogo (488 MB, ~10 min baixando) mais o
    // login estourou: o engine desistiu e nunca liberou a leitura do jogador.
    // O socket ja esta de pe (serve acima), entao esperar nao trava nada.
    for (int attempt = 0;; attempt++) {
        assemblies = api.domain_get_assemblies(domain, &count);
        xmain_img = nullptr;
        for (size_t i = 0; i < count; i++) {
            const void* img = api.assembly_get_image(assemblies[i]);
            const char* name = api.image_get_name(img);
            if (name && contains_ci(name, "XMainClient")) xmain_img = img;
        }
        if (attempt % 12 == 0)
            LOG("tentativa %d: %zu assemblies, XMainClient=%s", attempt, count,
                xmain_img ? "sim" : "nao");
        if (xmain_img) break;
        sleep_full(5);
    }
    r.assemblies = count;
    if (xmain_img) {
        dump_player_chain(api, xmain_img);
        // Habilita a leitura sob demanda pelo socket (o jogador so existe em
        // mundo; quem consulta via socket pega o estado atual).
        g_xmain = xmain_img;
        g_ready = true;
        r.player = read_live_player(api, xmain_img);  // log inicial; socket le sob demanda
        LOG("leitura inicial: %s", r.player.c_str());
        install_death_hook();  // XNetComponent so existe com o XMainClient
    }
    r.ok = true;
    LOG("introspecao OK");
    return r;
}

// Dorme os segundos inteiros mesmo com sinais no meio (nanosleep devolve o resto).
void sleep_full(int secs) {
    timespec req{secs, 0}, rem{};
    while (nanosleep(&req, &rem) == -1 && errno == EINTR) req = rem;
}

bool contains_ci(const char* hay, const char* needle) {
    if (!hay) return false;
    std::string h(hay), n(needle);
    for (auto& c : h) c = (char)std::tolower((unsigned char)c);
    for (auto& c : n) c = (char)std::tolower((unsigned char)c);
    return h.find(n) != std::string::npos;
}

bool is_system_assembly(const char* name) {
    static const char* sys[] = {"System", "Unity", "mscorlib", "Mono.", "Newtonsoft",
                                "netstandard", "Microsoft", "Utf8Json", "FMOD",
                                "BehaviorDesigner", "Whinarn", "HybridCLR", "Unity."};
    for (auto s : sys) {
        if (name && std::strncmp(name, s, std::strlen(s)) == 0) return true;
    }
    return false;
}

// Descobre em runtime as classes de gameplay (jogador etc.) e seus campos com
// offset, e grava num arquivo que o controlador le. Le a metadata que o jogo
// ja carregou e decifrou na memoria; nao decifra nada em disco.
void dump_discovery(Il2CppApi& api, const void** assemblies, size_t count) {
    static const char* kw[] = {"Player", "LocalPlayer", "MyPlayer", "Role", "Hero",
                               "Avatar", "Self", "MainChar", "MainRole"};
    FILE* f = std::fopen("/data/data/com.silkroad.mb/files/sro_dump.txt", "w");
    if (!f) {
        LOGE("nao abriu o arquivo de dump");
        return;
    }
    // Classe interessa se o NOME casa com entidade de jogo, ou se tem um CAMPO
    // com nome de atributo (posicao, vida). O segundo acha onde posicao/vida
    // moram mesmo quando estao numa classe-base.
    static const char* name_kw[] = {"Player", "Role", "Hero", "Avatar", "Entity",
                                    "Object", "Monster", "Unit", "NPC", "Char",
                                    "Being", "Actor", "Attrib", "Creature"};
    static const char* field_kw[] = {"position", "health", "level", "mana"};
    int candidates = 0;
    bool has_xmain = false;
    for (size_t i = 0; i < count; i++) {
        const void* img = api.assembly_get_image(assemblies[i]);
        const char* an = api.image_get_name(img);
        size_t cc = api.image_get_class_count(img);
        std::fprintf(f, "ASM %s %zu\n", an ? an : "?", cc);
        if (an && contains_ci(an, "XMainClient")) has_xmain = true;
        if (is_system_assembly(an)) continue;
        bool can_fields = api.class_get_fields && api.field_get_name && api.field_get_offset;
        for (size_t j = 0; j < cc; j++) {
            void* klass = const_cast<void*>(api.image_get_class(img, j));
            if (!klass) continue;
            const char* cn = api.class_get_name(klass);
            bool name_match = false;
            for (auto k : name_kw)
                if (contains_ci(cn, k)) { name_match = true; break; }

            // coleta os campos uma vez
            std::vector<std::pair<size_t, std::string>> fields;
            if (can_fields) {
                void* iter = nullptr;
                int fn = 0;
                for (void* fi = api.class_get_fields(klass, &iter); fi && fn < 120;
                     fi = api.class_get_fields(klass, &iter), fn++) {
                    const char* fname = api.field_get_name((void*)fi);
                    fields.emplace_back(api.field_get_offset((void*)fi), fname ? fname : "?");
                }
            }
            bool field_match = false;
            for (auto& fd : fields)
                for (auto k : field_kw)
                    if (contains_ci(fd.second.c_str(), k)) { field_match = true; break; }

            if (!name_match && !field_match) continue;
            const char* ns = api.class_get_namespace ? api.class_get_namespace(klass) : "";
            std::fprintf(f, "CLASS %s %s.%s%s\n", an, ns ? ns : "", cn ? cn : "?",
                         field_match ? " [FIELDHIT]" : "");
            for (auto& fd : fields)
                std::fprintf(f, "  0x%zx %s\n", fd.first, fd.second.c_str());
            if (++candidates > 800) { std::fclose(f); LOG("dump cortado em 800"); return; }
        }
    }
    std::fclose(f);
    LOG("dump escrito: %d classes candidatas, XMainClient=%s", candidates,
        has_xmain ? "sim" : "nao");
}

// Le o valor de um campo estatico com seguranca (buffer folgado) e devolve o
// primeiro ponteiro. Para campos de referencia, isso e a instancia.
void* read_static_ptr(Il2CppApi& api, void* field) {
    if (!api.field_static_get_value) return nullptr;
    unsigned char buf[256];
    std::memset(buf, 0, sizeof(buf));
    api.field_static_get_value(field, buf);
    void* p = nullptr;
    std::memcpy(&p, buf, sizeof(p));
    return p;
}

void dump_class_fields(FILE* f, Il2CppApi& api, void* klass, bool read_statics) {
    if (!api.class_get_fields || !api.field_get_name) return;
    void* iter = nullptr;
    for (void* fi = api.class_get_fields(klass, &iter); fi;
         fi = api.class_get_fields(klass, &iter)) {
        const char* fname = api.field_get_name(fi);
        size_t off = api.field_get_offset ? api.field_get_offset(fi) : 0;
        int flags = api.field_get_flags ? api.field_get_flags(fi) : 0;
        bool is_static = (flags & FIELD_ATTR_STATIC) != 0;
        // So le o valor de estaticos com cara de singleton, para reduzir o
        // risco de tocar um estatico nao inicializado e dar segfault.
        bool singleton_like = fname && (contains_ci(fname, "instance") ||
                                        contains_ci(fname, "singleton") ||
                                        contains_ci(fname, "_inst") ||
                                        contains_ci(fname, "self") ||
                                        contains_ci(fname, "player") ||
                                        contains_ci(fname, "local"));
        if (is_static && read_statics && singleton_like) {
            void* p = read_static_ptr(api, fi);
            std::fprintf(f, "  [S] 0x%zx %s = %p\n", off, fname ? fname : "?", p);
        } else {
            std::fprintf(f, "  %s0x%zx %s\n", is_static ? "[S] " : "", off, fname ? fname : "?");
        }
    }
}

// Percorre a cadeia de classes do XPlayer (XPlayer -> XRole -> ... -> base) e
// varre managers/singletons, para achar onde posicao/vida moram e o ponteiro
// da instancia do jogador local.
void dump_player_chain(Il2CppApi& api, const void* img) {
    FILE* f = std::fopen("/data/data/com.silkroad.mb/files/sro_dump.txt", "w");
    if (!f) {
        LOGE("nao abriu dump");
        return;
    }
    if (!api.class_from_name) {
        std::fprintf(f, "sem il2cpp_class_from_name\n");
        std::fclose(f);
        return;
    }

    void* kp = api.class_from_name(img, "XMainClient", "XPlayer");
    std::fprintf(f, "== CADEIA XPlayer ==\n");
    int depth = 0;
    for (void* k = kp; k && depth < 12; k = api.class_get_parent ? api.class_get_parent(k) : nullptr) {
        const char* cn = api.class_get_name(k);
        const char* ns = api.class_get_namespace ? api.class_get_namespace(k) : "";
        std::fprintf(f, "CLASS %s.%s\n", ns ? ns : "", cn ? cn : "?");
        dump_class_fields(f, api, k, true);
        depth++;
    }

    // Managers e singletons que podem segurar o jogador local.
    std::fprintf(f, "\n== MANAGERS/SINGLETONS ==\n");
    size_t cc = api.image_get_class_count(img);
    int shown = 0;
    for (size_t j = 0; j < cc && shown < 60; j++) {
        void* klass = const_cast<void*>(api.image_get_class(img, j));
        if (!klass) continue;
        const char* cn = api.class_get_name(klass);
        if (!cn) continue;
        bool mgr = (contains_ci(cn, "EntityMgr") || contains_ci(cn, "RoleMgr") ||
                    contains_ci(cn, "PlayerMgr") || contains_ci(cn, "SceneMgr") ||
                    contains_ci(cn, "XEntityManager") || contains_ci(cn, "Singleton"));
        if (!mgr) continue;
        const char* ns = api.class_get_namespace ? api.class_get_namespace(klass) : "";
        std::fprintf(f, "CLASS %s.%s\n", ns ? ns : "", cn);
        dump_class_fields(f, api, klass, true);
        shown++;
    }
    std::fclose(f);
    LOG("dump da cadeia XPlayer + managers escrito");
}

// Leitura de memoria com guard de SIGSEGV, para sondar ponteiros sem derrubar
// o jogo se um endereco for invalido.
static sigjmp_buf g_jmp;
static void fault_handler(int) { siglongjmp(g_jmp, 1); }

struct FaultGuard {
    struct sigaction old_segv, old_bus;
    FaultGuard() {
        struct sigaction sa{};
        sa.sa_handler = fault_handler;
        sigemptyset(&sa.sa_mask);
        sa.sa_flags = 0;
        sigaction(SIGSEGV, &sa, &old_segv);
        sigaction(SIGBUS, &sa, &old_bus);
    }
    ~FaultGuard() {
        sigaction(SIGSEGV, &old_segv, nullptr);
        sigaction(SIGBUS, &old_bus, nullptr);
    }
};

bool safe_read(void* dst, const void* src, size_t n) {
    if (sigsetjmp(g_jmp, 1) == 0) {
        std::memcpy(dst, src, n);
        return true;
    }
    return false;
}

bool plausible(void* p) {
    uintptr_t v = (uintptr_t)p;
    return v > 0x100000 && v < 0x7fffffffffffULL && (v & 7) == 0;
}

// Ponteiro que parece estar no heap gerenciado do il2cpp (observado em
// 0x76xx...). Usado antes de object_get_class, que NAO e protegido pelo guard:
// chamar em ponteiro invalido trava. _basicAttr etc. nao passam aqui (valor
// pequeno), evitando o hang.
bool plausible_obj(void* p) {
    uintptr_t v = (uintptr_t)p;
    return v >= 0x700000000000ULL && v < 0x800000000000ULL && (v & 7) == 0;
}

// Scan bruto: le uma regiao como int32/float e escreve offset+valor, para
// achar HP/MP/etc. casando com a tela, sem seguir ponteiros adivinhados.
void dump_raw(void* base, const char* label, size_t size, FILE* f) {
    std::fprintf(f, "## RAW %s (%p) ##\n", label, base);
    for (size_t off = 0; off < size; off += 4) {
        int iv = 0;
        float fv = 0;
        if (!safe_read(&iv, (char*)base + off, 4)) continue;
        safe_read(&fv, (char*)base + off, 4);
        std::fprintf(f, "  +0x%zx i=%d f=%.2f\n", off, iv, fv);
    }
}

// Offsets observados no dump.
constexpr size_t OFF_ENTITYMGR_PLAYER = 0xf8;   // XEntityMgr.<Player>
constexpr size_t OFF_XENTITY_CORRECTED_POS = 0x204;  // Vector3
constexpr size_t OFF_XENTITY_NEXT_POS = 0x138;       // Vector3
constexpr size_t OFF_XOBJECT_ATTR = 0x18;            // XObject._attr
// Campos em XPlayerAttributes.
constexpr size_t OFF_ATTR_NAME = 0x80;    // Il2CppString
constexpr size_t OFF_ATTR_LEVEL = 0x184;  // int
constexpr size_t OFF_ATTR_EXP = 0x1d0;    // int
constexpr size_t OFF_ATTR_MAXEXP = 0x1d8; // int

// Le uma string Il2CppString (layout: len em +0x10, chars UTF-16 em +0x14).
std::string read_il2cpp_string(void* s) {
    if (!plausible(s)) return "";
    int len = 0;
    if (!safe_read(&len, (char*)s + 0x10, 4) || len <= 0 || len > 512) return "";
    std::string out;
    for (int i = 0; i < len; i++) {
        uint16_t ch = 0;
        if (!safe_read(&ch, (char*)s + 0x14 + i * 2, 2)) break;
        out += (ch < 0x80 && ch >= 0x20) ? (char)ch : '?';
    }
    return out;
}

// Despeja a classe de um objeto com os VALORES de cada campo (int e float),
// percorrendo a cadeia de bases. Requer o FaultGuard ativo no chamador.
void dump_object_values(Il2CppApi& api, void* obj, const char* label, FILE* f) {
    if (!api.object_get_class || !api.class_get_fields || !api.field_get_name) return;
    void* cls = api.object_get_class(obj);
    if (!cls) return;
    const char* cn = api.class_get_name(cls);
    const char* ns = api.class_get_namespace ? api.class_get_namespace(cls) : "";
    std::fprintf(f, "== %s : %s.%s  (%p) ==\n", label, ns ? ns : "", cn ? cn : "?", obj);
    int depth = 0;
    for (void* k = cls; k && depth < 6;
         k = api.class_get_parent ? api.class_get_parent(k) : nullptr, depth++) {
        void* iter = nullptr;
        for (void* fi = api.class_get_fields(k, &iter); fi;
             fi = api.class_get_fields(k, &iter)) {
            int flags = api.field_get_flags ? api.field_get_flags(fi) : 0;
            if (flags & FIELD_ATTR_STATIC) continue;
            const char* fn = api.field_get_name(fi);
            size_t off = api.field_get_offset(fi);
            int iv = 0;
            float fv = 0;
            safe_read(&iv, (char*)obj + off, 4);
            safe_read(&fv, (char*)obj + off, 4);
            std::fprintf(f, "  0x%zx %s  i=%d f=%.2f\n", off, fn ? fn : "?", iv, fv);
        }
    }
}

// Acha um campo de instancia pelo nome subindo a cadeia de bases.
void* find_field_in_chain(void* cls, const char* name) {
    for (int depth = 0; cls && depth < 8;
         cls = g_api.class_get_parent ? g_api.class_get_parent(cls) : nullptr, depth++) {
        void* fi = g_api.class_get_field_from_name(cls, name);
        if (fi) return fi;
    }
    return nullptr;
}

// object_get_class com ponto de retorno proprio: um ponteiro podre volta null
// em vez de pular pro sigsetjmp de um safe_read que ja retornou. Requer
// FaultGuard ativo.
void* safe_class_of(void* obj) {
    void* c = nullptr;
    if (sigsetjmp(g_jmp, 1) == 0) c = g_api.object_get_class(obj);
    return c;
}

bool field_is_string(void* fi) {
    if (!g_api.field_get_type || !g_api.type_get_name) return false;
    char* tn = g_api.type_get_name(g_api.field_get_type(fi));
    bool is = tn && std::strcmp(tn, "System.String") == 0;
    if (tn && g_api.free_mem) g_api.free_mem(tn);
    return is;
}

std::string il2cpp_string_json(void* s, int maxLen = 128);

// {"ok":true,"str":"..."} de um System.String (null vira "null":true), em UTF-8:
// nome e chat com letra fora do ASCII saem inteiros (o chat vai ate 512
// caracteres). Requer FaultGuard ativo.
std::string string_json(void* s) {
    if (!s) return "{\"ok\":true,\"null\":true}";
    return "{\"ok\":true,\"str\":\"" + il2cpp_string_json(s, 512) + "\"}";
}

// Igual ao dump_object_values, mas com o TIPO de cada campo e, quando o valor
// parece ponteiro de heap, a classe do objeto apontado. Requer FaultGuard ativo.
// Devolve quantos campos escreveu.
int dump_object_typed(Il2CppApi& api, void* obj, const char* label, FILE* f) {
    if (!api.object_get_class || !api.class_get_fields || !api.field_get_name) return 0;
    void* cls = api.object_get_class(obj);
    if (!cls) return 0;
    int n = 0;
    const char* cn = api.class_get_name(cls);
    const char* ns = api.class_get_namespace ? api.class_get_namespace(cls) : "";
    std::fprintf(f, "== %s : %s.%s  (%p) ==\n", label, ns ? ns : "", cn ? cn : "?", obj);
    for (int depth = 0; cls && depth < 8;
         cls = api.class_get_parent ? api.class_get_parent(cls) : nullptr, depth++) {
        const char* kn = api.class_get_name(cls);
        std::fprintf(f, "-- %s\n", kn ? kn : "?");
        void* iter = nullptr;
        for (void* fi = api.class_get_fields(cls, &iter); fi;
             fi = api.class_get_fields(cls, &iter)) {
            int flags = api.field_get_flags ? api.field_get_flags(fi) : 0;
            if (flags & FIELD_ATTR_STATIC) continue;
            const char* fn = api.field_get_name(fi);
            size_t off = api.field_get_offset(fi);
            char* tn = (api.field_get_type && api.type_get_name)
                           ? api.type_get_name(api.field_get_type(fi))
                           : nullptr;
            uint64_t raw = 0;
            safe_read(&raw, (char*)obj + off, 8);
            void* p = reinterpret_cast<void*>(raw);
            std::string pointee;
            if (plausible_obj(p)) {
                void* pc = safe_class_of(p);
                if (pc) {
                    const char* pn = api.class_get_name(pc);
                    pointee = pn ? pn : "?";
                }
            }
            std::fprintf(f, "  0x%zx %s : %s  i=%d b=%u p=0x%llx%s%s\n", off, fn ? fn : "?",
                         tn ? tn : "?", (int)(raw & 0xffffffff), (unsigned)(raw & 0xff),
                         (unsigned long long)raw, pointee.empty() ? "" : " -> ",
                         pointee.c_str());
            if (tn && api.free_mem) api.free_mem(tn);
            n++;
        }
    }
    return n;
}

// Scan do objeto do player (XEntity) e de cada componente dele que seja
// ponteiro de heap (um nivel), para achar HP/MP por valor. So usa dump_raw
// (leitura guardada), sem object_get_class em ponteiro duvidoso.
void dump_player_scan(Il2CppApi& api, void* player, void* player_class) {
    FILE* f = std::fopen("/data/data/com.silkroad.mb/files/sro_player.txt", "w");
    if (!f) return;
    dump_raw(player, "XPlayer_self", 0x400, f);
    if (api.class_get_fields && api.field_get_name) {
        int depth = 0, followed = 0;
        for (void* k = player_class; k && depth < 6 && followed < 50;
             k = api.class_get_parent ? api.class_get_parent(k) : nullptr, depth++) {
            void* iter = nullptr;
            for (void* fi = api.class_get_fields(k, &iter); fi && followed < 50;
                 fi = api.class_get_fields(k, &iter)) {
                int flags = api.field_get_flags ? api.field_get_flags(fi) : 0;
                if (flags & FIELD_ATTR_STATIC) continue;
                size_t off = api.field_get_offset(fi);
                void* sub = nullptr;
                if (!safe_read(&sub, (char*)player + off, sizeof(sub))) continue;
                if (!plausible_obj(sub)) continue;
                const char* fn = api.field_get_name(fi);
                char lbl[96];
                std::snprintf(lbl, sizeof(lbl), "%s@0x%zx", fn ? fn : "?", off);
                dump_raw(sub, lbl, 0x200, f);
                followed++;
            }
        }
    }
    std::fclose(f);
    LOG("scan do player despejado");
}

// Despeja XPlayerAttributes, seus sub-objetos de atributo (onde HP/MP moram) e
// o nome. Casar os valores com a tela identifica cada campo.
void dump_attr_values(Il2CppApi& api, void* attr) {
    FILE* f = std::fopen("/data/data/com.silkroad.mb/files/sro_attr.txt", "w");
    if (!f) return;
    dump_object_values(api, attr, "XPlayerAttributes", f);

    // Nome (string).
    void* nameptr = nullptr;
    if (safe_read(&nameptr, (char*)attr + 0x80, sizeof(nameptr))) {
        std::string nm = read_il2cpp_string(nameptr);
        std::fprintf(f, "NAME: %s\n", nm.c_str());
    }

    // Scan bruto do objeto de atributos e de cada campo que SEJA um objeto de
    // heap valido (um nivel), para achar HP/MP por valor. Seguro: object/raw so
    // em ponteiros no range do heap.
    dump_raw(attr, "XPlayerAttributes", 0x400, f);
    if (api.class_get_fields && api.field_get_name && api.object_get_class) {
        void* cls = api.object_get_class(attr);
        int depth = 0;
        for (void* k = cls; k && depth < 4;
             k = api.class_get_parent ? api.class_get_parent(k) : nullptr, depth++) {
            void* iter = nullptr;
            for (void* fi = api.class_get_fields(k, &iter); fi;
                 fi = api.class_get_fields(k, &iter)) {
                int flags = api.field_get_flags ? api.field_get_flags(fi) : 0;
                if (flags & FIELD_ATTR_STATIC) continue;
                size_t off = api.field_get_offset(fi);
                void* sub = nullptr;
                if (!safe_read(&sub, (char*)attr + off, sizeof(sub))) continue;
                if (!plausible_obj(sub)) continue;  // so heap valido
                const char* fn = api.field_get_name(fi);
                char lbl[96];
                std::snprintf(lbl, sizeof(lbl), "%s@0x%zx", fn ? fn : "?", off);
                dump_raw(sub, lbl, 0x120, f);
            }
        }
    }
    std::fclose(f);
    LOG("atributos + nome + scan despejados");
}

// Acha o jogador local e le a posicao. Coleta os ponteiros estaticos da cadeia
// do XEntityMgr (o singleton esta num deles), segue +0xf8 ate o XPlayer e le a
// posicao. Guard de SIGSEGV em volta de toda sondagem.
std::string read_live_player(Il2CppApi& api, const void* img) {
    if (!api.class_from_name) return "{\"ok\":false,\"erro\":\"sem class_from_name\"}";
    void* mgr_class = api.class_from_name(img, "XMainClient", "XEntityMgr");
    if (!mgr_class) return "{\"ok\":false,\"erro\":\"XEntityMgr nao resolvido\"}";

    // Resolve o singleton do XEntityMgr invocando o getter (get_singleton etc.).
    // Isso dispara so o cctor do proprio XEntityMgr (esperado), e nao varre
    // estaticos de outras classes (o que travava com cctor alheio).
    if (!api.class_get_method_from_name || !api.runtime_invoke)
        return "{\"ok\":false,\"erro\":\"sem runtime_invoke\"}";

    void* mgr = nullptr;
    const char* getters[] = {"get_singleton", "get_Instance", "get_Singleton",
                             "get_Inst", "get_instance"};
    for (const char* g : getters) {
        const void* m = api.class_get_method_from_name(mgr_class, g, 0);
        if (!m) continue;
        void* exc = nullptr;
        void* ret = api.runtime_invoke(m, nullptr, nullptr, &exc);
        if (ret && !exc) {
            mgr = ret;
            break;
        }
    }
    if (!plausible(mgr))
        return "{\"ok\":false,\"erro\":\"singleton do XEntityMgr nulo\"}";

    FaultGuard guard;
    void* player = nullptr;
    if (!safe_read(&player, (char*)mgr + OFF_ENTITYMGR_PLAYER, sizeof(player)) ||
        !plausible(player))
        return "{\"ok\":false,\"erro\":\"jogador nulo (nao esta em mundo?)\"}";

    float cp[3] = {0, 0, 0}, np[3] = {0, 0, 0};
    bool okc = safe_read(cp, (char*)player + OFF_XENTITY_CORRECTED_POS, sizeof(cp));
    bool okn = safe_read(np, (char*)player + OFF_XENTITY_NEXT_POS, sizeof(np));
    LOG("player=%p corrected=(%.1f,%.1f,%.1f) next=(%.1f,%.1f,%.1f)", player,
        cp[0], cp[1], cp[2], np[0], np[1], np[2]);

    (void)okn;
    // Atributos diretos (nivel, exp, nome) a partir de XObject._attr.
    void* attr = nullptr;
    int level = 0, exp = 0, maxexp = 0;
    std::string name;
    if (safe_read(&attr, (char*)player + OFF_XOBJECT_ATTR, sizeof(attr)) && plausible_obj(attr)) {
        safe_read(&level, (char*)attr + OFF_ATTR_LEVEL, 4);
        safe_read(&exp, (char*)attr + OFF_ATTR_EXP, 4);
        safe_read(&maxexp, (char*)attr + OFF_ATTR_MAXEXP, 4);
        void* nameptr = nullptr;
        if (safe_read(&nameptr, (char*)attr + OFF_ATTR_NAME, sizeof(nameptr)))
            name = read_il2cpp_string(nameptr);
    }

    // HP/MP via XAttributes.GetAttr(XAttributeDefine) -> double. Enum _Total
    // (valor final da tela): 2011=MaxHP, 2012=CurrentHP, 2015=MaxMP, 2016=CurrentMP.
    int hp = 0, maxHp = 0, mp = 0, maxMp = 0;
    if (plausible_obj(attr) && api.object_get_class && api.runtime_invoke) {
        void* acls = api.object_get_class(attr);
        const void* gm = acls ? api.class_get_method_from_name(acls, "GetAttr", 1) : nullptr;
        if (gm) {
            auto ga = [&](int e, bool ceilMode) -> int {
                int arg = e;
                void* p[1] = {&arg};
                void* exc = nullptr;
                void* r = api.runtime_invoke(gm, attr, p, &exc);
                if (exc || !r) return 0;
                double d = *reinterpret_cast<double*>((char*)r + 0x10);
                return (int)(ceilMode ? std::ceil(d) : llround(d));  // display: max=ceil, cur=round
            };
            maxHp = ga(2011, true);
            hp = ga(2012, false);
            maxMp = ga(2015, true);
            mp = ga(2016, false);
        }
    }

    // Estados: _is_dead (XPlayerAttributes +0x75), _bInCombat (XEntity +0x234).
    unsigned char deadB = 0, combatB = 0;
    if (plausible_obj(attr)) safe_read(&deadB, (char*)attr + 0x75, 1);
    safe_read(&combatB, (char*)player + 0x234, 1);
    bool dead = deadB != 0;
    bool inCombat = combatB != 0;

    // Flags de auto (os certos para combate, ja que inCombat/+0x234 nao vira):
    // XPlayerAttributes.get_AutoPlayOn() e XAIComponent.get_IsFighting(), via
    // getter (0 args). O retorno bool vem boxed, byte em +0x10 (como GetAttr).
    int autoPlay = 0, aiFight = 0;
    if (plausible_obj(attr) && api.object_get_class) {
        void* acls = api.object_get_class(attr);
        const void* m = acls ? api.class_get_method_from_name(acls, "get_AutoPlayOn", 0) : nullptr;
        if (m) {
            void* exc = nullptr;
            void* r = api.runtime_invoke(m, attr, nullptr, &exc);
            if (r && !exc) autoPlay = *((uint8_t*)r + 0x10) ? 1 : 0;
        }
    }
    void* aic = nullptr;
    if (safe_read(&aic, (char*)player + 0xd8, sizeof(aic)) && plausible_obj(aic) &&
        api.object_get_class) {
        void* aicls = api.object_get_class(aic);
        const void* m = aicls ? api.class_get_method_from_name(aicls, "get_IsFighting", 0) : nullptr;
        if (m) {
            void* exc = nullptr;
            void* r = api.runtime_invoke(m, aic, nullptr, &exc);
            if (r && !exc) aiFight = *((uint8_t*)r + 0x10) ? 1 : 0;
        }
    }

    // Escapa o nome para JSON e limita o tamanho.
    std::string esc;
    for (char c : name) {
        if (esc.size() >= 40) break;
        if (c == '"' || c == '\\') esc += '\\';
        esc += c;
    }
    LOG("player=%p name=%s lvl=%d pos=(%.1f,%.1f,%.1f)", player, name.c_str(), level,
        cp[0], cp[1], cp[2]);

    char head[512];
    std::snprintf(head, sizeof(head),
                  "{\"ok\":true,\"player\":\"%p\",\"level\":%d,\"exp\":%d,\"maxExp\":%d,"
                  "\"hp\":%d,\"maxHp\":%d,\"mp\":%d,\"maxMp\":%d,"
                  "\"dead\":%s,\"inCombat\":%s,\"autoPlayOn\":%s,\"aiFighting\":%s,"
                  "\"deathEvents\":%d,\"kills\":%d,"
                  "\"corrected\":[%.2f,%.2f,%.2f],\"okc\":%s,\"name\":\"",
                  player, level, exp, maxexp, hp, maxHp, mp, maxMp,
                  dead ? "true" : "false", inCombat ? "true" : "false",
                  autoPlay ? "true" : "false", aiFight ? "true" : "false",
                  g_death_events.load(std::memory_order_relaxed), g_kills.load(std::memory_order_relaxed),
                  cp[0], cp[1], cp[2], okc ? "true" : "false");
    return std::string(head) + esc + "\"}";
}

// Resolve o ponteiro do jogador local (XEntityMgr.singleton -> +0xf8). Null se
// nao estiver em mundo.
void* current_player(Il2CppApi& api, const void* img) {
    // img nulo: XMainClient ainda nao carregou (tela de atualizacao).
    if (!img || !api.class_from_name || !api.class_get_method_from_name || !api.runtime_invoke)
        return nullptr;
    void* mgr_class = api.class_from_name(img, "XMainClient", "XEntityMgr");
    if (!mgr_class) return nullptr;
    void* mgr = nullptr;
    const char* getters[] = {"get_singleton", "get_Instance", "get_Singleton",
                             "get_Inst", "get_instance"};
    for (const char* g : getters) {
        const void* m = api.class_get_method_from_name(mgr_class, g, 0);
        if (!m) continue;
        void* exc = nullptr;
        void* r = api.runtime_invoke(m, nullptr, nullptr, &exc);
        if (r && !exc) { mgr = r; break; }
    }
    if (!plausible_obj(mgr)) return nullptr;
    FaultGuard guard;
    void* player = nullptr;
    if (!safe_read(&player, (char*)mgr + OFF_ENTITYMGR_PLAYER, sizeof(player)) ||
        !plausible_obj(player))
        return nullptr;
    return player;
}

// Busca recursiva e limitada por um valor int32 no grafo de objetos, seguindo
// ponteiros de heap ate 'depth'. Registra cada hit com o caminho e o offset.
// So usa safe_read (guardado) e aritmetica: seguro.
void search_rec(void* obj, int depth, const std::string& path, int target, FILE* f,
                int& budget) {
    if (depth > 3 || budget <= 0) return;
    budget--;
    const size_t SCAN = 0x400;
    for (size_t off = 0; off < SCAN; off += 4) {
        int v = 0;
        if (safe_read(&v, (char*)obj + off, 4) && v == target)
            std::fprintf(f, "HIT %s +0x%zx\n", path.c_str(), off);
    }
    if (depth >= 3) return;
    for (size_t off = 0; off < SCAN; off += 8) {
        void* p = nullptr;
        if (safe_read(&p, (char*)obj + off, sizeof(p)) && plausible_obj(p)) {
            char seg[32];
            std::snprintf(seg, sizeof(seg), "->0x%zx", off);
            search_rec(p, depth + 1, path + seg, target, f, budget);
        }
    }
}

// Despeja os metodos de uma classe (nome e numero de parametros).
void dump_methods(Il2CppApi& api, void* klass, const char* label, FILE* f) {
    if (!api.class_get_methods || !api.method_get_name) return;
    const char* cn = api.class_get_name(klass);
    std::fprintf(f, "== %s : %s ==\n", label, cn ? cn : "?");
    void* iter = nullptr;
    for (const void* m = api.class_get_methods(klass, &iter); m;
         m = api.class_get_methods(klass, &iter)) {
        const char* mn = api.method_get_name(m);
        uint32_t pc = api.method_get_param_count ? api.method_get_param_count(m) : 0;
        std::fprintf(f, "  %s(", mn ? mn : "?");
        for (uint32_t i = 0; i < pc; i++) {
            if (i) std::fprintf(f, ", ");
            const char* tn = "?";
            if (api.method_get_param && api.type_get_name) {
                const void* t = api.method_get_param(m, i);
                if (t) {
                    char* nm = api.type_get_name(t);
                    if (nm) { std::fprintf(f, "%s", nm); continue; }
                }
            }
            std::fprintf(f, "%s", tn);
        }
        std::fprintf(f, ")\n");
    }
}

// Descobre os metodos do jogador (cadeia de classes) e dos componentes de
// skill, movimento, nav e rede, para achar o que mover e usar skill.
void dump_player_methods(Il2CppApi& api, const void* img) {
    void* player = current_player(api, img);
    if (!player) return;
    FILE* f = std::fopen("/data/data/com.silkroad.mb/files/sro_methods.txt", "w");
    if (!f) return;
    FaultGuard guard;
    if (api.object_get_class) {
        int depth = 0;
        for (void* k = api.object_get_class(player); k && depth < 5;
             k = api.class_get_parent ? api.class_get_parent(k) : nullptr, depth++)
            dump_methods(api, k, "player-chain", f);
    }
    struct Comp { size_t off; const char* name; };
    const Comp comps[] = {{0x58, "_skill"}, {0xb0, "_moveComponent"},
                          {0xa8, "_nav"}, {0x68, "_net"}, {0xd8, "_ai"},
                          {0x18, "_attr(XPlayerAttributes)"}};
    for (const Comp& c : comps) {
        void* sub = nullptr;
        if (safe_read(&sub, (char*)player + c.off, sizeof(sub)) && plausible_obj(sub) &&
            api.object_get_class) {
            void* cls = api.object_get_class(sub);
            if (cls) {
                // despeja a classe e tambem a cadeia de bases dela
                int d = 0;
                for (void* k = cls; k && d < 4;
                     k = api.class_get_parent ? api.class_get_parent(k) : nullptr, d++)
                    dump_methods(api, k, c.name, f);
            }
        }
    }
    std::fclose(f);
    LOG("metodos despejados");
}

// ACAO: mover o jogador invocando XNavigationComponent.Navigate(Vector3).
// Risco: runtime_invoke roda na thread do engine, nao na principal do jogo;
// Navigate so agenda um destino, entao e o caso mais seguro, mas pode travar.
std::string do_move(float x, float y, float z) {
    void* player = current_player(g_api, g_xmain);
    if (!player) return "{\"ok\":false,\"erro\":\"sem player (em mundo?)\"}";
    if (!g_api.object_get_class || !g_api.class_get_method_from_name || !g_api.runtime_invoke)
        return "{\"ok\":false,\"erro\":\"sem invoke\"}";
    float vec[3] = {x, y, z};
    void* params[1] = {vec};  // Vector3 por valor: ponteiro para 3 floats

    // 1) XPlayer.PositionTo(Vector3) no proprio player.
    void* pcls = g_api.object_get_class(player);
    const void* m = pcls ? g_api.class_get_method_from_name(pcls, "PositionTo", 1) : nullptr;
    if (m) {
        void* exc = nullptr;
        g_api.runtime_invoke(m, player, params, &exc);
        LOG("MOVE PositionTo (%.1f,%.1f,%.1f) exc=%s", x, y, z, exc ? "sim" : "nao");
        if (!exc) {
            char buf[160];
            std::snprintf(buf, sizeof(buf),
                          "{\"ok\":true,\"metodo\":\"PositionTo\",\"pos\":[%.1f,%.1f,%.1f]}",
                          x, y, z);
            return buf;
        }
    }

    // 2) fallback: XNavigationComponent.Navigate(Vector3) no _nav (0xa8).
    void* nav = nullptr;
    {
        FaultGuard guard;
        safe_read(&nav, (char*)player + 0xa8, sizeof(nav));
    }
    if (plausible_obj(nav)) {
        void* navcls = g_api.object_get_class(nav);
        const void* mn = navcls ? g_api.class_get_method_from_name(navcls, "Navigate", 1) : nullptr;
        if (mn) {
            void* exc = nullptr;
            g_api.runtime_invoke(mn, nav, params, &exc);
            LOG("MOVE Navigate (%.1f,%.1f,%.1f) exc=%s", x, y, z, exc ? "sim" : "nao");
            char buf[160];
            std::snprintf(buf, sizeof(buf),
                          "{\"ok\":%s,\"metodo\":\"Navigate\",\"pos\":[%.1f,%.1f,%.1f]}",
                          exc ? "false" : "true", x, y, z);
            return buf;
        }
    }
    return "{\"ok\":false,\"erro\":\"nenhum metodo de mover funcionou\"}";
}

// Chama XAttributes.GetAttr(XAttributeDefine) para uma faixa de valores do enum
// e despeja index -> valor, para casar HP/MP com a tela. Tambem lista os nomes
// do enum XAttributeDefine. getter, deve ser seguro fora da thread principal.
std::string do_attr_dump() {
    void* player = current_player(g_api, g_xmain);
    if (!player) return "{\"ok\":false,\"erro\":\"sem player\"}";
    void* attr = nullptr;
    {
        FaultGuard guard;
        safe_read(&attr, (char*)player + 0x18, sizeof(attr));
    }
    if (!plausible_obj(attr) || !g_api.object_get_class || !g_api.class_get_method_from_name ||
        !g_api.runtime_invoke)
        return "{\"ok\":false,\"erro\":\"sem attr/invoke\"}";
    void* acls = g_api.object_get_class(attr);
    const void* m = acls ? g_api.class_get_method_from_name(acls, "GetAttr", 1) : nullptr;
    if (!m) return "{\"ok\":false,\"erro\":\"GetAttr ausente\"}";

    FILE* f = std::fopen("/data/data/com.silkroad.mb/files/sro_attrvals.txt", "w");
    if (!f) return "{\"ok\":false,\"erro\":\"sem arquivo\"}";

    // nomes do enum XAttributeDefine (campos estaticos) + valor do enum
    void* ecls = g_api.class_from_name(g_xmain, "XMainClient", "XAttributeDefine");
    if (ecls && g_api.class_get_fields && g_api.field_get_name) {
        std::fprintf(f, "== XAttributeDefine (nome = valor do enum) ==\n");
        void* iter = nullptr;
        for (void* fi = g_api.class_get_fields(ecls, &iter); fi;
             fi = g_api.class_get_fields(ecls, &iter)) {
            int flags = g_api.field_get_flags ? g_api.field_get_flags(fi) : 0;
            if (!(flags & FIELD_ATTR_STATIC)) continue;  // value__ nao e estatico
            const char* fn = g_api.field_get_name(fi);
            int val = -1;
            if (g_api.field_static_get_value) g_api.field_static_get_value(fi, &val);
            std::fprintf(f, "  %d = %s\n", val, fn ? fn : "?");
        }
    }

    // validacao: get_HPPercent()/get_MPPercent() (0 params, float)
    const char* pcts[] = {"get_HPPercent", "get_MPPercent"};
    for (const char* pn : pcts) {
        const void* pm = g_api.class_get_method_from_name(acls, pn, 0);
        if (!pm) { std::fprintf(f, "%s: ausente\n", pn); continue; }
        void* exc = nullptr;
        void* ret = g_api.runtime_invoke(pm, attr, nullptr, &exc);
        if (exc || !ret) { std::fprintf(f, "%s: exc/null\n", pn); continue; }
        int iv = *reinterpret_cast<int*>((char*)ret + 0x10);
        float fv = *reinterpret_cast<float*>((char*)ret + 0x10);
        std::fprintf(f, "%s = i:%d f:%.4f (ret=%p)\n", pn, iv, fv, ret);
    }

    // bytes crus do retorno de GetAttr(12) (CurrentHP) para inspecao
    {
        int arg = 12;
        void* params[1] = {&arg};
        void* exc = nullptr;
        void* ret = g_api.runtime_invoke(m, attr, params, &exc);
        std::fprintf(f, "GetAttr(12) ret=%p exc=%s bytes:", ret, exc ? "sim" : "nao");
        if (ret)
            for (int k = 0; k < 0x20; k++)
                std::fprintf(f, " %02x", *((unsigned char*)ret + k));
        std::fprintf(f, "\n");
    }

    // forca bruta: GetAttr(0..160) -> valor (int e long)
    std::fprintf(f, "== GetAttr(i) ==\n");
    for (int i = 0; i <= 160; i++) {
        int arg = i;
        void* params[1] = {&arg};
        void* exc = nullptr;
        void* ret = g_api.runtime_invoke(m, attr, params, &exc);
        if (exc || !ret) continue;
        int iv = *reinterpret_cast<int*>((char*)ret + 0x10);
        long lv = *reinterpret_cast<long*>((char*)ret + 0x10);
        float fv = *reinterpret_cast<float*>((char*)ret + 0x10);
        if (iv != 0 || fv != 0.0f)
            std::fprintf(f, "  GetAttr(%d) = i:%d l:%ld f:%.2f\n", i, iv, lv, fv);
    }
    std::fclose(f);
    LOG("attr dump concluido");
    return "{\"ok\":true,\"file\":\"sro_attrvals.txt\"}";
}

// True se a classe deriva de UnityEngine.MonoBehaviour.
bool derives_monobehaviour(Il2CppApi& api, void* klass) {
    for (void* k = klass; k; k = api.class_get_parent ? api.class_get_parent(k) : nullptr) {
        const char* n = api.class_get_name(k);
        if (n && std::strcmp(n, "MonoBehaviour") == 0) return true;
    }
    return false;
}

// Enumera MonoBehaviours com Update()/LateUpdate() (metodos magicos da Unity,
// 0 params) em TODOS os assemblies de jogo (nao-sistema). A Unity NATIVA chama
// esses via methodPointer, entao sao hookaveis. Prioriza nomes de loop.
void dump_monobehaviours(Il2CppApi& api) {
    FILE* f = std::fopen("/data/data/com.silkroad.mb/files/sro_mb.txt", "w");
    if (!f) return;
    void* domain = api.domain_get();
    size_t count = 0;
    const void** asms = api.domain_get_assemblies(domain, &count);
    int hits = 0;
    for (size_t i = 0; i < count && hits < 600; i++) {
        const void* img = api.assembly_get_image(asms[i]);
        const char* an = api.image_get_name(img);
        if (is_system_assembly(an)) continue;
        size_t cc = api.image_get_class_count(img);
        for (size_t j = 0; j < cc && hits < 600; j++) {
            void* klass = const_cast<void*>(api.image_get_class(img, j));
            if (!klass || !derives_monobehaviour(api, klass)) continue;
            const void* u = api.class_get_method_from_name(klass, "Update", 0);
            const void* lu = api.class_get_method_from_name(klass, "LateUpdate", 0);
            if (!u && !lu) continue;
            const char* cn = api.class_get_name(klass);
            const char* ns = api.class_get_namespace ? api.class_get_namespace(klass) : "";
            bool hint = cn && (contains_ci(cn, "Game") || contains_ci(cn, "Main") ||
                               contains_ci(cn, "Engine") || contains_ci(cn, "Root") ||
                               contains_ci(cn, "Launch") || contains_ci(cn, "World") ||
                               contains_ci(cn, "Client") || contains_ci(cn, "App") ||
                               contains_ci(cn, "Loop") || contains_ci(cn, "Driver") ||
                               contains_ci(cn, "Mono") || contains_ci(cn, "Entry"));
            std::fprintf(f, "%s%s | %s.%s  U=%d LU=%d\n", hint ? "* " : "  ",
                         an ? an : "?", ns ? ns : "", cn ? cn : "?", u ? 1 : 0, lu ? 1 : 0);
            hits++;
        }
    }
    std::fclose(f);
    LOG("monobehaviours despejados (%d)", hits);
}

// Executa um move na THREAD PRINCIPAL (chamado pelo hook). Navigate opera
// NavMesh, que aqui esta na thread certa, entao deve funcionar de verdade.
void exec_move_main(float x, float y, float z) {
    void* player = current_player(g_api, g_xmain);
    if (!player) return;
    void* nav = *(void**)((char*)player + 0xa8);  // _nav (thread principal: leitura direta)
    if (!plausible_obj(nav) || !g_api.object_get_class) return;
    void* navcls = g_api.object_get_class(nav);
    const void* m = navcls ? g_api.class_get_method_from_name(navcls, "Navigate", 1) : nullptr;
    if (!m) return;
    float vec[3] = {x, y, z};
    void* params[1] = {vec};
    void* exc = nullptr;
    g_api.runtime_invoke(m, nav, params, &exc);
    LOG("exec Navigate main-thread (%.1f,%.1f,%.1f) exc=%s", x, y, z, exc ? "sim" : "nao");
}

// ACAO: liga/desliga o auto-hunt. Observado ao vivo: SendAutoFightMsg (um
// "Send...Msg") so avisa o servidor e NAO liga a IA local; o toggle real do
// client e provavelmente XAIComponent.SetAutoEnable(bool,bool). Para achar o
// certo sem recompilar a cada tentativa, suporta varios metodos por um id:
//   0 = _ai.SetAutoEnable(a1, a2)      (candidato a toggle mestre)
//   1 = _attr.set_AutoPlayOn(a1)       (flag de estado "auto ligado")
//   2 = _ai.SendAutoFightMsg(a1)       (so notifica o servidor)
//   3 = _ai.SendEnterFightEvent()      (sem args)
// Definidas mais abaixo (o callxm resolve caminho aqui na thread principal).
std::string walk_path(const std::vector<std::string>& path, size_t end, void*& obj);
std::vector<std::string> split_words(const std::string& body);

// Roda na thread principal (chamado pelo hook), igual ao move.
void exec_auto_main(const Action& act) {
    int method = act.method;
    bool a1 = act.a1 != 0, a2 = act.a2 != 0;
    void* player = current_player(g_api, g_xmain);
    // Metodos 7/8/9/10 (calls/callsn/callsi/callp, ex.: login) nao dependem do
    // jogador: rodam pre-mundo. Os demais (0-6, auto-hunt) precisam do player.
    if (!player && method != 7 && method != 8 && method != 9 && method != 10 && method != 11 && method != 12 &&
        method != 13 && method != 14) return;
    if (!g_api.object_get_class || !g_api.class_get_method_from_name || !g_api.runtime_invoke)
        return;
    uint8_t b1 = a1 ? 1 : 0, b2 = a2 ? 1 : 0;

    // method 6 = chamar um metodo nomeado no _ai (ferramenta de RE ao vivo,
    // para testar candidatos a off real sem recompilar: EnableBehaviorTree,
    // ResetAIData, TurnOffProvokedAI, etc.).
    if (method == 6) {
        void* ai = *(void**)((char*)player + 0xd8);
        if (!plausible_obj(ai)) { LOGE("call: _ai nulo"); return; }
        void* cls = g_api.object_get_class(ai);
        const void* m = cls ? g_api.class_get_method_from_name(cls, act.name, act.argc) : nullptr;
        if (!m) { LOGE("call: %s(%d) nao achado no _ai", act.name, act.argc); return; }
        void* exc = nullptr;
        if (act.argc <= 0) g_api.runtime_invoke(m, ai, nullptr, &exc);
        else if (act.argc == 1) { void* p[1] = {&b1}; g_api.runtime_invoke(m, ai, p, &exc); }
        else { void* p[2] = {&b1, &b2}; g_api.runtime_invoke(m, ai, p, &exc); }
        LOG("exec call %s(%d: %d,%d) exc=%s", act.name, act.argc, (int)a1, (int)a2,
            exc ? "sim" : "nao");
        return;
    }

    // method 7 = chamar metodo num singleton/estatico de uma classe nomeada
    // (RE do manager do auto-hunt, que nao e o _ai do player).
    if (method == 7) {
        void* klass = find_class_by_name(act.cls);
        if (!klass) { LOGE("calls: classe %s nao achada", act.cls); return; }
        void* inst = resolve_singleton(klass);  // null = metodo estatico
        const void* m = g_api.class_get_method_from_name(klass, act.name, act.argc);
        if (!m) { LOGE("calls: %s.%s(%d) nao achado", act.cls, act.name, act.argc); return; }
        if (missing_this(m, inst)) { LOGE("calls: %s sem singleton", act.cls); return; }
        void* exc = nullptr;
        if (act.argc <= 0) g_api.runtime_invoke(m, inst, nullptr, &exc);
        else if (act.argc == 1) { void* p[1] = {&b1}; g_api.runtime_invoke(m, inst, p, &exc); }
        else { void* p[2] = {&b1, &b2}; g_api.runtime_invoke(m, inst, p, &exc); }
        LOG("exec calls %s.%s(%d: %d,%d) inst=%p exc=%s", act.cls, act.name, act.argc,
            (int)a1, (int)a2, inst, exc ? "sim" : "nao");
        return;
    }

    // method 9 = como o 7, com args int32 (ids: XLoginDocument.ChangeRegion(int),
    // SetLoginZoneID).
    if (method == 9) {
        void* klass = find_class_by_name(act.cls);
        if (!klass) { LOGE("callsi: classe %s nao achada", act.cls); return; }
        void* inst = resolve_singleton(klass);
        const void* m = g_api.class_get_method_from_name(klass, act.name, act.argc);
        if (!m) { LOGE("callsi: %s.%s(%d) nao achado", act.cls, act.name, act.argc); return; }
        if (missing_this(m, inst)) { LOGE("callsi: %s sem singleton", act.cls); return; }
        int32_t i1 = act.a1, i2 = act.a2, i3 = act.a3;
        void* p[3] = {&i1, &i2, &i3};
        void* exc = nullptr;
        g_api.runtime_invoke(m, inst, act.argc > 0 ? p : nullptr, &exc);
        LOG("exec callsi %s.%s(%d: %d,%d,%d) inst=%p exc=%s", act.cls, act.name, act.argc, i1, i2, i3,
            inst, exc ? "sim" : "nao");
        return;
    }

    // method 12 = como o 9, com um Vector3 (por valor) antes dos ints:
    // TeleportDocument.TeleportNavigate(Vector3, uint cena, uint) navega ate uma
    // posicao, inclusive em outra cena (o jogo escolhe teleporte e caminho).
    if (method == 12) {
        void* klass = find_class_by_name(act.cls);
        if (!klass) { LOGE("callv3: classe %s nao achada", act.cls); return; }
        void* inst = resolve_singleton(klass);
        const void* m = g_api.class_get_method_from_name(klass, act.name, act.argc);
        if (!m) { LOGE("callv3: %s.%s(%d) nao achado", act.cls, act.name, act.argc); return; }
        if (missing_this(m, inst)) { LOGE("callv3: %s sem singleton", act.cls); return; }
        float vec[3] = {act.x, act.y, act.z};
        int32_t i1 = act.a1, i2 = act.a2;
        void* p[3] = {vec, &i1, &i2};
        void* exc = nullptr;
        g_api.runtime_invoke(m, inst, p, &exc);
        LOG("exec callv3 %s.%s(%d: (%.1f,%.1f,%.1f),%d,%d) inst=%p exc=%s", act.cls, act.name, act.argc,
            act.x, act.y, act.z, i1, i2, inst, exc ? "sim" : "nao");
        return;
    }

    // method 8 = chamar metodo num singleton com N args de REFERENCIA nulos.
    // Para handlers de UI On...(XUIEvent): muitos ignoram o evento, entao passar
    // nulo dispara a acao sem construir o objeto.
    if (method == 8) {
        void* klass = find_class_by_name(act.cls);
        if (!klass) { LOGE("callsn: classe %s nao achada", act.cls); return; }
        void* inst = resolve_singleton(klass);
        const void* m = g_api.class_get_method_from_name(klass, act.name, act.argc);
        if (!m) { LOGE("callsn: %s.%s(%d) nao achado", act.cls, act.name, act.argc); return; }
        if (missing_this(m, inst)) { LOGE("callsn: %s sem singleton", act.cls); return; }
        void* exc = nullptr;
        void* p[4] = {nullptr, nullptr, nullptr, nullptr};  // args de referencia nulos
        g_api.runtime_invoke(m, inst, act.argc > 0 ? p : nullptr, &exc);
        LOG("exec callsn %s.%s(%d nulos) inst=%p exc=%s", act.cls, act.name, act.argc,
            inst, exc ? "sim" : "nao");
        return;
    }

    // method 10 = callp: como o 8 (args de referencia nulos), num objeto achado
    // por caminho de campos a partir de um singleton (handler de UI que nao e
    // singleton, ex.: XLevelRewardView._StageFailHandler.OnRetryClicked). O
    // caminho foi resolvido na thread do socket; aqui so invoca.
    if (method == 10) {
        if (!plausible_obj(act.obj) || !act.mi) { LOGE("callp: objeto invalido"); return; }
        void* exc = nullptr;
        void* p[4] = {nullptr, nullptr, nullptr, nullptr};
        g_api.runtime_invoke(act.mi, act.obj, act.argc > 0 ? p : nullptr, &exc);
        LOG("exec callp %s.%s(%d nulos) obj=%p exc=%s", act.cls, act.name, act.argc, act.obj,
            exc ? "sim" : "nao");
        return;
    }

    // method 15 = CHAT: XChatView.SendChatContent(texto, canal, ...), o mesmo
    // caminho do botao Enviar do chat (filtro de palavras e bloqueio do proprio
    // jogo). No privado o destino e o ChatFriendId da tela, trocado so durante a
    // chamada e devolvido depois.
    if (method == 15) {
        void* klass = find_class_by_name("XChatView");
        void* view = klass ? resolve_singleton(klass) : nullptr;
        if (!plausible_obj(view)) { LOGE("say: XChatView nulo"); return; }
        const void* m = g_api.class_get_method_from_name(klass, "SendChatContent", 10);
        if (!m || !g_api.string_new) { LOGE("say: SendChatContent nao achado"); return; }
        uint64_t* friend_id = nullptr;
        if (act.a1 == 3) {
            void* fi = g_api.class_get_field_from_name(klass, "ChatFriendId");
            if (!fi) { LOGE("say: ChatFriendId nao achado"); return; }
            friend_id = (uint64_t*)((char*)view + g_api.field_get_offset(fi));
        }
        uint64_t before = friend_id ? *friend_id : 0;
        if (friend_id) *friend_id = act.say_to;
        int32_t ch = act.a1;
        uint8_t yes = 1, no = 0;
        uint32_t zero = 0;
        // content, channelType, selfReceive, param, bIsSystem, audioUrl,
        // audioFileName, audiotime, isRecruit, isDragonGuildRecruit
        void* p[10] = {g_api.string_new(act.say), &ch, &yes, nullptr, &no, nullptr, nullptr, &zero, &no, &no};
        void* exc = nullptr;
        g_api.runtime_invoke(m, view, p, &exc);
        if (friend_id) *friend_id = before;
        LOG("exec say canal=%d exc=%s", ch, exc ? "sim" : "nao");
        return;
    }

    // method 14 = callxm: o callx com os caminhos resolvidos aqui, na thread
    // principal. Serve pra objeto que so se alcanca por metodo da Unity (botao
    // de tela: Transform Find:"Chest" GetComponent:"XUISprite"), que na thread
    // do socket nao pode rodar. O g_read_mu serializa com as leituras do socket
    // (o walk_path usa o FaultGuard). Resolvido, segue como callx (method 13).
    if (method == 14) {
        Action a = act;
        {
            std::lock_guard<std::mutex> lk(g_read_mu);
            std::vector<std::string> w = split_words(a.xm_path);
            if (w.empty()) { LOGE("callxm: sem caminho"); return; }
            std::string err = walk_path(w, w.size(), a.obj);
            if (!err.empty() || !plausible_obj(a.obj)) { LOGE("callxm: caminho %s: %s", a.xm_path, err.c_str()); return; }
            a.mi = g_api.class_get_method_from_name(g_api.object_get_class(a.obj), a.name, a.argc);
            if (!a.mi) { LOGE("callxm: metodo %s nao achado", a.name); return; }
            int n = a.argc < 0 ? 0 : (a.argc > 8 ? 8 : a.argc);
            for (int i = 0; i < n; i++) {
                if (a.xkind[i] != 'o') continue;
                std::vector<std::string> op;
                std::string v = a.xm_opath[i];
                size_t st = 0;
                for (size_t j = 0; j <= v.size(); j++)
                    if (j == v.size() || v[j] == '|') { if (j > st) op.push_back(v.substr(st, j - st)); st = j + 1; }
                std::string e2 = op.empty() ? std::string("sem caminho") : walk_path(op, op.size(), a.xobj[i]);
                if (!e2.empty() || !plausible_obj(a.xobj[i])) { LOGE("callxm: arg %d %s: %s", i, a.xm_opath[i], e2.c_str()); return; }
            }
        }
        // Invoca fora do g_read_mu (o metodo do jogo pode demorar).
        a.method = 13;
        exec_auto_main(a);
        return;
    }

    // method 13 = callx: metodo num objeto achado por caminho com args tipados
    // (ids de 64 bits, texto, objeto por caminho). Ex.: XBagDocument.UseItem(XItem,
    // uint) e XTeamDocument.ReqTeamOp(7 args). Os objetos foram resolvidos na
    // thread do socket; o texto vira string do il2cpp aqui.
    if (method == 13) {
        if (!plausible_obj(act.obj) || !act.mi) { LOGE("callx: objeto invalido"); return; }
        int n = act.argc < 0 ? 0 : (act.argc > 8 ? 8 : act.argc);
        int32_t i32[8] = {0};
        uint32_t u32[8] = {0};
        uint64_t u64[8] = {0};
        uint8_t bb[8] = {0};
        void* p[8] = {nullptr};
        for (int i = 0; i < n; i++) {
            switch (act.xkind[i]) {
                case 'i': i32[i] = (int32_t)act.xval[i]; p[i] = &i32[i]; break;
                case 'u': u32[i] = (uint32_t)act.xval[i]; p[i] = &u32[i]; break;
                case 'q': u64[i] = act.xval[i]; p[i] = &u64[i]; break;
                case 'b': bb[i] = act.xval[i] ? 1 : 0; p[i] = &bb[i]; break;
                case 's': p[i] = g_api.string_new ? g_api.string_new(act.xstr[i]) : nullptr; break;
                case 'o': p[i] = act.xobj[i]; break;
                default: p[i] = nullptr; break;  // 'n'
            }
        }
        void* exc = nullptr;
        g_api.runtime_invoke(act.mi, act.obj, n > 0 ? p : nullptr, &exc);
        LOG("exec callx %s.%s(%d) obj=%p exc=%s", act.cls, act.name, n, act.obj, exc ? "sim" : "nao");
        return;
    }

    // method 11 = callpi: como o 10, com args int32 (documento sem singleton,
    // ex.: XSelectCharView._doc.set_SelectCharIndex(int)).
    if (method == 11) {
        if (!plausible_obj(act.obj) || !act.mi) { LOGE("callpi: objeto invalido"); return; }
        int32_t i1 = act.a1, i2 = act.a2;
        void* p[2] = {&i1, &i2};
        void* exc = nullptr;
        g_api.runtime_invoke(act.mi, act.obj, act.argc > 0 ? p : nullptr, &exc);
        LOG("exec callpi %s.%s(%d: %d,%d) obj=%p exc=%s", act.cls, act.name, act.argc, i1, i2,
            act.obj, exc ? "sim" : "nao");
        return;
    }

    // method 4 = ligar do zero: SetAutoEnable(1,1) no _ai engaja, set_AutoPlayOn(1)
    // no _attr sustenta. Provado ao vivo que os dois sao necessarios e nessa
    // ordem (AutoPlayOn sozinho nao inicia; SetAutoEnable sozinho nao sustenta).
    if (method == 4) {
        void* ai = *(void**)((char*)player + 0xd8);
        if (plausible_obj(ai)) {
            void* acls = g_api.object_get_class(ai);
            // Religa a behavior tree (cerebro da IA) ANTES de engajar: provado
            // ao vivo que sem isso o START nao recupera de um STOP que a desligou.
            const void* mbt =
                acls ? g_api.class_get_method_from_name(acls, "EnableBehaviorTree", 1) : nullptr;
            if (mbt) { uint8_t o = 1; void* p[1] = {&o}; void* e = nullptr; g_api.runtime_invoke(mbt, ai, p, &e); }
            const void* me = acls ? g_api.class_get_method_from_name(acls, "SetAutoEnable", 2) : nullptr;
            if (me) { uint8_t o = 1; void* p[2] = {&o, &o}; void* e = nullptr; g_api.runtime_invoke(me, ai, p, &e); }
        }
        void* attr = *(void**)((char*)player + 0x18);
        if (plausible_obj(attr)) {
            void* acls = g_api.object_get_class(attr);
            const void* ma = acls ? g_api.class_get_method_from_name(acls, "set_AutoPlayOn", 1) : nullptr;
            if (ma) { uint8_t o = 1; void* p[1] = {&o}; void* e = nullptr; g_api.runtime_invoke(ma, attr, p, &e); }
        }
        LOG("exec START (EnableBehaviorTree(1) + SetAutoEnable(1,1) + AutoPlayOn=1) main-thread");
        return;
    }

    // method 5 = parar: set_AutoPlayOn(0) no _attr + SetAutoEnable(0,0) no _ai.
    // Provado ao vivo: so o SetAutoEnable(0,0) trava movimento e casts; limpar
    // tambem o AutoPlayOn deixa o estado consistente.
    if (method == 5) {
        void* attr = *(void**)((char*)player + 0x18);
        if (plausible_obj(attr)) {
            void* acls = g_api.object_get_class(attr);
            const void* ma = acls ? g_api.class_get_method_from_name(acls, "set_AutoPlayOn", 1) : nullptr;
            if (ma) { uint8_t z = 0; void* p[1] = {&z}; void* e = nullptr; g_api.runtime_invoke(ma, attr, p, &e); }
        }
        void* ai = *(void**)((char*)player + 0xd8);
        if (plausible_obj(ai)) {
            void* acls = g_api.object_get_class(ai);
            const void* me = acls ? g_api.class_get_method_from_name(acls, "SetAutoEnable", 2) : nullptr;
            if (me) { uint8_t z = 0; void* p[2] = {&z, &z}; void* e = nullptr; g_api.runtime_invoke(me, ai, p, &e); }
            // Desliga a behavior tree: sem isso ela re-engaja ~3 s depois. E o
            // unico stop que fica parado; os flags sozinhos sao sobrepostos.
            const void* mbt =
                acls ? g_api.class_get_method_from_name(acls, "EnableBehaviorTree", 1) : nullptr;
            if (mbt) { uint8_t z = 0; void* p[1] = {&z}; void* e = nullptr; g_api.runtime_invoke(mbt, ai, p, &e); }
        }
        LOG("exec STOP (AutoPlayOn=0 + SetAutoEnable(0,0) + BT off) main-thread");
        return;
    }

    // method 1 age no _attr (XPlayerAttributes, 0x18); os outros no _ai (0xd8).
    if (method == 1) {
        void* attr = *(void**)((char*)player + 0x18);  // thread principal: leitura direta
        if (!plausible_obj(attr)) { LOGE("auto: _attr nulo"); return; }
        void* cls = g_api.object_get_class(attr);
        const void* m = cls ? g_api.class_get_method_from_name(cls, "set_AutoPlayOn", 1) : nullptr;
        if (!m) { LOGE("auto: set_AutoPlayOn ausente"); return; }
        void* p[1] = {&b1};
        void* exc = nullptr;
        g_api.runtime_invoke(m, attr, p, &exc);
        LOG("exec set_AutoPlayOn(%d) main-thread exc=%s", (int)a1, exc ? "sim" : "nao");
        return;
    }

    void* ai = *(void**)((char*)player + 0xd8);  // _ai (thread principal: leitura direta)
    if (!plausible_obj(ai)) { LOGE("auto: _ai nulo"); return; }
    void* cls = g_api.object_get_class(ai);
    if (!cls) return;
    void* exc = nullptr;
    if (method == 0) {
        const void* m = g_api.class_get_method_from_name(cls, "SetAutoEnable", 2);
        if (!m) { LOGE("auto: SetAutoEnable(2) ausente"); return; }
        void* p[2] = {&b1, &b2};
        g_api.runtime_invoke(m, ai, p, &exc);
        LOG("exec SetAutoEnable(%d,%d) main-thread exc=%s", (int)a1, (int)a2, exc ? "sim" : "nao");
    } else if (method == 2) {
        const void* m = g_api.class_get_method_from_name(cls, "SendAutoFightMsg", 1);
        if (!m) { LOGE("auto: SendAutoFightMsg ausente"); return; }
        void* p[1] = {&b1};
        g_api.runtime_invoke(m, ai, p, &exc);
        LOG("exec SendAutoFightMsg(%d) main-thread exc=%s", (int)a1, exc ? "sim" : "nao");
    } else if (method == 3) {
        const void* m = g_api.class_get_method_from_name(cls, "SendEnterFightEvent", 0);
        if (!m) { LOGE("auto: SendEnterFightEvent ausente"); return; }
        g_api.runtime_invoke(m, ai, nullptr, &exc);
        LOG("exec SendEnterFightEvent() main-thread exc=%s", exc ? "sim" : "nao");
    }
}

long long monotonic_ms() {
    timespec ts{};
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

// Le o Time.realtimeSinceStartup ~1x/s (thread principal: getter da Unity so
// aqui). ServerBuffInfo.leftTime = startLeftTime - (realtime - startTime).
void capture_clock() {
    static const void* mi = nullptr;
    static bool tried = false;
    long long now = monotonic_ms();
    if (now - g_rt_ms.load(std::memory_order_relaxed) < 1000) return;
    if (!mi && !tried) {
        tried = true;
        size_t count = 0;
        const void** asms = g_api.domain_get_assemblies(g_api.domain_get(), &count);
        for (size_t i = 0; i < count && !mi; i++) {
            const void* img = g_api.assembly_get_image(asms[i]);
            const char* an = img ? g_api.image_get_name(img) : nullptr;
            if (!an || std::strncmp(an, "UnityEngine.CoreModule", 22) != 0) continue;
            void* k = g_api.class_from_name(img, "UnityEngine", "Time");
            mi = k ? g_api.class_get_method_from_name(k, "get_realtimeSinceStartup", 0) : nullptr;
        }
        if (!mi) LOGE("relogio: Time.get_realtimeSinceStartup nao achado");
    }
    if (!mi) return;
    void* exc = nullptr;
    void* r = g_api.runtime_invoke(mi, nullptr, nullptr, &exc);
    if (exc || !r) return;
    g_rt.store(*reinterpret_cast<float*>((char*)r + 0x10), std::memory_order_relaxed);
    g_rt_ms.store(now, std::memory_order_relaxed);
}

void drain_queue() {
    capture_clock();
    if (!g_has_actions.load(std::memory_order_relaxed)) return;  // frame sem acao
    std::vector<Action> todo;
    {
        std::lock_guard<std::mutex> lk(g_queue_mu);
        todo.swap(g_queue);
        g_has_actions = false;
    }
    for (const Action& a : todo) {
        if (a.type == 1) exec_move_main(a.x, a.y, a.z);
        else if (a.type == 2) exec_auto_main(a);
    }
}

// Hook que substitui UnityMainThreadDispatcher.Update(): chama o original e
// drena a fila. A Unity chama isso todo frame na thread principal.
void hook_update(void* self, const void* mi) {
    static std::atomic<bool> logged{false};
    if (!logged.exchange(true)) LOG("hook_update CHAMADO (1a vez)");
    if (g_orig_update) g_orig_update(self, mi);
    drain_queue();
}

// Mesmo drain, mas via UIRoot.Update() (NGUI): cobre login, char select e mundo.
void hook_login_update(void* self, const void* mi) {
    static std::atomic<bool> lg{false};
    if (!lg.exchange(true)) LOG("drain pre-mundo ativo (UICamera.Update)");
    if (g_orig_login_update) g_orig_login_update(self, mi);
    drain_queue();
}

// Hook do evento de morte (XNetComponent.OnDeathNotify). Conta cada morte
// notificada pelo servidor (qualquer entidade a vista). Refinar depois para
// so as do jogador parseando KKSG.DeathInfo.
void hook_death(void* self, void* deathInfo, const void* mi) {
    static std::atomic<bool> logged{false};
    if (!logged.exchange(true)) LOG("hook_death CHAMADO (1a vez)");
    if (g_orig_death) g_orig_death(self, deathInfo, mi);
    g_death_events.fetch_add(1, std::memory_order_relaxed);
    // Abate do char: Killer (DeathInfo.get_Killer) igual ao get_ID do jogador.
    // Thread principal: chama os getters direto.
    void* player = current_player(g_api, g_xmain);
    if (!player || !deathInfo || !g_api.object_get_class) return;
    auto u64_of = [](void* obj, const char* name) -> uint64_t {
        void* c = g_api.object_get_class(obj);
        const void* m = c ? g_api.class_get_method_from_name(c, name, 0) : nullptr;
        if (!m) return 0;
        void* exc = nullptr;
        void* r = g_api.runtime_invoke(m, obj, nullptr, &exc);
        return (exc || !r) ? 0 : *reinterpret_cast<uint64_t*>((char*)r + 0x10);
    };
    uint64_t killer = u64_of(deathInfo, "get_Killer");
    if (killer && killer == u64_of(player, "get_ID")) g_kills.fetch_add(1, std::memory_order_relaxed);
}

// Acha uma classe de gameplay pelo nome (primeira em assembly nao-sistema).
void* find_class_by_name(const char* name) {
    void* domain = g_api.domain_get();
    size_t count = 0;
    const void** asms = g_api.domain_get_assemblies(domain, &count);
    for (size_t i = 0; i < count; i++) {
        const void* img = g_api.assembly_get_image(asms[i]);
        const char* an = g_api.image_get_name(img);
        if (is_system_assembly(an)) continue;
        size_t cc = g_api.image_get_class_count(img);
        for (size_t j = 0; j < cc; j++) {
            void* k = const_cast<void*>(g_api.image_get_class(img, j));
            if (!k) continue;
            const char* cn = g_api.class_get_name(k);
            if (cn && std::strcmp(cn, name) == 0) return k;
        }
    }
    return nullptr;
}

// Resolve o singleton de uma classe pelos getters usuais. Null = sem singleton
// (metodo pode ser estatico; o chamador passa inst=null). `get_Doc` e o getter
// estatico dos documentos (XSuperRiskDocument, XRaceDocument...): sem ele o doc
// so era alcancavel pelo `_doc` do Dlg aberto ou por indice no XDocuments.
void* resolve_singleton(void* klass) {
    if (!g_api.class_get_method_from_name || !g_api.runtime_invoke) return nullptr;
    const char* getters[] = {"get_singleton", "get_Instance", "get_Singleton",
                             "get_Inst", "get_instance", "get_Doc"};
    for (const char* g : getters) {
        const void* m = g_api.class_get_method_from_name(klass, g, 0);
        if (!m) continue;
        void* exc = nullptr;
        void* r = g_api.runtime_invoke(m, nullptr, nullptr, &exc);
        if (r && !exc) return r;
    }
    return find_document(klass);
}

// Documento sem singleton nem get_Doc (XOptionsDocument, XAutoPlayDocument,
// XReviveDocument...): procura a instancia em XDocuments.internalIterator. O
// XDocuments sai do _host de um documento que resolve por get_Doc. So devolve
// objeto da classe exata, entao classe estatica continua nula.
void* find_document(void* klass) {
    static void* seed_cls = nullptr;
    if (!seed_cls) seed_cls = find_class_by_name("XSuperRiskDocument");
    if (!seed_cls || klass == seed_cls) return nullptr;
    const void* gd = g_api.class_get_method_from_name(seed_cls, "get_Doc", 0);
    if (!gd) return nullptr;
    void* exc = nullptr;
    void* seed = g_api.runtime_invoke(gd, nullptr, nullptr, &exc);
    if (!seed || exc) return nullptr;
    FaultGuard guard;
    void* fh = find_field_in_chain(safe_class_of(seed), "_host");
    void* host = nullptr;
    if (!fh || !safe_read(&host, (char*)seed + g_api.field_get_offset(fh), sizeof(host)) ||
        !plausible_obj(host))
        return nullptr;
    void* fl = find_field_in_chain(safe_class_of(host), "internalIterator");
    void* list = nullptr;
    if (!fl || !safe_read(&list, (char*)host + g_api.field_get_offset(fl), sizeof(list)) ||
        !plausible_obj(list))
        return nullptr;
    // List<T>: _items (array: tamanho em +0x18, dados em +0x20) e _size.
    void* fi = find_field_in_chain(safe_class_of(list), "_items");
    void* fs = find_field_in_chain(safe_class_of(list), "_size");
    void* items = nullptr;
    int32_t size = 0;
    if (!fi || !fs || !safe_read(&items, (char*)list + g_api.field_get_offset(fi), sizeof(items)) ||
        !safe_read(&size, (char*)list + g_api.field_get_offset(fs), sizeof(size)) ||
        !plausible_obj(items) || size <= 0 || size > 4096)
        return nullptr;
    for (int32_t i = 0; i < size; i++) {
        void* d = nullptr;
        if (!safe_read(&d, (char*)items + 0x20 + (size_t)i * 8, sizeof(d)) || !plausible_obj(d)) continue;
        if (safe_class_of(d) == klass) return d;
    }
    return nullptr;
}

// Metodo de instancia chamado sem instancia: o codigo AOT desreferencia o this
// nulo e o jogo leva SIGSEGV (nao vira NullReferenceException). Acontece quando o
// singleton ainda nao existe, ex.: getv XLoginView durante o carregamento.
bool missing_this(const void* m, void* inst) {
    return !inst && g_api.method_is_instance && g_api.method_is_instance(m);
}

// Acha o image de um assembly pelo nome.
const void* find_image(const char* name) {
    void* domain = g_api.domain_get();
    size_t count = 0;
    const void** asms = g_api.domain_get_assemblies(domain, &count);
    for (size_t i = 0; i < count; i++) {
        const void* img = g_api.assembly_get_image(asms[i]);
        const char* an = g_api.image_get_name(img);
        if (an && std::strcmp(an, name) == 0) return img;
    }
    return nullptr;
}

// ---- Inline hook arm64 (patch de codigo) ----
// Sobrescreve o inicio da funcao com um salto absoluto pro nosso hook e monta um
// trampoline (instrucoes originais + salto de volta para fn+16). Necessario para
// o UIRoot.Update: a Unity cacheia o methodPointer dos metodos magicos no
// registro do MonoBehaviour, antes do nosso hook, entao trocar o methodPointer
// nao pega o componente ja registrado (UIRoot da cena de login). O patch no
// codigo intercepta qualquer chamada.

// Salto absoluto de 16 bytes. Clobbera X17 (scratch de veneer IP1, seguro no
// inicio de funcao): LDR X17,#8 ; BR X17 ; <target 64 bits>.
static void write_abs_jump(uint32_t* dst, const void* target) {
    dst[0] = 0x58000051;  // LDR X17, #8
    dst[1] = 0xD61F0220;  // BR X17
    uint64_t t = reinterpret_cast<uint64_t>(target);
    dst[2] = static_cast<uint32_t>(t & 0xffffffffu);
    dst[3] = static_cast<uint32_t>(t >> 32);
}

// True se a instrucao e PC-relativa: nao pode ser copiada verbatim pro tramp
// (ADR/ADRP, B/BL, B.cond, CBZ/CBNZ, TBZ/TBNZ, LDR/LDRSW literal).
static bool is_pc_relative(uint32_t ins) {
    if ((ins & 0x1f000000u) == 0x10000000u) return true;  // ADR/ADRP
    if ((ins & 0x7c000000u) == 0x14000000u) return true;  // B / BL
    if ((ins & 0xff000010u) == 0x54000000u) return true;  // B.cond
    if ((ins & 0x7e000000u) == 0x34000000u) return true;  // CBZ/CBNZ
    if ((ins & 0x7e000000u) == 0x36000000u) return true;  // TBZ/TBNZ
    if ((ins & 0x3b000000u) == 0x18000000u) return true;  // LDR/LDRSW literal
    return false;
}

// Aloca uma pagina executavel perto de target (dentro de +-range), achando um
// buraco livre em /proc/self/maps e mapeando ali com MAP_FIXED. Necessario para
// o trampoline: o ADRP relocado so alcanca +-4GB, e o mmap anonimo padrao pode
// cair muito longe de libil2cpp.
static void* alloc_near(uintptr_t target, int64_t range) {
    FILE* f = std::fopen("/proc/self/maps", "r");
    if (!f) return nullptr;
    char line[512];
    uintptr_t prev_end = 0;
    void* found = nullptr;
    while (std::fgets(line, sizeof(line), f)) {
        uintptr_t s = 0, e = 0;
        if (std::sscanf(line, "%lx-%lx", &s, &e) != 2) continue;
        if (prev_end && s > prev_end && (s - prev_end) >= 0x1000) {
            uintptr_t cands[2] = {prev_end, (s - 0x1000) & ~(uintptr_t)0xfff};
            for (uintptr_t a : cands) {
                if (a < prev_end || a + 0x1000 > s) continue;
                int64_t off = (int64_t)(a - target);
                if (off < -range || off > range) continue;
                void* p = mmap(reinterpret_cast<void*>(a), 0x1000,
                               PROT_READ | PROT_WRITE | PROT_EXEC,
                               MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);
                if (p != MAP_FAILED) { found = p; break; }
            }
        }
        if (found) break;
        prev_end = e;
    }
    std::fclose(f);
    return found;
}

// Reloca UMA instrucao de a_orig para a_new (para o trampoline). Copia verbatim
// se nao for PC-relativa; reescreve o imediato do ADRP (alcance +-4GB). Devolve
// false se for PC-relativa que nao sabemos relocar (ADR/B/BL/literal/CB/TB).
static bool reloc_insn(uint32_t ins, uintptr_t a_orig, uintptr_t a_new, uint32_t* out) {
    if ((ins & 0x9f000000u) == 0x90000000u) {  // ADRP Xd, imm
        uint32_t immlo = (ins >> 29) & 0x3u;
        uint32_t immhi = (ins >> 5) & 0x7ffffu;  // 19 bits
        int64_t imm = (int64_t)((immhi << 2) | immlo);
        if (imm & (1 << 20)) imm |= ~((int64_t)0x1fffff);  // sign-extend 21 bits
        uintptr_t target = (a_orig & ~(uintptr_t)0xfff) + ((uint64_t)imm << 12);
        int64_t ni = (int64_t)((target - (a_new & ~(uintptr_t)0xfff)) >> 12);
        if (ni < -((int64_t)1 << 20) || ni >= ((int64_t)1 << 20)) return false;  // fora do ADRP
        uint32_t u = (uint32_t)(ni & 0x1fffff);
        *out = (ins & 0x9f00001fu) | ((u & 0x3u) << 29) | (((u >> 2) & 0x7ffffu) << 5);
        return true;
    }
    if (is_pc_relative(ins)) return false;  // outra PC-relativa: nao relocamos
    *out = ins;
    return true;
}

// Instala o inline hook em *mi (MethodInfo; methodPointer no offset 0). Copia as
// 4 primeiras instrucoes (relocando ADRP) para um trampoline que salta de volta
// para fn+16, e sobrescreve as 4 primeiras com um salto absoluto pro hook (sem
// limite de alcance). out_orig recebe o trampoline (chame-o para rodar o
// original). O patch de 16 bytes e one-shot no init: a janela de corrida com a
// main thread (poucos stores, nanossegundos) e desprezivel.
static bool install_inline_hook(const void* mi, const void* hook, FnUpd* out_orig) {
    uint32_t* fn = reinterpret_cast<uint32_t*>(*(void* const*)mi);  // codigo nativo
    if (!fn) { LOGE("inline: methodPointer nulo"); return false; }
    LOG("inline: prologo %08x %08x %08x %08x", fn[0], fn[1], fn[2], fn[3]);
    uint32_t relocd[4];
    // Trampoline perto de fn (+-2GB) para que o ADRP relocado fique no alcance.
    uint32_t* tramp = reinterpret_cast<uint32_t*>(
        alloc_near(reinterpret_cast<uintptr_t>(fn), (int64_t)2 << 30));
    if (!tramp) { LOGE("inline: sem pagina perto pro trampoline"); return false; }
    for (int i = 0; i < 4; i++) {
        uintptr_t ao = reinterpret_cast<uintptr_t>(fn + i);
        uintptr_t an = reinterpret_cast<uintptr_t>(tramp + i);
        if (!reloc_insn(fn[i], ao, an, &relocd[i])) {
            LOGE("inline: instr %d PC-relativa nao relocavel (%08x)", i, fn[i]);
            munmap(tramp, 0x1000);
            return false;
        }
    }
    for (int i = 0; i < 4; i++) tramp[i] = relocd[i];
    write_abs_jump(tramp + 4, fn + 4);  // volta para fn + 16 bytes
    __builtin___clear_cache(reinterpret_cast<char*>(tramp), reinterpret_cast<char*>(tramp + 8));
    *out_orig = reinterpret_cast<FnUpd>(tramp);

    // Sobrescreve as 4 primeiras de fn com o salto absoluto pro hook.
    uintptr_t page = reinterpret_cast<uintptr_t>(fn) & ~static_cast<uintptr_t>(0xfff);
    size_t span = (((reinterpret_cast<uintptr_t>(fn) & 0xfff) + 16) > 0x1000) ? 0x2000 : 0x1000;
    if (mprotect(reinterpret_cast<void*>(page), span, PROT_READ | PROT_WRITE | PROT_EXEC) != 0) {
        LOGE("inline: mprotect RWX falhou"); return false;
    }
    // Ordem: dados (target) antes do BR/LDR para encurtar a janela de corrida.
    uint64_t t = reinterpret_cast<uint64_t>(hook);
    fn[2] = (uint32_t)(t & 0xffffffffu);
    fn[3] = (uint32_t)(t >> 32);
    fn[1] = 0xD61F0220;  // BR X17
    fn[0] = 0x58000051;  // LDR X17, #8
    __builtin___clear_cache(reinterpret_cast<char*>(fn), reinterpret_cast<char*>(fn + 4));
    mprotect(reinterpret_cast<void*>(page), span, PROT_READ | PROT_EXEC);
    return true;
}

// Instala o hook trocando o methodPointer de UnityMainThreadDispatcher.Update().
void install_update_hook() {
    if (g_hook_installed.exchange(true)) return;
    if (!g_api.class_from_name || !g_api.class_get_method_from_name) return;
    const void* core = find_image("Core.dll");
    if (!core) {
        LOGE("hook: Core.dll nao achado");
        return;
    }
    void* cls = g_api.class_from_name(core, "", "UnityMainThreadDispatcher");
    if (!cls) {
        LOGE("hook: UnityMainThreadDispatcher nao resolvido");
        return;
    }
    const void* mi = g_api.class_get_method_from_name(cls, "Update", 0);
    if (!mi) {
        LOGE("hook: Update() nao achado");
        return;
    }
    void** mp = (void**)mi;  // methodPointer no offset 0 do MethodInfo
    g_orig_update = reinterpret_cast<FnUpd>(*mp);
    LOG("hook: methodPointer original=%p", reinterpret_cast<void*>(g_orig_update));
    if (!g_orig_update) {
        LOGE("hook: methodPointer nulo");
        return;
    }
    uintptr_t page = (uintptr_t)mp & ~(uintptr_t)0xfff;
    if (mprotect((void*)page, 0x1000, PROT_READ | PROT_WRITE) != 0) {
        LOGE("hook: mprotect falhou");
        return;
    }
    *mp = reinterpret_cast<void*>(&hook_update);
    LOG("hook instalado (UnityMainThreadDispatcher.Update)");

    // Drain universal via UIRoot.Update() (NGUI, metodo magico): ticka em toda
    // cena com UI ativa (login, char select, mundo). Sem isto a fila so drenava
    // em mundo e o login por metodo nunca executava (callsn/calls pre-mundo).
    // UICamera.Update (NGUI) processa input todo frame: ticker confiavel na cena
    // de login (UIRoot.Update so e chamado uma vez aqui).
    void* lv = g_api.class_from_name(core, "", "UICamera");
    const void* lmi = lv ? g_api.class_get_method_from_name(lv, "Update", 0) : nullptr;
    if (lmi) {
        // INLINE hook (patch de codigo): trocar o methodPointer nao pega o
        // componente ja registrado (cache da Unity). Patchar o codigo pega.
        if (install_inline_hook(lmi, reinterpret_cast<const void*>(&hook_login_update),
                                &g_orig_login_update))
            LOG("inline hook instalado (UICamera.Update)");
        else
            LOGE("inline hook UICamera.Update falhou");
    } else {
        LOGE("hook: UICamera.Update nao achado");
    }
}

// Hook de morte: XNetComponent.OnDeathNotify(KKSG.DeathInfo). Separado do
// install_update_hook porque precisa do XMainClient, que so carrega depois da
// tela de atualizacao.
void install_death_hook() {
    void* ncls = g_api.class_from_name(g_xmain, "XMainClient", "XNetComponent");
    const void* dmi = ncls ? g_api.class_get_method_from_name(ncls, "OnDeathNotify", 1) : nullptr;
    if (!dmi) {
        LOGE("hook: OnDeathNotify nao achado");
        return;
    }
    void** dmp = (void**)dmi;
    g_orig_death = reinterpret_cast<FnDeath>(*dmp);
    if (!g_orig_death) return;
    uintptr_t dp = (uintptr_t)dmp & ~(uintptr_t)0xfff;
    if (mprotect((void*)dp, 0x1000, PROT_READ | PROT_WRITE) == 0) {
        *dmp = reinterpret_cast<void*>(&hook_death);
        LOG("hook de morte instalado (OnDeathNotify)");
    }
}

std::string to_json(const Introspection& r) {
    std::string j = "{\"ok\":";
    j += r.ok ? "true" : "false";
    j += ",\"assemblies\":" + std::to_string(r.assemblies);
    j += ",\"player\":" + r.player;
    j += "}";
    return j;
}

// Le o estado do jogador como JSON {"player":...}, serializado entre threads de
// socket (FaultGuard e global).
std::string read_player_json() {
    std::lock_guard<std::mutex> lk(g_read_mu);
    std::string player =
        g_ready ? read_live_player(g_api, g_xmain) : std::string("{\"ok\":false}");
    return std::string("{\"player\":") + player + "}";
}

std::vector<std::string> split_words(const std::string& body) {
    std::vector<std::string> out;
    size_t p0 = 0;
    while (p0 < body.size()) {
        size_t p1 = body.find(' ', p0);
        if (p1 == std::string::npos) p1 = body.size();
        if (p1 > p0) out.push_back(body.substr(p0, p1 - p0));
        p0 = p1 + 1;
    }
    return out;
}

// Metodo de 1 parametro System.String com esse nome, subindo pelas classes base.
// Component.GetComponent tem a versao (Type) e a (string) com 1 arg: a busca so
// por nome e numero de args pegava qualquer uma e mandava texto pra um Type.
const void* find_method_str1(void* klass, const char* name) {
    if (!g_api.class_get_methods || !g_api.method_get_name || !g_api.method_get_param_count ||
        !g_api.method_get_param || !g_api.type_get_name)
        return nullptr;
    for (void* k = klass; k; k = g_api.class_get_parent ? (void*)g_api.class_get_parent(k) : nullptr) {
        void* iter = nullptr;
        for (const void* m = g_api.class_get_methods(k, &iter); m; m = g_api.class_get_methods(k, &iter)) {
            const char* mn = g_api.method_get_name(m);
            if (!mn || std::strcmp(mn, name) != 0 || g_api.method_get_param_count(m) != 1) continue;
            const void* t = g_api.method_get_param(m, 0);
            char* tn = t ? g_api.type_get_name(t) : nullptr;
            bool ok = tn && std::strcmp(tn, "System.String") == 0;
            if (tn && g_api.free_mem) g_api.free_mem(tn);
            if (ok) return m;
        }
    }
    return nullptr;
}

// Resolve o singleton de path[0] e segue path[1..end): cada passo e um campo
// (ponteiro) ou, sem campo com esse nome, um metodo de 0 args que devolve
// objeto (ex.: XLoginDocument.GetLastRegionInfo). Devolve "" e o objeto em obj,
// ou o JSON de erro. Chamar sob g_read_mu.
std::string walk_path(const std::vector<std::string>& path, size_t end, void*& obj) {
    void* klass = find_class_by_name(path[0].c_str());
    if (!klass) return "{\"ok\":false,\"erro\":\"classe nao achada\"}";
    obj = resolve_singleton(klass);
    if (!obj) return "{\"ok\":false,\"erro\":\"sem singleton\"}";
    for (size_t i = 1; i < end; i++) {
        // "Metodo:N" = metodo de 1 arg int32 (ex.: get_Item:0 de uma List,
        // GetServerData:108). Sem ":" = campo ou metodo de 0 args.
        // "Metodo:a,b[,c]" = 2 ou 3 args int32 tambem no meio do caminho (ex.:
        // XSkillEffectMgr GetSkillConfig:<skill>,<nivel> SkillScript).
        // "Metodo:"texto"" = 1 arg string (ex.: Transform Find:"Chest"). Antes o
        // texto virava atoi = 0 e ia como ponteiro pro metodo nativo: em
        // 2026-11-11 15:24 isso prendeu o engine ate reiniciar o jogo.
        std::string name = path[i];
        bool has_arg = false;
        int32_t arg = 0;
        int32_t margs[3] = {0, 0, 0};
        int argc = 0;
        void* str_arg = nullptr;
        size_t colon = name.find(':');
        if (colon != std::string::npos) {
            const char* p = name.c_str() + colon + 1;
            if (*p == '"') {
                std::string txt(p + 1);
                if (!txt.empty() && txt.back() == '"') txt.pop_back();
                if (!g_api.string_new) return "{\"ok\":false,\"erro\":\"sem il2cpp_string_new\"}";
                str_arg = g_api.string_new(txt.c_str());
                if (!str_arg) return "{\"ok\":false,\"erro\":\"texto nao criado: " + path[i] + "\"}";
                argc = 1;
            } else {
                arg = (int32_t)std::atoi(p);
                margs[0] = arg;
                argc = 1;
                for (const char* c = std::strchr(p, ','); c && argc < 3; c = std::strchr(c + 1, ','))
                    margs[argc++] = (int32_t)std::atoi(c + 1);
            }
            name.resize(colon);
            has_arg = true;
        }
        void* sub = nullptr;
        void* cls = nullptr;
        void* fi = nullptr;
        if (name.size() > 2 && name.front() == '[' && name.back() == ']') {
            // "[n]" = elemento n de um array de referencias (Il2CppArray: tamanho
            // em +0x18, dados em +0x20).
            int idx = std::atoi(name.c_str() + 1);
            uint64_t len = 0;
            FaultGuard guard;
            if (!safe_read(&len, (char*)obj + 0x18, sizeof(len)) || idx < 0 || (uint64_t)idx >= len)
                return "{\"ok\":false,\"erro\":\"indice fora: " + path[i] + "\"}";
            if (!safe_read(&sub, (char*)obj + 0x20 + (size_t)idx * 8, sizeof(sub)) ||
                !plausible_obj(sub))
                return "{\"ok\":false,\"erro\":\"campo nulo: " + path[i] + "\"}";
            obj = sub;
            continue;
        }
        {
            FaultGuard guard;
            cls = safe_class_of(obj);
            if (!has_arg) fi = find_field_in_chain(cls, name.c_str());
            if (fi && !safe_read(&sub, (char*)obj + g_api.field_get_offset(fi), sizeof(sub)))
                sub = nullptr;
        }
        if (!fi && cls && has_arg && name == "get_Item") {
            // Indice fora da List: a excecao lancada por esse runtime_invoke
            // derrubou a thread (SIGSEGV em vez de exc), entao confere o Count antes.
            const void* mc = g_api.class_get_method_from_name(cls, "get_Count", 0);
            if (mc) {
                void* exc = nullptr;
                void* rc = g_api.runtime_invoke(mc, obj, nullptr, &exc);
                int n = (!exc && rc) ? *reinterpret_cast<int*>((char*)rc + 0x10) : 0;
                // Dictionary<int,..>.get_Item recebe chave, nao indice: so List.
                const char* cn = g_api.class_get_name(cls);
                if (cn && std::strncmp(cn, "List`", 5) == 0 && (arg < 0 || arg >= n))
                    return "{\"ok\":false,\"erro\":\"indice fora: " + path[i] + "\"}";
            }
        }
        if (!fi && cls) {
            const void* m = str_arg ? find_method_str1(cls, name.c_str())
                                    : g_api.class_get_method_from_name(cls, name.c_str(), argc);
            if (!m) return "{\"ok\":false,\"erro\":\"campo nao achado: " + path[i] + "\"}";
            void* exc = nullptr;
            // String e tipo de referencia: vai o proprio objeto, nao o endereco dele.
            void* args[3] = {str_arg ? str_arg : (void*)&margs[0], &margs[1], &margs[2]};
            sub = g_api.runtime_invoke(m, obj, has_arg ? args : nullptr, &exc);
            if (exc) return "{\"ok\":false,\"erro\":\"excecao em " + path[i] + "\"}";
        }
        if (!plausible_obj(sub))
            return "{\"ok\":false,\"erro\":\"campo nulo: " + path[i] + "\"}";
        obj = sub;
    }
    return "";
}

// Il2CppString (UTF-16) em UTF-8 com escape de JSON. O read_il2cpp_string troca
// letra fora do ASCII por "?"; aqui o texto sai inteiro (nomes do mapa e GETP).
// Texto maior que maxLen volta vazio, como no read_il2cpp_string.
std::string il2cpp_string_json(void* s, int maxLen) {
    std::string out;
    int len = 0;
    if (!plausible(s) || !safe_read(&len, (char*)s + 0x10, 4) || len <= 0 || len > maxLen) return out;
    for (int i = 0; i < len; i++) {
        uint16_t c = 0;
        if (!safe_read(&c, (char*)s + 0x14 + i * 2, 2)) break;
        uint32_t cp = c;
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < len) {
            uint16_t lo = 0;
            if (safe_read(&lo, (char*)s + 0x14 + (i + 1) * 2, 2) && lo >= 0xDC00 && lo <= 0xDFFF) {
                cp = 0x10000 + ((uint32_t)(c - 0xD800) << 10) + (lo - 0xDC00);
                i++;
            }
        }
        if (cp == '"' || cp == '\\') { out += '\\'; out += (char)cp; }
        else if (cp < 0x20) out += ' ';
        else if (cp < 0x80) out += (char)cp;
        else if (cp < 0x800) { out += (char)(0xC0 | (cp >> 6)); out += (char)(0x80 | (cp & 0x3F)); }
        else if (cp < 0x10000) { out += (char)(0xE0 | (cp >> 12)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F)); }
        else { out += (char)(0xF0 | (cp >> 18)); out += (char)(0x80 | ((cp >> 12) & 0x3F)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F)); }
    }
    return out;
}

// ENTS [raio]: num JSON so o que o mapa do app precisa, em vez de ~5 GETP por
// entidade. me = jogador (x, z, id e o alvo do auto-play: _ai._target); ents =
// [tipo, id, x, z, nivel, morto, hp, maxHp, "nome"] das entidades a ate `raio` m
// (padrao 120, no maximo 150); drops = [x, z, item, qtd] dos itens no chao
// (XLevelDoodadMgr._doodads com dropped e sem picked). Ids sao os 32 bits de baixo
// (como o GETP). Le na thread do socket, sob g_read_mu: so campos e getters C#
// do jogo (nada da Unity).
std::string read_entities_json(float radius) {
    if (radius <= 0 || radius > 400) radius = 120;
    void* mgrc = find_class_by_name("XEntityMgr");
    void* mgr = mgrc ? resolve_singleton(mgrc) : nullptr;
    if (!plausible_obj(mgr)) return "{\"ok\":false,\"erro\":\"XEntityMgr nulo\"}";
    FaultGuard guard;
    void* player = nullptr;
    if (!safe_read(&player, (char*)mgr + OFF_ENTITYMGR_PLAYER, sizeof(player)) || !plausible_obj(player))
        return "{\"ok\":false,\"erro\":\"jogador nulo (nao esta em mundo?)\"}";
    auto invoke0 = [](void* obj, const char* name) -> void* {
        void* cls = safe_class_of(obj);
        const void* m = cls ? g_api.class_get_method_from_name(cls, name, 0) : nullptr;
        if (!m) return nullptr;
        void* exc = nullptr;
        void* r = g_api.runtime_invoke(m, obj, nullptr, &exc);
        return exc ? nullptr : r;
    };
    auto boxed_u64 = [](void* r) -> uint64_t { uint64_t v = 0; if (r) safe_read(&v, (char*)r + 0x10, 8); return v; };
    auto boxed_i32 = [](void* r) -> int { int v = 0; if (r) safe_read(&v, (char*)r + 0x10, 4); return v; };
    auto boxed_b = [](void* r) -> bool { uint8_t v = 0; if (r) safe_read(&v, (char*)r + 0x10, 1); return v != 0; };
    auto entity_id = [&](void* e) -> uint32_t { return (uint32_t)boxed_u64(invoke0(e, "get_ID")); };
    float me[3] = {0, 0, 0};
    safe_read(me, (char*)player + OFF_XENTITY_CORRECTED_POS, sizeof(me));
    // Alvo do auto-play: XAIComponent._target (o _ai do jogador fica em +0xd8).
    uint32_t target = 0;
    void* ai = nullptr;
    if (safe_read(&ai, (char*)player + 0xd8, sizeof(ai)) && plausible_obj(ai)) {
        void* tf = find_field_in_chain(safe_class_of(ai), "_target");
        void* t = nullptr;
        if (tf && safe_read(&t, (char*)ai + g_api.field_get_offset(tf), sizeof(t)) && plausible_obj(t)) target = entity_id(t);
    }
    char buf[512];
    std::snprintf(buf, sizeof(buf), "{\"ok\":true,\"me\":{\"x\":%.1f,\"z\":%.1f,\"id\":%u,\"target\":%u},\"ents\":[",
                  me[0], me[2], entity_id(player), target);
    std::string j = buf;
    void* list = invoke0(mgr, "GetAll");
    int size = 0;
    void* items = nullptr;
    if (plausible_obj(list)) {
        safe_read(&items, (char*)list + 0x10, sizeof(items));
        safe_read(&size, (char*)list + 0x18, 4);
    }
    int n = 0;
    static size_t type_off = 0;
    for (int i = 0; plausible_obj(items) && i < size && i < 400 && n < 150; i++) {
        void* e = nullptr;
        if (!safe_read(&e, (char*)items + 0x20 + (size_t)i * 8, sizeof(e)) || !plausible_obj(e) || e == player) continue;
        float p[3] = {0, 0, 0};
        if (!safe_read(p, (char*)e + OFF_XENTITY_CORRECTED_POS, sizeof(p))) continue;
        float dx = p[0] - me[0], dz = p[2] - me[2];
        if (dx * dx + dz * dz > radius * radius) continue;
        if (!type_off) {
            void* tf = find_field_in_chain(safe_class_of(e), "_eEntity_Type");
            if (tf) type_off = g_api.field_get_offset(tf);
        }
        int type = 0;
        if (type_off) safe_read(&type, (char*)e + type_off, 4);
        int level = 0, hp = 0, maxHp = 0;
        void* attr = nullptr;
        if (safe_read(&attr, (char*)e + OFF_XOBJECT_ATTR, sizeof(attr)) && plausible_obj(attr)) {
            level = boxed_i32(invoke0(attr, "get_Level"));
            void* acls = safe_class_of(attr);
            const void* gm = acls ? g_api.class_get_method_from_name(acls, "GetAttr", 1) : nullptr;
            if (gm) {
                auto ga = [&](int a) -> int {
                    void* pa[1] = {&a};
                    void* exc = nullptr;
                    void* r = g_api.runtime_invoke(gm, attr, pa, &exc);
                    double d = 0;
                    if (!exc && r) safe_read(&d, (char*)r + 0x10, 8);
                    return (int)llround(d);
                };
                maxHp = ga(2011);
                hp = ga(2012);
            }
        }
        bool dead = boxed_b(invoke0(e, "get_IsDead"));
        std::string name = il2cpp_string_json(invoke0(e, "get_Name"));
        std::snprintf(buf, sizeof(buf), "%s[%d,%u,%.1f,%.1f,%d,%d,%d,%d,\"", n ? "," : "", type, entity_id(e), p[0], p[2], level,
                      dead ? 1 : 0, hp, maxHp);
        j += buf;
        j += name;
        j += "\"]";
        n++;
    }
    j += "],\"drops\":[";
    void* dmc = find_class_by_name("XLevelDoodadMgr");
    void* dm = dmc ? resolve_singleton(dmc) : nullptr;
    int nd = 0;
    if (plausible_obj(dm)) {
        void* lf = find_field_in_chain(safe_class_of(dm), "_doodads");
        void* dl = nullptr;
        if (lf) safe_read(&dl, (char*)dm + g_api.field_get_offset(lf), sizeof(dl));
        void* ditems = nullptr;
        int dsize = 0;
        if (plausible_obj(dl)) {
            safe_read(&ditems, (char*)dl + 0x10, sizeof(ditems));
            safe_read(&dsize, (char*)dl + 0x18, 4);
        }
        static size_t off_pos = 0, off_dropped = 0, off_picked = 0, off_id = 0, off_count = 0;
        for (int i = 0; plausible_obj(ditems) && i < dsize && i < 1000 && nd < 80; i++) {
            void* d = nullptr;
            if (!safe_read(&d, (char*)ditems + 0x20 + (size_t)i * 8, sizeof(d)) || !plausible_obj(d)) continue;
            if (!off_pos) {
                void* c = safe_class_of(d);
                void* f1 = find_field_in_chain(c, "pos");
                void* f2 = find_field_in_chain(c, "dropped");
                void* f3 = find_field_in_chain(c, "picked");
                void* f4 = find_field_in_chain(c, "id");
                void* f5 = find_field_in_chain(c, "count");
                if (!f1 || !f2 || !f3 || !f4 || !f5) break;
                off_pos = g_api.field_get_offset(f1);
                off_dropped = g_api.field_get_offset(f2);
                off_picked = g_api.field_get_offset(f3);
                off_id = g_api.field_get_offset(f4);
                off_count = g_api.field_get_offset(f5);
            }
            uint8_t dropped = 0, picked = 0;
            safe_read(&dropped, (char*)d + off_dropped, 1);
            safe_read(&picked, (char*)d + off_picked, 1);
            if (!dropped || picked) continue;
            float p[3] = {0, 0, 0};
            uint32_t item = 0, cnt = 0;
            if (!safe_read(p, (char*)d + off_pos, sizeof(p))) continue;
            float dx = p[0] - me[0], dz = p[2] - me[2];
            if (dx * dx + dz * dz > radius * radius) continue;
            safe_read(&item, (char*)d + off_id, 4);
            safe_read(&cnt, (char*)d + off_count, 4);
            std::snprintf(buf, sizeof(buf), "%s[%.1f,%.1f,%u,%u]", nd ? "," : "", p[0], p[2], item, cnt);
            j += buf;
            nd++;
        }
    }
    // path = [x, z] dos pontos do caminho que o char esta andando no mapa atual
    // (XNavigationComponent._realPath, calculado no Navigate; o primeiro e onde
    // ele estava ao comecar). Vazio sem navegacao (_bNav falso ou caminho nulo).
    j += "],\"path\":[";
    static size_t off_nav = 0, off_bnav = 0, off_real = 0;
    if (!off_nav) {
        void* f = find_field_in_chain(safe_class_of(player), "_nav");
        if (f) off_nav = g_api.field_get_offset(f);
    }
    void* nav = nullptr;
    if (off_nav && safe_read(&nav, (char*)player + off_nav, sizeof(nav)) && plausible_obj(nav)) {
        if (!off_bnav) {
            void* c = safe_class_of(nav);
            void* f1 = find_field_in_chain(c, "_bNav");
            void* f2 = find_field_in_chain(c, "_realPath");
            if (f1 && f2) { off_bnav = g_api.field_get_offset(f1); off_real = g_api.field_get_offset(f2); }
        }
        uint8_t on = 0;
        void* arr = nullptr;
        size_t len = 0;
        if (off_bnav && safe_read(&on, (char*)nav + off_bnav, 1) && on &&
            safe_read(&arr, (char*)nav + off_real, sizeof(arr)) && plausible_obj(arr) &&
            safe_read(&len, (char*)arr + 0x18, sizeof(len))) {
            // Vector3[]: max_length em +0x18, elementos de 12 bytes a partir de +0x20.
            for (size_t i = 0; i < len && i < 64; i++) {
                float p[3] = {0, 0, 0};
                if (!safe_read(p, (char*)arr + 0x20 + i * 12, sizeof(p))) break;
                std::snprintf(buf, sizeof(buf), "%s[%.1f,%.1f]", i ? "," : "", p[0], p[2]);
                j += buf;
            }
        }
    }
    j += "]}";
    return j;
}

// Processa um comando (tag + corpo) e devolve o JSON da resposta. CONN e
// desconhecidos caem no estado do jogador.
std::string dispatch_command(const std::string& tag, const std::string& body) {
    if (tag == "SRCH" && g_ready) {
        int target = std::atoi(body.c_str());
        void* player = current_player(g_api, g_xmain);
        if (!player) return "{\"ok\":false,\"erro\":\"sem player (em mundo?)\"}";
        std::lock_guard<std::mutex> lk(g_read_mu);
        FILE* f = std::fopen("/data/data/com.silkroad.mb/files/sro_search.txt", "w");
        if (f) {
            std::fprintf(f, "TARGET %d  player=%p\n", target, player);
            FaultGuard guard;
            int budget = 5000;
            search_rec(player, 0, "player", target, f, budget);
            void* attr = nullptr;
            if (safe_read(&attr, (char*)player + OFF_XOBJECT_ATTR, sizeof(attr)) &&
                plausible_obj(attr)) {
                budget = 5000;
                search_rec(attr, 0, "attr", target, f, budget);
            }
            std::fclose(f);
        }
        LOG("busca por %d concluida", target);
        return std::string("{\"ok\":true,\"target\":") + std::to_string(target) +
               ",\"file\":\"sro_search.txt\"}";
    }
    if (tag == "DMET" && g_ready) {
        std::lock_guard<std::mutex> lk(g_read_mu);
        dump_player_methods(g_api, g_xmain);
        return "{\"ok\":true,\"file\":\"sro_methods.txt\"}";
    }
    if (tag == "FIND" && g_boot_ready) {
        // Busca classes de gameplay cujo NOME contem o corpo (keyword) e
        // despeja seus metodos + se tem singleton. Para achar managers (ex.:
        // auto-hunt) sem adivinhar.
        std::lock_guard<std::mutex> lk(g_read_mu);
        FILE* f = std::fopen("/data/data/com.silkroad.mb/files/sro_find.txt", "w");
        if (!f) return "{\"ok\":false,\"erro\":\"sem arquivo\"}";
        void* domain = g_api.domain_get();
        size_t count = 0;
        const void** asms = g_api.domain_get_assemblies(domain, &count);
        const char* getters[] = {"get_singleton", "get_Instance", "get_Singleton",
                                 "get_Inst", "get_instance", "get_Doc"};
        int hits = 0;
        for (size_t i = 0; i < count && hits < 200; i++) {
            const void* img = g_api.assembly_get_image(asms[i]);
            const char* an = g_api.image_get_name(img);
            if (is_system_assembly(an)) continue;
            size_t cc = g_api.image_get_class_count(img);
            for (size_t j = 0; j < cc && hits < 200; j++) {
                void* k = const_cast<void*>(g_api.image_get_class(img, j));
                if (!k) continue;
                const char* cn = g_api.class_get_name(k);
                if (!cn || !contains_ci(cn, body.c_str())) continue;
                const char* ns = g_api.class_get_namespace ? g_api.class_get_namespace(k) : "";
                const char* sg = "-";
                for (const char* g : getters)
                    if (g_api.class_get_method_from_name(k, g, 0)) { sg = g; break; }
                std::fprintf(f, "CLASS %s %s.%s  singleton=%s\n", an, ns ? ns : "", cn, sg);
                if (g_api.class_get_methods && g_api.method_get_name) {
                    void* iter = nullptr;
                    for (const void* m = g_api.class_get_methods(k, &iter); m;
                         m = g_api.class_get_methods(k, &iter)) {
                        const char* mn = g_api.method_get_name(m);
                        uint32_t pc =
                            g_api.method_get_param_count ? g_api.method_get_param_count(m) : 0;
                        // Tipos dos params, pra escolher calls/callsi/callsn sem chutar.
                        std::string types;
                        for (uint32_t pi = 0;
                             pi < pc && g_api.method_get_param && g_api.type_get_name; pi++) {
                            const void* t = g_api.method_get_param(m, pi);
                            char* tn = t ? g_api.type_get_name(t) : nullptr;
                            types += pi ? ", " : " ";
                            types += tn ? tn : "?";
                            if (tn && g_api.free_mem) g_api.free_mem(tn);
                        }
                        std::fprintf(f, "  %s(%u)%s\n", mn ? mn : "?", pc, types.c_str());
                    }
                }
                hits++;
            }
        }
        std::fclose(f);
        LOG("FIND '%s': %d classes", body.c_str(), hits);
        return std::string("{\"ok\":true,\"hits\":") + std::to_string(hits) +
               ",\"file\":\"sro_find.txt\"}";
    }
    if (tag == "OBJV" && g_boot_ready) {
        // OBJV <Classe> [campo|getter ...]: resolve o singleton, segue o caminho
        // (ver walk_path) e despeja os campos de instancia (offset, nome, tipo,
        // valor) da cadeia de bases. Para achar estado de UI (ex.: qual sub-painel
        // do login esta ativo) sem adivinhar offset.
        std::vector<std::string> path = split_words(body);
        if (path.empty()) return "{\"ok\":false,\"erro\":\"sem classe\"}";
        std::lock_guard<std::mutex> lk(g_read_mu);
        void* obj = nullptr;
        std::string err = walk_path(path, path.size(), obj);
        if (!err.empty()) return err;
        FaultGuard guard;
        FILE* f = std::fopen("/data/data/com.silkroad.mb/files/sro_objv.txt", "w");
        if (!f) return "{\"ok\":false,\"erro\":\"sem arquivo\"}";
        int n = dump_object_typed(g_api, obj, body.c_str(), f);
        std::fclose(f);
        return std::string("{\"ok\":true,\"campos\":") + std::to_string(n) +
               ",\"file\":\"sro_objv.txt\"}";
    }
    if (tag == "KEYS" && g_boot_ready) {
        // KEYS <Classe> [campo|getter ...]: chaves de um Dictionary<int, objeto>
        // no fim do caminho (ex.: XLoginDocument _server_dic = ids dos servidores).
        // Le o _entries cru: Entry {int hashCode; int next; int key; T value}, com
        // value referencia = passo 0x18, dados do array em +0x20, so os _count
        // primeiros, pulando os livres (next < -1).
        std::vector<std::string> path = split_words(body);
        if (path.empty()) return "{\"ok\":false,\"erro\":\"sem classe\"}";
        std::lock_guard<std::mutex> lk(g_read_mu);
        void* dict = nullptr;
        std::string err = walk_path(path, path.size(), dict);
        if (!err.empty()) return err;
        FaultGuard guard;
        void* cls = safe_class_of(dict);
        void* fe = find_field_in_chain(cls, "_entries");
        void* fc = find_field_in_chain(cls, "_count");
        if (!fe || !fc) return "{\"ok\":false,\"erro\":\"nao e Dictionary\"}";
        void* entries = nullptr;
        int count = 0;
        if (!safe_read(&entries, (char*)dict + g_api.field_get_offset(fe), sizeof(entries)) ||
            !safe_read(&count, (char*)dict + g_api.field_get_offset(fc), sizeof(count)))
            return "{\"ok\":false,\"erro\":\"leitura falhou\"}";
        if (!plausible_obj(entries) || count < 0 || count > 4096)
            return "{\"ok\":true,\"keys\":[]}";
        std::string out = "{\"ok\":true,\"keys\":[";
        bool first = true;
        for (int i = 0; i < count; i++) {
            char* e = (char*)entries + 0x20 + (size_t)i * 0x18;
            int next = 0, key = 0;
            if (!safe_read(&next, e + 4, 4) || !safe_read(&key, e + 8, 4)) break;
            if (next < -1) continue;
            out += first ? "" : ",";
            out += std::to_string(key);
            first = false;
        }
        return out + "]}";
    }
    if (tag == "ENUM" && g_boot_ready) {
        // ENUM <Classe>: nomes e valores de um enum, pelos campos estaticos
        // (o value__ de instancia fica de fora), como o ATTR faz com o
        // XAttributeDefine. Ex.: ENUM RiskBoxState, pra nao chutar o estado
        // que o ChangeBoxState recebe.
        std::string name = body;
        while (!name.empty() && name.back() == ' ') name.pop_back();
        if (name.empty()) return "{\"ok\":false,\"erro\":\"sem classe\"}";
        if (!g_api.class_get_fields || !g_api.field_get_name || !g_api.field_static_get_value)
            return "{\"ok\":false,\"erro\":\"sem api de campos\"}";
        std::lock_guard<std::mutex> lk(g_read_mu);
        void* klass = find_class_by_name(name.c_str());
        if (!klass) return "{\"ok\":false,\"erro\":\"classe nao achada\"}";
        std::string out = "{\"ok\":true,\"values\":{";
        bool first = true;
        void* iter = nullptr;
        for (void* fi = g_api.class_get_fields(klass, &iter); fi;
             fi = g_api.class_get_fields(klass, &iter)) {
            int flags = g_api.field_get_flags ? g_api.field_get_flags(fi) : 0;
            if (!(flags & FIELD_ATTR_STATIC)) continue;
            const char* fn = g_api.field_get_name(fi);
            int64_t val = 0;  // cabe enum de ate 8 bytes; o comum e int32
            g_api.field_static_get_value(fi, &val);
            out += first ? "" : ",";
            out += "\"" + std::string(fn ? fn : "?") + "\":" + std::to_string((int32_t)val);
            first = false;
        }
        return out + "}}";
    }
    if (tag == "ENTS" && g_ready) {
        std::lock_guard<std::mutex> lk(g_read_mu);
        return read_entities_json((float)std::atof(body.c_str()));
    }
    // BUFS: buffs do char (XBuffComponent._ServerBuffList) =
    // [id, nivel, pilha, restante s, total s, "chave do nome"]. Restante -1 = sem
    // tempo (buff fixo) ou relogio ainda nao lido. So campos (nada da Unity): o
    // relogio vem do capture_clock da thread principal.
    if (tag == "BUFS" && g_ready) {
        std::lock_guard<std::mutex> lk(g_read_mu);
        void* mgrc = find_class_by_name("XEntityMgr");
        void* mgr = mgrc ? resolve_singleton(mgrc) : nullptr;
        if (!plausible_obj(mgr)) return "{\"ok\":false,\"erro\":\"XEntityMgr nulo\"}";
        FaultGuard guard;
        void* player = nullptr;
        if (!safe_read(&player, (char*)mgr + OFF_ENTITYMGR_PLAYER, sizeof(player)) || !plausible_obj(player))
            return "{\"ok\":false,\"erro\":\"jogador nulo (nao esta em mundo?)\"}";
        static size_t off_buff = 0, off_list = 0, o_id = 0, o_lv = 0, o_stack = 0, o_st = 0, o_sl = 0, o_ui = 0, o_info = 0, o_name = 0;
        if (!off_buff) {
            void* f = find_field_in_chain(safe_class_of(player), "_buff");
            if (f) off_buff = g_api.field_get_offset(f);
        }
        void* bc = nullptr;
        if (!off_buff || !safe_read(&bc, (char*)player + off_buff, sizeof(bc)) || !plausible_obj(bc))
            return "{\"ok\":false,\"erro\":\"sem _buff\"}";
        if (!off_list) {
            void* f = find_field_in_chain(safe_class_of(bc), "_ServerBuffList");
            if (f) off_list = g_api.field_get_offset(f);
        }
        void* list = nullptr;
        if (!off_list || !safe_read(&list, (char*)bc + off_list, sizeof(list)) || !plausible_obj(list))
            return "{\"ok\":false,\"erro\":\"sem _ServerBuffList\"}";
        void* items = nullptr;
        int size = 0;
        safe_read(&items, (char*)list + 0x10, sizeof(items));
        safe_read(&size, (char*)list + 0x18, 4);
        long long age = monotonic_ms() - g_rt_ms.load(std::memory_order_relaxed);
        float rt = g_rt.load(std::memory_order_relaxed);
        bool clock = rt >= 0 && age < 10000;
        float now = clock ? rt + (float)age / 1000.0f : 0;
        char buf[160];
        std::snprintf(buf, sizeof(buf), "{\"ok\":true,\"clock\":%s,\"buffs\":[", clock ? "true" : "false");
        std::string j = buf;
        int n = 0;
        for (int i = 0; plausible_obj(items) && i < size && i < 60; i++) {
            void* b = nullptr;
            if (!safe_read(&b, (char*)items + 0x20 + (size_t)i * 8, sizeof(b)) || !plausible_obj(b)) continue;
            if (!o_id) {
                void* c = safe_class_of(b);
                void* f1 = find_field_in_chain(c, "buffID");
                void* f2 = find_field_in_chain(c, "buffLevel");
                void* f3 = find_field_in_chain(c, "stackCount");
                void* f4 = find_field_in_chain(c, "startTime");
                void* f5 = find_field_in_chain(c, "startLeftTime");
                void* f6 = find_field_in_chain(c, "m_UIBuffInfo");
                if (!f1 || !f2 || !f3 || !f4 || !f5 || !f6) break;
                o_id = g_api.field_get_offset(f1); o_lv = g_api.field_get_offset(f2); o_stack = g_api.field_get_offset(f3);
                o_st = g_api.field_get_offset(f4); o_sl = g_api.field_get_offset(f5); o_ui = g_api.field_get_offset(f6);
            }
            uint32_t id = 0, lv = 0, stack = 0;
            float st = 0, sl = 0;
            safe_read(&id, (char*)b + o_id, 4);
            safe_read(&lv, (char*)b + o_lv, 4);
            safe_read(&stack, (char*)b + o_stack, 4);
            safe_read(&st, (char*)b + o_st, 4);
            safe_read(&sl, (char*)b + o_sl, 4);
            // Nome: m_UIBuffInfo.buffInfo.BuffName (chave de traducao).
            std::string key;
            void* ui = nullptr;
            if (safe_read(&ui, (char*)b + o_ui, sizeof(ui)) && plausible_obj(ui)) {
                if (!o_info) {
                    void* f = find_field_in_chain(safe_class_of(ui), "buffInfo");
                    if (f) o_info = g_api.field_get_offset(f);
                }
                void* info = nullptr;
                if (o_info && safe_read(&info, (char*)ui + o_info, sizeof(info)) && plausible_obj(info)) {
                    if (!o_name) {
                        void* f = find_field_in_chain(safe_class_of(info), "BuffName");
                        if (f) o_name = g_api.field_get_offset(f);
                    }
                    void* s = nullptr;
                    if (o_name && safe_read(&s, (char*)info + o_name, sizeof(s))) key = il2cpp_string_json(s);
                }
            }
            float left = (clock && sl > 0) ? sl - (now - st) : -1;
            if (left < 0 && sl > 0 && clock) left = 0;
            std::snprintf(buf, sizeof(buf), "%s[%u,%u,%u,%.0f,%.0f,\"", n ? "," : "", id, lv, stack, left, sl);
            j += buf;
            j += key;
            j += "\"]";
            n++;
        }
        return j + "]}";
    }
    if (tag == "GETP" && g_boot_ready) {
        // GETP <Classe> [campo|getter ...] <getter|campo>: como o OBJV, segue o
        // caminho a partir do singleton e chama o getter (0 args) no objeto final,
        // ou le o campo. Devolve int/bool, ou str para System.String. Ex.:
        // "XLoginView m_uiBehaviour m_QueueFrame get_activeInHierarchy" diz se o
        // painel da fila esta na tela.
        std::vector<std::string> path = split_words(body);
        if (path.size() < 2) return "{\"ok\":false,\"erro\":\"uso: Classe [campo...] getter\"}";
        std::lock_guard<std::mutex> lk(g_read_mu);
        void* obj = nullptr;
        void* static_cls = nullptr;
        std::string err = walk_path(path, path.size() - 1, obj);
        if (!err.empty()) {
            // "Classe MetodoEstatico[:arg]": classe sem instancia (ex.:
            // XStringDefineProxy GetString:"chave").
            void* k = path.size() == 2 ? find_class_by_name(path[0].c_str()) : nullptr;
            if (!k || err.find("sem singleton") == std::string::npos) return err;
            static_cls = k;
        }
        // "[n]" no fim = elemento n de um array de referencia (texto vira str);
        // "[#n]" = elemento n de um array de int32/uint32 (ex.: conditionId da
        // tarefa do Firm).
        {
            const std::string& lb = path.back();
            if (!static_cls && lb.size() > 2 && lb.front() == '[' && lb.back() == ']') {
                bool val = lb[1] == '#';
                int idx = std::atoi(lb.c_str() + (val ? 2 : 1));
                // "[#n:w:k]": array de struct com w int32 por elemento, le o int k
                // do elemento n (ex.: Dictionary<uint,uint>._entries = hash, next,
                // key, value: [#i:4:2] chave, [#i:4:3] valor).
                int words = 1, word = 0;
                if (val) {
                    const char* c1 = std::strchr(lb.c_str() + 2, ':');
                    if (c1) {
                        words = std::atoi(c1 + 1);
                        const char* c2 = std::strchr(c1 + 1, ':');
                        if (c2) word = std::atoi(c2 + 1);
                    }
                    if (words < 1 || word < 0 || word >= words) return "{\"ok\":false,\"erro\":\"[#n:w:k] invalido\"}";
                }
                uint64_t len = 0;
                FaultGuard guard;
                if (!safe_read(&len, (char*)obj + 0x18, sizeof(len)) || idx < 0 || (uint64_t)idx >= len)
                    return "{\"ok\":false,\"erro\":\"indice fora\"}";
                char ab[96];
                if (val) {
                    int32_t iv = 0;
                    if (!safe_read(&iv, (char*)obj + 0x20 + ((size_t)idx * words + word) * 4, sizeof(iv)))
                        return "{\"ok\":false,\"erro\":\"leitura falhou\"}";
                    std::snprintf(ab, sizeof(ab), "{\"ok\":true,\"int\":%d,\"len\":%llu}", iv,
                                  (unsigned long long)len);
                    return ab;
                }
                void* el = nullptr;
                if (!safe_read(&el, (char*)obj + 0x20 + (size_t)idx * 8, sizeof(el)) || !plausible_obj(el))
                    return "{\"ok\":false,\"erro\":\"elemento nulo\"}";
                const char* en = g_api.class_get_name(safe_class_of(el));
                if (en && std::strcmp(en, "String") == 0) return string_json(el);
                std::snprintf(ab, sizeof(ab), "{\"ok\":true,\"obj\":\"%s\",\"len\":%llu}", en ? en : "?",
                              (unsigned long long)len);
                return ab;
            }
        }
        // "Metodo:N" no fim = getter de 1 arg int (ex.: XSelectCharView
        // ConvertSlotToInfoIdx:2).
        std::string last = path.back();
        int32_t last_arg = 0;
        bool last_has_arg = false;
        void* last_str = nullptr;  // Metodo:"texto" = 1 arg System.String
        int32_t multi[3] = {0, 0, 0};  // Metodo:a,b[,c] = 2 ou 3 args int32 (bool vai 0/1)
        int multi_n = 0;
        size_t lc = last.find(':');
        if (lc != std::string::npos) {
            const char* a = last.c_str() + lc + 1;
            if (*a != '"' && std::strchr(a, ',')) {
                multi_n = std::sscanf(a, "%d,%d,%d", &multi[0], &multi[1], &multi[2]);
                if (multi_n < 2) multi_n = 0;
            }
            if (multi_n) {
                // tratado abaixo
            } else if (*a == '"') {
                std::string txt(a + 1);
                if (!txt.empty() && txt.back() == '"') txt.pop_back();
                if (!g_api.string_new) return "{\"ok\":false,\"erro\":\"sem il2cpp_string_new\"}";
                last_str = g_api.string_new(txt.c_str());
            } else {
                last_arg = (int32_t)std::atoi(a);
            }
            last.resize(lc);
            last_has_arg = true;
        }
        // "campo+N" = le o int N bytes depois do campo: struct embutida (ex.:
        // XSuperRiskMap PlayerCoord+4 = y do Coordinate {x, y}).
        int field_extra = 0;
        size_t lp = last.find('+');
        if (lp != std::string::npos && !last_has_arg) {
            field_extra = std::atoi(last.c_str() + lp + 1);
            last.resize(lp);
            if (field_extra < 0 || field_extra > 64)
                return "{\"ok\":false,\"erro\":\"deslocamento 0..64\"}";
        }
        const void* gm = lp != std::string::npos ? nullptr
            : g_api.class_get_method_from_name(static_cls ? static_cls : g_api.object_get_class(obj),
                                               last.c_str(), multi_n ? multi_n : (last_has_arg ? 1 : 0));
        if (static_cls && (!gm || missing_this(gm, nullptr)))
            return "{\"ok\":false,\"erro\":\"sem singleton e sem metodo estatico\"}";
        if (!gm) {
            // Sem getter com esse nome: le o campo direto (flags bool/int sem getter,
            // ex.: XLoginDocument._logining_game).
            void* fi = find_field_in_chain(g_api.object_get_class(obj), last.c_str());
            if (!fi) return "{\"ok\":false,\"erro\":\"getter/campo nao achado\"}";
            int iv = 0;
            void* sp = nullptr;
            if (field_extra) {
                FaultGuard guard;
                if (!safe_read(&iv, (char*)obj + g_api.field_get_offset(fi) + field_extra, sizeof(iv)))
                    return "{\"ok\":false,\"erro\":\"leitura falhou\"}";
                char eb[96];
                std::snprintf(eb, sizeof(eb), "{\"ok\":true,\"int\":%d,\"bool\":%s}", iv,
                              (iv & 0xff) ? "true" : "false");
                return eb;
            }
            {
                FaultGuard guard;
                if (!safe_read(&iv, (char*)obj + g_api.field_get_offset(fi), sizeof(iv)) ||
                    !safe_read(&sp, (char*)obj + g_api.field_get_offset(fi), sizeof(sp)))
                    return "{\"ok\":false,\"erro\":\"leitura falhou\"}";
                // Campo string: devolve o texto (ex.: nome do servidor).
                if (field_is_string(fi)) return string_json(sp);
            }
            char buf[96];
            std::snprintf(buf, sizeof(buf), "{\"ok\":true,\"int\":%d,\"bool\":%s}", iv,
                          (iv & 0xff) ? "true" : "false");
            return buf;
        }
        void* exc = nullptr;
        // Arg string vai como referencia (o proprio objeto); int vai por ponteiro.
        void* last_args[1] = {last_str ? last_str : static_cast<void*>(&last_arg)};
        void* multi_args[3] = {&multi[0], &multi[1], &multi[2]};
        void* r = g_api.runtime_invoke(gm, obj, multi_n ? multi_args : (last_has_arg ? last_args : nullptr), &exc);
        if (exc) return "{\"ok\":false,\"erro\":\"excecao\"}";
        if (!r) return "{\"ok\":true,\"null\":true}";
        {
            const char* rn = g_api.class_get_name(g_api.object_get_class(r));
            if (rn && std::strcmp(rn, "String") == 0) {
                FaultGuard guard;
                return string_json(r);
            }
        }
        int iv = *reinterpret_cast<int*>((char*)r + 0x10);
        unsigned char bv = *((unsigned char*)r + 0x10);
        char buf[96];
        std::snprintf(buf, sizeof(buf), "{\"ok\":true,\"int\":%d,\"bool\":%s}", iv,
                      bv ? "true" : "false");
        return buf;
    }
    if (tag == "DMB " && g_boot_ready) {
        std::lock_guard<std::mutex> lk(g_read_mu);
        dump_monobehaviours(g_api);
        return "{\"ok\":true,\"file\":\"sro_mb.txt\"}";
    }
    if (tag == "ATTR" && g_ready) {
        std::lock_guard<std::mutex> lk(g_read_mu);
        return do_attr_dump();
    }
    if (tag == "MOVE" && g_ready) {
        float x = 0, y = 0, z = 0;
        std::sscanf(body.c_str(), "%f %f %f", &x, &y, &z);
        {
            std::lock_guard<std::mutex> lk(g_queue_mu);
            g_queue.push_back({1, x, y, z, 0});
            g_has_actions = true;
        }
        char buf[120];
        std::snprintf(buf, sizeof(buf), "{\"ok\":true,\"enfileirado\":[%.1f,%.1f,%.1f]}", x, y, z);
        return buf;
    }
    // CHAT <canal> <roleid> <hex>: manda uma mensagem no chat (method 15). Canal
    // 1 Mundo, 2 Guilda, 7 Party, 3 Privado (roleid = destino; 0 nos outros).
    // Texto em UTF-8 escrito em hex (pode ter espaco e acento), ate 1000 bytes.
    // A resposta so confirma a fila: quem chama confere a mensagem no chat. Tag
    // propria (nao SKIL): no engine antigo uma tag desconhecida so devolve o
    // jogador, enquanto um SKIL desconhecido liga ou desliga a caca.
    if (tag == "CHAT" && g_ready) {
        std::vector<std::string> w = split_words(body);
        if (w.size() != 3) return "{\"ok\":false,\"erro\":\"uso: CHAT canal roleid hex\"}";
        int ch = std::atoi(w[0].c_str());
        if (ch != 1 && ch != 2 && ch != 3 && ch != 7) return "{\"ok\":false,\"erro\":\"canal: 1 2 3 7\"}";
        uint64_t to = std::strtoull(w[1].c_str(), nullptr, 10);
        if (ch == 3 && to == 0) return "{\"ok\":false,\"erro\":\"privado sem destino\"}";
        const std::string& hx = w[2];
        Action act{};
        if (hx.empty() || hx.size() % 2 || hx.size() / 2 >= sizeof(act.say))
            return "{\"ok\":false,\"erro\":\"texto vazio ou longo demais\"}";
        for (size_t i = 0; i < hx.size(); i += 2) {
            unsigned v = 0;
            if (std::sscanf(hx.c_str() + i, "%2x", &v) != 1 || v == 0)
                return "{\"ok\":false,\"erro\":\"hex invalido\"}";
            act.say[i / 2] = (char)v;
        }
        act.type = 2; act.method = 15; act.a1 = ch; act.say_to = to;
        {
            std::lock_guard<std::mutex> lk(g_queue_mu);
            g_queue.push_back(act);
            g_has_actions = true;
        }
        return "{\"ok\":true,\"say\":true}";
    }
    if (tag == "SKIL" && g_boot_ready) {
        // Liga/desliga o auto-hunt. Default (corpo "1"/"0" ou {"on":N}):
        // SetAutoEnable(on, on). O corpo pode escolher o metodo/args para
        // testar ao vivo sem recompilar:
        //   "setauto 1 0"  -> SetAutoEnable(1,0)
        //   "autoplay 1"   -> set_AutoPlayOn(1)
        //   "fightmsg 1"   -> SendAutoFightMsg(1)
        //   "enterfight"   -> SendEnterFightEvent()
        // getv <Classe> <getter>: resolve o singleton, chama o getter (0 args) e
        // DEVOLVE o valor de retorno (value type boxed em +0x10) como int/float/
        // double/bool. Leitura sincrona na thread do socket (sob g_read_mu),
        // igual ao GetAttr. Para ler estado (multiple do reward, andar, flags).
        if (body.rfind("getv ", 0) == 0) {
            char gcls[48] = {0}, gnm[48] = {0};
            std::sscanf(body.c_str(), "getv %47s %47s", gcls, gnm);
            std::lock_guard<std::mutex> lk(g_read_mu);
            void* klass = find_class_by_name(gcls);
            if (!klass) return "{\"ok\":false,\"erro\":\"classe nao achada\"}";
            void* inst = resolve_singleton(klass);  // null = getter estatico
            const void* gm = g_api.class_get_method_from_name(klass, gnm, 0);
            if (!gm) return "{\"ok\":false,\"erro\":\"getter nao achado\"}";
            if (missing_this(gm, inst)) return "{\"ok\":false,\"erro\":\"sem singleton\"}";
            void* exc = nullptr;
            void* r = g_api.runtime_invoke(gm, inst, nullptr, &exc);
            if (exc) return "{\"ok\":false,\"erro\":\"excecao\"}";
            if (!r) return "{\"ok\":true,\"null\":true}";
            int iv = *reinterpret_cast<int*>((char*)r + 0x10);
            long long lv = *reinterpret_cast<long long*>((char*)r + 0x10);
            float fv = *reinterpret_cast<float*>((char*)r + 0x10);
            double dv = *reinterpret_cast<double*>((char*)r + 0x10);
            unsigned char bv = *((unsigned char*)r + 0x10);
            char buf[224];
            std::snprintf(buf, sizeof(buf),
                          "{\"ok\":true,\"int\":%d,\"long\":%lld,\"float\":%.4f,"
                          "\"double\":%.4f,\"bool\":%s}",
                          iv, lv, fv, dv, bv ? "true" : "false");
            return buf;
        }
        // callsn <Classe> <metodo> <argc>: metodo num singleton com args de
        // referencia nulos (handlers de UI On...(XUIEvent)).
        if (body.rfind("callsn ", 0) == 0) {
            char cls[48] = {0}, nm[48] = {0};
            int argc = 0;
            std::sscanf(body.c_str(), "callsn %47s %47s %d", cls, nm, &argc);
            {
                std::lock_guard<std::mutex> lk(g_queue_mu);
                Action act{};
                act.type = 2; act.method = 8; act.argc = argc;
                std::strncpy(act.name, nm, sizeof(act.name) - 1);
                std::strncpy(act.cls, cls, sizeof(act.cls) - 1);
                g_queue.push_back(act);
                g_has_actions = true;
            }
            char buf[128];
            std::snprintf(buf, sizeof(buf), "{\"ok\":true,\"callsn\":\"%s.%s\",\"argc\":%d}",
                          cls, nm, argc);
            return buf;
        }
        // callp <Classe> [campo...] <metodo> <argc>: como o callsn, num objeto
        // achado por caminho (walk_path, como o GETP). Resolve objeto e metodo
        // aqui e devolve erro na hora; a chamada roda na thread principal.
        if (body.rfind("callp ", 0) == 0) {
            std::vector<std::string> w = split_words(body.substr(6));
            if (w.size() < 3) return "{\"ok\":false,\"erro\":\"uso: callp Classe [campo...] metodo argc\"}";
            int argc = std::atoi(w.back().c_str());
            const std::string nm = w[w.size() - 2];
            w.pop_back();
            void* obj = nullptr;
            const void* mi = nullptr;
            {
                std::lock_guard<std::mutex> lk(g_read_mu);
                std::string err = walk_path(w, w.size() - 1, obj);
                if (!err.empty()) return err;
                mi = g_api.class_get_method_from_name(g_api.object_get_class(obj), nm.c_str(), argc);
            }
            if (!mi) return "{\"ok\":false,\"erro\":\"metodo nao achado\"}";
            {
                std::lock_guard<std::mutex> lk(g_queue_mu);
                Action act{};
                act.type = 2; act.method = 10; act.argc = argc; act.obj = obj; act.mi = mi;
                std::strncpy(act.name, nm.c_str(), sizeof(act.name) - 1);
                std::strncpy(act.cls, w[0].c_str(), sizeof(act.cls) - 1);
                g_queue.push_back(act);
                g_has_actions = true;
            }
            char buf[128];
            std::snprintf(buf, sizeof(buf), "{\"ok\":true,\"callp\":\"%s\",\"argc\":%d}",
                          nm.c_str(), argc);
            return buf;
        }
        // callx <Classe> [campo...] <metodo> <argc> -- <arg>...: como o callp, com args
        // tipados (ver method 13). Objeto por caminho usa | no lugar do espaco:
        // o:XBagDocument|ItemBag|Items|get_Item:5. Texto sem espaco: s:abc (s: = "").
        // callxm: mesma sintaxe do callx, mas nada e resolvido aqui. Os caminhos
        // vao em texto pra thread principal (method 14), que resolve e invoca. A
        // resposta so confirma a fila: erro de caminho sai no logcat (SROENGINE),
        // e quem chama confere o efeito no estado do jogo.
        if (body.rfind("callxm ", 0) == 0) {
            std::vector<std::string> all = split_words(body.substr(7));
            auto sep = std::find(all.begin(), all.end(), std::string("--"));
            std::vector<std::string> w(all.begin(), sep);
            std::vector<std::string> args;
            if (sep != all.end()) args.assign(sep + 1, all.end());
            if (w.size() < 3) return "{\"ok\":false,\"erro\":\"uso: callxm Classe [campo...] metodo argc -- args\"}";
            int argc = std::atoi(w.back().c_str());
            w.pop_back();
            if (argc < 0 || argc > 8 || (int)args.size() != argc)
                return "{\"ok\":false,\"erro\":\"argc 0..8 e igual ao numero de args\"}";
            const std::string nm = w.back();
            w.pop_back();
            Action act{};
            act.type = 2; act.method = 14; act.argc = argc;
            std::string path;
            for (const std::string& s : w) path += (path.empty() ? "" : " ") + s;
            if (path.size() >= sizeof(act.xm_path)) return "{\"ok\":false,\"erro\":\"caminho longo demais\"}";
            std::strncpy(act.xm_path, path.c_str(), sizeof(act.xm_path) - 1);
            for (int i = 0; i < argc; i++) {
                const std::string& a = args[i];
                char k = a.empty() ? 'n' : a[0];
                std::string v = a.size() > 2 ? a.substr(2) : "";
                act.xkind[i] = k;
                if (k == 'i' || k == 'u' || k == 'b') act.xval[i] = (uint64_t)std::strtoll(v.c_str(), nullptr, 10);
                else if (k == 'q') act.xval[i] = std::strtoull(v.c_str(), nullptr, 10);
                else if (k == 's') std::strncpy(act.xstr[i], v.c_str(), sizeof(act.xstr[i]) - 1);
                else if (k == 'o') {
                    if (v.empty() || v.size() >= sizeof(act.xm_opath[i])) return "{\"ok\":false,\"erro\":\"o: caminho vazio ou longo demais\"}";
                    std::strncpy(act.xm_opath[i], v.c_str(), sizeof(act.xm_opath[i]) - 1);
                } else if (k != 'n') return "{\"ok\":false,\"erro\":\"tipo de arg: i u q b n s o\"}";
            }
            std::strncpy(act.name, nm.c_str(), sizeof(act.name) - 1);
            std::strncpy(act.cls, w[0].c_str(), sizeof(act.cls) - 1);
            {
                std::lock_guard<std::mutex> lk(g_queue_mu);
                g_queue.push_back(act);
                g_has_actions = true;
            }
            char buf[128];
            std::snprintf(buf, sizeof(buf), "{\"ok\":true,\"callxm\":\"%s\",\"argc\":%d}", nm.c_str(), argc);
            return buf;
        }
        if (body.rfind("callx ", 0) == 0) {
            std::vector<std::string> all = split_words(body.substr(6));
            auto sep = std::find(all.begin(), all.end(), std::string("--"));
            std::vector<std::string> w(all.begin(), sep);
            std::vector<std::string> args;
            if (sep != all.end()) args.assign(sep + 1, all.end());
            if (w.size() < 3) return "{\"ok\":false,\"erro\":\"uso: callx Classe [campo...] metodo argc -- args\"}";
            int argc = std::atoi(w.back().c_str());
            w.pop_back();
            if (argc < 0 || argc > 8 || (int)args.size() != argc)
                return "{\"ok\":false,\"erro\":\"argc 0..8 e igual ao numero de args\"}";
            const std::string nm = w.back();
            Action act{};
            act.type = 2; act.method = 13; act.argc = argc;
            {
                std::lock_guard<std::mutex> lk(g_read_mu);
                std::string err = walk_path(w, w.size() - 1, act.obj);
                if (!err.empty()) return err;
                act.mi = g_api.class_get_method_from_name(g_api.object_get_class(act.obj), nm.c_str(), argc);
                if (!act.mi) return "{\"ok\":false,\"erro\":\"metodo nao achado\"}";
                for (int i = 0; i < argc; i++) {
                    const std::string& a = args[i];
                    char k = a.empty() ? 'n' : a[0];
                    std::string v = a.size() > 2 ? a.substr(2) : "";
                    act.xkind[i] = k;
                    if (k == 'i' || k == 'u' || k == 'b') act.xval[i] = (uint64_t)std::strtoll(v.c_str(), nullptr, 10);
                    else if (k == 'q') act.xval[i] = std::strtoull(v.c_str(), nullptr, 10);
                    else if (k == 's') std::strncpy(act.xstr[i], v.c_str(), sizeof(act.xstr[i]) - 1);
                    else if (k == 'o') {
                        std::vector<std::string> op;
                        size_t st = 0;
                        for (size_t j = 0; j <= v.size(); j++)
                            if (j == v.size() || v[j] == '|') { if (j > st) op.push_back(v.substr(st, j - st)); st = j + 1; }
                        if (op.empty()) return "{\"ok\":false,\"erro\":\"o: sem caminho\"}";
                        std::string e2 = walk_path(op, op.size(), act.xobj[i]);
                        if (!e2.empty()) return e2;
                        if (!plausible_obj(act.xobj[i])) return "{\"ok\":false,\"erro\":\"o: objeto nulo\"}";
                    } else if (k != 'n') return "{\"ok\":false,\"erro\":\"tipo de arg: i u q b n s o\"}";
                }
            }
            std::strncpy(act.name, nm.c_str(), sizeof(act.name) - 1);
            std::strncpy(act.cls, w[0].c_str(), sizeof(act.cls) - 1);
            {
                std::lock_guard<std::mutex> lk(g_queue_mu);
                g_queue.push_back(act);
                g_has_actions = true;
            }
            char buf[128];
            std::snprintf(buf, sizeof(buf), "{\"ok\":true,\"callx\":\"%s\",\"argc\":%d}", nm.c_str(), argc);
            return buf;
        }
        // callpi <Classe> [campo...] <metodo> <argc> <i1> <i2>: como o callp, com
        // args int32 (sempre os dois no fim; o que passar do argc e ignorado).
        if (body.rfind("callpi ", 0) == 0) {
            std::vector<std::string> w = split_words(body.substr(7));
            if (w.size() < 5)
                return "{\"ok\":false,\"erro\":\"uso: callpi Classe [campo...] metodo argc i1 i2\"}";
            int i2 = std::atoi(w.back().c_str());
            w.pop_back();
            int i1 = std::atoi(w.back().c_str());
            w.pop_back();
            int argc = std::atoi(w.back().c_str());
            w.pop_back();
            if (argc < 0 || argc > 2) return "{\"ok\":false,\"erro\":\"argc 0..2\"}";
            const std::string nm = w.back();
            void* obj = nullptr;
            const void* mi = nullptr;
            {
                std::lock_guard<std::mutex> lk(g_read_mu);
                std::string err = walk_path(w, w.size() - 1, obj);
                if (!err.empty()) return err;
                mi = g_api.class_get_method_from_name(g_api.object_get_class(obj), nm.c_str(), argc);
            }
            if (!mi) return "{\"ok\":false,\"erro\":\"metodo nao achado\"}";
            {
                std::lock_guard<std::mutex> lk(g_queue_mu);
                Action act{};
                act.type = 2; act.method = 11; act.argc = argc; act.a1 = i1; act.a2 = i2;
                act.obj = obj; act.mi = mi;
                std::strncpy(act.name, nm.c_str(), sizeof(act.name) - 1);
                std::strncpy(act.cls, w[0].c_str(), sizeof(act.cls) - 1);
                g_queue.push_back(act);
                g_has_actions = true;
            }
            char buf[128];
            std::snprintf(buf, sizeof(buf), "{\"ok\":true,\"callpi\":\"%s\",\"argc\":%d}",
                          nm.c_str(), argc);
            return buf;
        }
        // callv3 <Classe> <metodo> <argc> <x> <y> <z> [i1] [i2]: metodo com um
        // Vector3 seguido de ate 2 int32 (argc conta o Vector3).
        if (body.rfind("callv3 ", 0) == 0) {
            char cls[48] = {0}, nm[48] = {0};
            int argc = 0, c1 = 0, c2 = 0;
            float x = 0, y = 0, z = 0;
            std::sscanf(body.c_str(), "callv3 %47s %47s %d %f %f %f %d %d", cls, nm, &argc, &x, &y, &z, &c1, &c2);
            if (argc < 1 || argc > 3) return "{\"ok\":false,\"erro\":\"argc 1..3\"}";
            {
                std::lock_guard<std::mutex> lk(g_queue_mu);
                Action act{};
                act.type = 2; act.method = 12; act.argc = argc; act.x = x; act.y = y; act.z = z;
                act.a1 = c1; act.a2 = c2;
                std::strncpy(act.name, nm, sizeof(act.name) - 1);
                std::strncpy(act.cls, cls, sizeof(act.cls) - 1);
                g_queue.push_back(act);
                g_has_actions = true;
            }
            char buf[160];
            std::snprintf(buf, sizeof(buf), "{\"ok\":true,\"callv3\":\"%s.%s\",\"argc\":%d}", cls, nm, argc);
            return buf;
        }
        // callsi <Classe> <metodo> <argc> <i1> <i2> [i3]: como o calls, com args
        // int32 (ate 3; bool no fim vai como int 0/1).
        if (body.rfind("callsi ", 0) == 0) {
            char cls[48] = {0}, nm[48] = {0};
            int argc = 0, c1 = 0, c2 = 0, c3 = 0;
            std::sscanf(body.c_str(), "callsi %47s %47s %d %d %d %d", cls, nm, &argc, &c1, &c2, &c3);
            if (argc < 0 || argc > 3) return "{\"ok\":false,\"erro\":\"argc 0..3\"}";
            {
                std::lock_guard<std::mutex> lk(g_queue_mu);
                Action act{};
                act.type = 2; act.method = 9; act.argc = argc; act.a1 = c1; act.a2 = c2; act.a3 = c3;
                std::strncpy(act.name, nm, sizeof(act.name) - 1);
                std::strncpy(act.cls, cls, sizeof(act.cls) - 1);
                g_queue.push_back(act);
                g_has_actions = true;
            }
            char buf[128];
            std::snprintf(buf, sizeof(buf), "{\"ok\":true,\"callsi\":\"%s.%s\",\"argc\":%d}",
                          cls, nm, argc);
            return buf;
        }
        // calls <Classe> <metodo> <argc> <a1> <a2>: metodo num singleton (RE).
        if (body.rfind("calls ", 0) == 0) {
            char cls[48] = {0}, nm[48] = {0};
            int argc = 0, c1 = 0, c2 = 0;
            std::sscanf(body.c_str(), "calls %47s %47s %d %d %d", cls, nm, &argc, &c1, &c2);
            {
                std::lock_guard<std::mutex> lk(g_queue_mu);
                Action act{};
                act.type = 2; act.method = 7; act.argc = argc; act.a1 = c1; act.a2 = c2;
                std::strncpy(act.name, nm, sizeof(act.name) - 1);
                std::strncpy(act.cls, cls, sizeof(act.cls) - 1);
                g_queue.push_back(act);
                g_has_actions = true;
            }
            char buf[128];
            std::snprintf(buf, sizeof(buf), "{\"ok\":true,\"calls\":\"%s.%s\",\"argc\":%d}",
                          cls, nm, argc);
            return buf;
        }
        // call <metodo> <argc> <a1> <a2>: chama um metodo nomeado no _ai (RE).
        if (body.rfind("call ", 0) == 0) {
            char nm[48] = {0};
            int argc = 0, c1 = 0, c2 = 0;
            std::sscanf(body.c_str(), "call %47s %d %d %d", nm, &argc, &c1, &c2);
            {
                std::lock_guard<std::mutex> lk(g_queue_mu);
                Action act{};
                act.type = 2; act.method = 6; act.argc = argc; act.a1 = c1; act.a2 = c2;
                std::strncpy(act.name, nm, sizeof(act.name) - 1);
                g_queue.push_back(act);
                g_has_actions = true;
            }
            char buf[96];
            std::snprintf(buf, sizeof(buf), "{\"ok\":true,\"call\":\"%s\",\"argc\":%d}", nm, argc);
            return buf;
        }
        int method = 0, a1 = 0, a2 = 0;
        auto digits = [](const std::string& s, int n) {
            std::vector<int> v;
            for (char c : s)
                if (c == '0' || c == '1') { v.push_back(c - '0'); if ((int)v.size() >= n) break; }
            while ((int)v.size() < n) v.push_back(0);
            return v;
        };
        size_t kw;
        if ((kw = body.find("setauto")) != std::string::npos) {
            auto v = digits(body.substr(kw + 7), 2);
            method = 0; a1 = v[0]; a2 = v[1];
        } else if ((kw = body.find("autoplay")) != std::string::npos) {
            method = 1; a1 = digits(body.substr(kw + 8), 1)[0];
        } else if ((kw = body.find("fightmsg")) != std::string::npos) {
            method = 2; a1 = digits(body.substr(kw + 8), 1)[0];
        } else if (body.find("enterfight") != std::string::npos) {
            method = 3;
        } else {
            size_t k = body.find("on");  // {"on":N}; senao corpo cru "1"/"0"
            std::string scan = (k != std::string::npos) ? body.substr(k + 2) : body;
            int on = scan.find('1') != std::string::npos ? 1 : 0;
            // Semantica provada ao vivo: ON = method 4 (SetAutoEnable(1,1) +
            // AutoPlayOn=1), OFF = method 5 (SetAutoEnable(0,0) + AutoPlayOn=0).
            method = on ? 4 : 5;
            a1 = a2 = 0;
        }
        {
            std::lock_guard<std::mutex> lk(g_queue_mu);
            Action act{};
            act.type = 2; act.method = method; act.a1 = a1; act.a2 = a2;
            g_queue.push_back(act);
            g_has_actions = true;
        }
        char buf[96];
        std::snprintf(buf, sizeof(buf), "{\"ok\":true,\"method\":%d,\"a1\":%d,\"a2\":%d}",
                      method, a1, a2);
        return buf;
    }
    return read_player_json();
}

// Atende UMA conexao ate o cliente fechar. Modelo persistente: responde cada
// comando (OKAY + RESP) e, a cada ~1 s sem comando, empurra o estado do jogador
// (serve tambem de heartbeat para o controlador). Uma thread por conexao, para
// nao travar os clientes one-shot (queryPlayer, ferramentas de teste).
void handle_conn(int cli) {
    const std::string okay = proto::frame("OKAY", "{}");
    char buf[512];
    // Comeca "agora", nao em 0: senao a primeira iteracao empurraria um
    // RESP {player} antes de servir o comando inicial, e num cliente one-shot
    // (queryPlayer, setAutoFight) esse push viraria a primeira RESP lida no
    // lugar da resposta do comando. Assim o push periodico so comeca ~1 s
    // depois, com a resposta do comando ja entregue.
    time_t last_push = time(nullptr);
    void* il2cpp_thread = nullptr;
    while (true) {
        // Registra a thread no runtime antes de tocar em objeto gerenciado
        // (comando ou push): sem isso uma excecao lancada num runtime_invoke
        // daqui (ex.: get_Item fora do indice) desreferenciava o estado de thread
        // nulo e dava SIGSEGV, e o GC nao enxergava as referencias desta thread.
        if (g_boot_ready && !il2cpp_thread) il2cpp_thread = g_api.thread_attach(g_api.domain_get());
        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(cli, &rfds);
        timeval tv{0, 200 * 1000};  // 200 ms
        int sel = select(cli + 1, &rfds, nullptr, nullptr, &tv);
        if (sel < 0) break;
        if (sel > 0 && FD_ISSET(cli, &rfds)) {
            int n = recv(cli, buf, sizeof(buf), 0);
            if (n <= 0) break;  // EOF ou erro: cliente fechou
            std::string tag = (n >= 4) ? std::string(buf, 4) : std::string();
            std::string body;
            if (n > (int)sizeof(proto::Header)) {
                uint32_t len = 0;
                std::memcpy(&len, buf + 12, 4);
                int avail = n - (int)sizeof(proto::Header);
                body.assign(buf + sizeof(proto::Header), std::min((int)len, avail));
            }
            std::string resp = proto::frame("RESP", dispatch_command(tag, body));
            if (send(cli, okay.data(), okay.size(), 0) < 0) break;
            if (send(cli, resp.data(), resp.size(), 0) < 0) break;
        }
        time_t now = time(nullptr);
        if (now - last_push >= 1) {
            last_push = now;
            std::string push = proto::frame("RESP", read_player_json());
            if (send(cli, push.data(), push.size(), 0) < 0) break;
        }
    }
    if (il2cpp_thread && g_api.thread_detach) g_api.thread_detach(il2cpp_thread);
    close(cli);
}

void serve() {
    int srv = socket(AF_INET, SOCK_STREAM, 0);
    if (srv < 0) {
        LOGE("socket() falhou");
        return;
    }
    int one = 1;
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(kPort);
    if (bind(srv, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        LOGE("bind na porta %d falhou", kPort);
        close(srv);
        return;
    }
    listen(srv, 4);
    LOG("engine escutando em 127.0.0.1:%d", kPort);

    while (true) {
        int cli = accept(srv, nullptr, nullptr);
        if (cli < 0) continue;
        std::thread(handle_conn, cli).detach();  // uma thread por conexao
    }
}

void engine_main() {
    LOG("engine iniciado (pid in-process)");
    introspect();  // sobe o socket (serve) assim que a API AOT fica pronta
}

}  // namespace

__attribute__((constructor)) static void on_load() {
    if (g_started.exchange(true)) return;
    std::thread(engine_main).detach();
}
