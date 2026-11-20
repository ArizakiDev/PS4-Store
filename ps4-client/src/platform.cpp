#include "platform.h"

#include <cstdarg>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <csignal>
#include <exception>
#include <fcntl.h>
#include <map>
#include <mutex>
#include <setjmp.h>
#include <dirent.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <sys/statfs.h>
#include <sys/statvfs.h>
#include <sys/types.h>
#include <time.h>
#include <typeinfo>
#include <unistd.h>

#include <orbis/Sysmodule.h>

#if defined(__has_include)
#  if __has_include("../external/libjbc/jbc.h")
#    include "../external/libjbc/jbc.h"
#    define PS4STORE_HAVE_JBC 1
#  endif
#endif

extern "C" {
int sceSystemServiceReceiveEvent(void* event);
int sceSystemServiceGetStatus(void* status);
int sceSystemServiceParamGetInt(int paramId, int* value);
int sceKernelLoadStartModule(const char* name, size_t argc, const void* argv, unsigned flags, void* opt, int* res);
int sceKernelDlsym(int handle, const char* symbol, void** addr);
}

namespace platform {
namespace {

std::mutex g_mutex;
std::string g_error;
std::map<std::string, int> g_modules;

const char* kLogPrimary  = "/data/PS4Store/boot.log";
const char* kLogFallback = "/data/PS4Store_boot.log";
const char* g_logPath = nullptr;

double nowSeconds() {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0.0;
    return (double)ts.tv_sec + ts.tv_nsec / 1e9;
}

bool appendLine(const char* path, const char* line) {
    FILE* f = std::fopen(path, "a");
    if (!f) return false;
    std::fputs(line, f);
    std::fflush(f);
    std::fclose(f);
    return true;
}

sigjmp_buf g_probeJmp;
volatile sig_atomic_t g_probing = 0;
char g_crashPath[64] = "/data/PS4Store_boot.log";

void writeCrash(const char* msg) {
    int fd = open(g_crashPath, O_WRONLY | O_APPEND | O_CREAT, 0666);
    if (fd < 0) return;
    size_t n = std::strlen(msg);
    ssize_t r = write(fd, msg, n); (void)r;
    close(fd);
}

void (*g_crashHook)() = nullptr;
volatile sig_atomic_t g_inCrash = 0;

void runCrashHook() {
    if (g_inCrash) return;
    g_inCrash = 1;
    if (g_crashHook) g_crashHook();
}

void fatalHandler(int sig, siginfo_t* info, void*) {
    if (g_probing) { g_probing = 0; siglongjmp(g_probeJmp, sig); }
    char buf[96];
    const char* name = sig == SIGSEGV ? "SIGSEGV" : sig == SIGBUS ? "SIGBUS" : sig == SIGILL ? "SIGILL" :
                       sig == SIGFPE ? "SIGFPE" : sig == SIGABRT ? "SIGABRT" : sig == SIGSYS ? "SIGSYS" : "SIGNAL";
    char addr[19]; uintptr_t a = info ? (uintptr_t)info->si_addr : 0;
    addr[0] = '0'; addr[1] = 'x';
    for (int i = 0; i < 16; ++i) { int d = (int)((a >> (60 - 4 * i)) & 0xF); addr[2 + i] = (char)(d < 10 ? '0' + d : 'a' + d - 10); }
    addr[18] = 0;
    std::strcpy(buf, "!!! CRASH ");
    std::strcat(buf, name);
    std::strcat(buf, " addr=");
    std::strcat(buf, addr);
    std::strcat(buf, "\n");
    writeCrash(buf);
    runCrashHook();
    std::signal(sig, SIG_DFL);
    raise(sig);
}

void describeCurrentException(char* out, size_t outSize) {
    out[0] = 0;
    std::exception_ptr ep = std::current_exception();
    if (!ep) { std::snprintf(out, outSize, "aucune exception active (std::thread joignable detruit, ou noexcept viole)"); return; }
    try {
        std::rethrow_exception(ep);
    } catch (const std::exception& e) {
        std::snprintf(out, outSize, "%s : %s", typeid(e).name(), e.what());
    } catch (...) {
        std::snprintf(out, outSize, "exception de type inconnu");
    }
}

void terminateHandler() {
    char desc[240];
    describeCurrentException(desc, sizeof desc);
    char line[320];
    std::snprintf(line, sizeof line, "!!! CRASH std::terminate : %s\n", desc);
    writeCrash(line);
    runCrashHook();
    std::abort();
}

template <class F> bool guarded(F fn, bool& result) {
    g_probing = 1;
    if (sigsetjmp(g_probeJmp, 1) == 0) {
        result = fn();
        g_probing = 0;
        return true;
    }
    g_probing = 0;
    result = false;
    return false;
}

intptr_t rawSyscall2(intptr_t num, intptr_t a1, intptr_t a2) {
#if defined(__x86_64__)
    intptr_t ret;
    __asm__ volatile(
        "syscall\n\t"
        "jnb 1f\n\t"
        "movq $-1, %%rax\n"
        "1:"
        : "=a"(ret)
        : "a"(num), "D"(a1), "S"(a2)
        : "rcx", "r11", "memory", "cc");
    return ret;
#else
    (void)num; (void)a1; (void)a2;
    return -1;
#endif
}

struct JailbreakBackup {
    uint32_t cr_uid, cr_ruid, cr_rgid, cr_groups;
    uint64_t cr_paid, cr_caps[2];
    void *cr_prison, *fd_cdir, *fd_jdir, *fd_rdir;
};

bool goldhenJailbreak() {
    JailbreakBackup backup{};
    return rawSyscall2(500, 2, (intptr_t)&backup) >= 0;
}

}

const std::string& lastError() { return g_error; }
void setLastError(const std::string& msg) { std::lock_guard<std::mutex> l(g_mutex); g_error = msg; }

bool fileExists(const std::string& path) {
    struct stat st;
    return stat(path.c_str(), &st) == 0;
}

std::string systemLanguage() {
    int v = -1;
    int rc = sceSystemServiceParamGetInt(1, &v);
    bootLogf("langue systeme: rc=0x%08x valeur=%d", (unsigned)rc, v);
    if (rc != 0) return "";
    if (v == 2 || v == 22) return "fr";
    if (v == 3 || v == 20) return "es";
    return "en";
}

static bool queryMount(const char* m, uint64_t& freeBytes, uint64_t& totalBytes) {
    struct statfs st;
    std::memset(&st, 0, sizeof st);
    if (statfs(m, &st) == 0) {
        const uint64_t bsize = static_cast<uint64_t>(st.f_bsize);
        const uint64_t freeB = static_cast<uint64_t>(st.f_bavail) * bsize;
        const uint64_t totalB = static_cast<uint64_t>(st.f_blocks) * bsize;
        bootLogf("disque: statfs(%s) bloc=%llu libres=%llu Mo total=%llu Mo", m, (unsigned long long)bsize, (unsigned long long)(freeB >> 20), (unsigned long long)(totalB >> 20));
        if (totalB > 0) { freeBytes = freeB; totalBytes = totalB; return true; }
    } else {
        bootLogf("disque: statfs(%s) a echoue", m);
    }
    return false;
}

bool getFreeDiskSpaceBytes(uint64_t& freeBytes, uint64_t* totalBytes) {
    uint64_t freeB = 0, totalB = 0;
    const char* mounts[] = {"/user", "/user/app", "/data"};
    bool ok = false;
    for (const char* m : mounts) if (queryMount(m, freeB, totalB)) { ok = true; break; }
    if (!ok) {
        for (const char* m : mounts) {
            struct statvfs sv;
            std::memset(&sv, 0, sizeof sv);
            if (statvfs(m, &sv) != 0) continue;
            const uint64_t bs = (sv.f_frsize > 0) ? static_cast<uint64_t>(sv.f_frsize) : static_cast<uint64_t>(sv.f_bsize);
            const uint64_t t = static_cast<uint64_t>(sv.f_blocks) * bs;
            if (t == 0) continue;
            freeB = static_cast<uint64_t>(sv.f_bavail) * bs; totalB = t; ok = true; break;
        }
    }
    if (!ok) return false;
    freeBytes = freeB;
    if (totalBytes) *totalBytes = totalB;
    return true;
}

int clearDirectory(const std::string& dir) {
    int removed = 0;
    if (DIR* d = opendir(dir.c_str())) {
        while (dirent* e = readdir(d)) {
            const std::string n = e->d_name;
            if (n == "." || n == "..") continue;
            if (std::remove((dir + "/" + n).c_str()) == 0) ++removed;
        }
        closedir(d);
    }
    return removed;
}

bool makeDirs(const std::string& path) {
    std::string cur;
    for (size_t i = 0; i <= path.size(); ++i) {
        if (i == path.size() || path[i] == '/') {
            if (!cur.empty() && !fileExists(cur)) {
#if defined(_WIN32)
                if (mkdir(cur.c_str()) != 0 && !fileExists(cur)) return false;
#else
                if (mkdir(cur.c_str(), 0777) != 0 && !fileExists(cur)) return false;
#endif
            }
        }
        if (i < path.size()) cur += path[i];
    }
    return true;
}

bool jailbreak() {
    bool ok = false;
    bool survived = guarded([] { return goldhenJailbreak(); }, ok);
    if (survived && ok) { bootLog("jailbreak: GoldHEN OK"); return true; }
    bootLogf("jailbreak: GoldHEN %s", survived ? "refuse (erreur du syscall)" : "a leve un signal (intercepte)");
#ifdef PS4STORE_HAVE_JBC
    survived = guarded([] {
        struct jbc_cred cred;
        return jbc_get_cred(&cred) == 0 && jbc_jailbreak_cred(&cred) == 0 && jbc_set_cred(&cred) == 0;
    }, ok);
    if (survived && ok) { bootLog("jailbreak: libjbc OK"); return true; }
    bootLogf("jailbreak: libjbc %s", survived ? "a echoue" : "a leve un signal (intercepte)");
    setLastError("Jailbreak impossible (GoldHEN absent, libjbc a echoue) : installation/DNS desactives");
#else
    setLastError("Jailbreak impossible : chargez GoldHEN (libjbc absente) - installation/DNS desactives");
#endif
    return false;
}

void bootLog(const char* msg) {
    std::lock_guard<std::mutex> l(g_mutex);
    char line[640];
    std::snprintf(line, sizeof line, "[%8.3f] %s\n", nowSeconds(), msg ? msg : "(null)");
    std::fputs(line, stderr);
    if (!g_logPath) {
        mkdir("/data/PS4Store", 0777);
        if (appendLine(kLogPrimary, line)) { g_logPath = kLogPrimary; }
        else if (appendLine(kLogFallback, line)) { g_logPath = kLogFallback; }
        else return;
        std::snprintf(g_crashPath, sizeof g_crashPath, "%s", g_logPath);
        return;
    }
    appendLine(g_logPath, line);
}

void bootLogf(const char* fmt, ...) {
    char buf[512];
    va_list ap; va_start(ap, fmt);
    std::vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    bootLog(buf);
}

void installCrashHandlers() {
    struct sigaction sa;
    std::memset(&sa, 0, sizeof sa);
    sa.__sa_handler.__sa_sigaction = reinterpret_cast<void (*)(int, struct __siginfo*, void*)>(fatalHandler);
    sa.sa_flags = SA_SIGINFO | SA_NODEFER;
    sigemptyset(&sa.sa_mask);
    const int sigs[] = {SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGABRT, SIGSYS};
    for (int s : sigs) {
        if (sigaction(s, &sa, nullptr) != 0) bootLogf("sigaction(%d) indisponible", s);
    }
    std::set_terminate(terminateHandler);
    bootLog("gestionnaires de crash installes");
}

void setCrashHook(void (*hook)()) { g_crashHook = hook; }

void logCaught(const char* where) {
    char desc[240];
    describeCurrentException(desc, sizeof desc);
    bootLogf("EXCEPTION rattrapee dans %s : %s", where ? where : "?", desc);
}

int loadSystemModules() {
    struct M { const char* name; uint32_t id; };
    static const M mods[] = {
        {"NET", ORBIS_SYSMODULE_INTERNAL_NET},
        {"NETCTL", ORBIS_SYSMODULE_INTERNAL_NETCTL},
        {"HTTP", ORBIS_SYSMODULE_INTERNAL_HTTP},
        {"SSL", ORBIS_SYSMODULE_INTERNAL_SSL},
        {"SYSTEM_SERVICE", ORBIS_SYSMODULE_INTERNAL_SYSTEM_SERVICE},
        {"USER_SERVICE", ORBIS_SYSMODULE_INTERNAL_USER_SERVICE},
        {"PAD", ORBIS_SYSMODULE_INTERNAL_PAD},
        {"APP_INST_UTIL", ORBIS_SYSMODULE_INTERNAL_APP_INST_UTIL},
        {"BGFT", ORBIS_SYSMODULE_INTERNAL_BGFT},
    };
    int failed = 0;
    for (const M& m : mods) {
        bootLogf("sysmodule %s: chargement...", m.name);
        int rc = (int)sceSysmoduleLoadModuleInternal((OrbisSysModuleInternal)m.id);
        bootLogf("sysmodule %s: rc=0x%08X%s", m.name, (unsigned)rc, rc < 0 ? "  (ECHEC, non fatal)" : "");
        if (rc < 0) ++failed;
    }
    return failed;
}

bool loadModule(const char* path) {
    std::lock_guard<std::mutex> l(g_mutex);
    if (g_modules.count(path)) return true;
    int h = sceKernelLoadStartModule(path, 0, nullptr, 0, nullptr, nullptr);
    if (h < 0) { g_error = std::string("Module introuvable : ") + path; return false; }
    g_modules[path] = h;
    return true;
}

void* resolveSymbol(const char* modulePath, const char* symbol) {
    if (!loadModule(modulePath)) return nullptr;
    int handle;
    {
        std::lock_guard<std::mutex> l(g_mutex);
        handle = g_modules[modulePath];
    }
    void* addr = nullptr;
    if (sceKernelDlsym(handle, symbol, &addr) != 0) return nullptr;
    return addr;
}

bool getForegroundTitleId(std::string& out) {
    using GetAppId = int (*)();
    using GetTitleId = int (*)(int, char*);
    static GetAppId getAppId = nullptr;
    static GetTitleId getTitle = nullptr;
    static bool tried = false;
    if (!tried) {
        tried = true;
        const char* mod = "/system/common/lib/libSceSystemService.sprx";
        getAppId = reinterpret_cast<GetAppId>(resolveSymbol(mod, "sceSystemServiceGetAppIdOfRunningBigApp"));
        getTitle = reinterpret_cast<GetTitleId>(resolveSymbol(mod, "sceSystemServiceGetAppTitleId"));
        bootLogf("premier plan: GetAppIdOfRunningBigApp=%s GetAppTitleId=%s", getAppId ? "ok" : "absent", getTitle ? "ok" : "absent");
    }
    if (!getAppId || !getTitle) return false;
    const int appId = getAppId();
    if (appId <= 0) return false;
    char buf[64];
    std::memset(buf, 0, sizeof buf);
    if (getTitle(appId, buf) != 0) return false;
    buf[16] = 0;
    std::string t = buf;
    if (t.size() != 9) return false;
    for (size_t i = 0; i < 9; ++i) if (!((i < 4) ? (t[i] >= 'A' && t[i] <= 'Z') : (t[i] >= '0' && t[i] <= '9'))) return false;
    out = t;
    return true;
}

namespace { int g_httpCtx = -1; }

namespace {
struct SysEventBuf { uint32_t type; uint8_t data[8192]; };
struct SysStatusBuf { int32_t eventNum; uint8_t isSystemUiOverlaid, isInBackgroundExecution, rest[122]; };
static_assert(sizeof(SysStatusBuf) == 128, "tampon de statut inattendu");

constexpr uint32_t kEvtOnResume = 0x10000000u;
#ifdef PS4STORE_EVT_ON_PAUSE
constexpr uint32_t kEvtOnPause = (uint32_t)(PS4STORE_EVT_ON_PAUSE);
constexpr bool kHasOnPause = true;
#else
constexpr uint32_t kEvtOnPause = 0;
constexpr bool kHasOnPause = false;
#endif
}

SystemEvent pollSystemEvent(uint32_t* rawType) {
    static SysEventBuf ev;
    std::memset(&ev, 0, sizeof ev.type);
    int rc = sceSystemServiceReceiveEvent(&ev);
    if (rc != 0) return SystemEvent::None;
    if (rawType) *rawType = ev.type;
    if (ev.type == kEvtOnResume) return SystemEvent::Resume;
    if (kHasOnPause && ev.type == kEvtOnPause) return SystemEvent::Pause;
    static int logged = 0;
    if (logged < 32) { ++logged; bootLogf("evenement systeme non gere: type=0x%08X", (unsigned)ev.type); }
    return SystemEvent::Other;
}

bool inBackground() {
    static SysStatusBuf st;
    std::memset(&st, 0, sizeof st);
    if (sceSystemServiceGetStatus(&st) != 0) return false;
    return st.isInBackgroundExecution == 1;
}

int httpContextId() { return g_httpCtx; }

bool initNetwork() {
    typedef int (*NetInit)();
    typedef int (*NetPoolCreate)(const char*, int, int);
    typedef int (*SslInit)(size_t);
    typedef int (*HttpInit)(int, int, size_t);

    const char* kNet = "/system/common/lib/libSceNet.sprx";
    auto netInit = (NetInit)resolveSymbol(kNet, "sceNetInit");
    auto poolCreate = (NetPoolCreate)resolveSymbol(kNet, "sceNetPoolCreate");
    if (!netInit || !poolCreate) { setLastError("Pile réseau indisponible"); return false; }
    if (netInit() < 0) { setLastError("sceNetInit a échoué"); return false; }
    int pool = poolCreate("ps4store", 256 * 1024, 0);
    if (pool < 0) { setLastError("sceNetPoolCreate a échoué"); return false; }

    auto sslInit = (SslInit)resolveSymbol("/system/common/lib/libSceSsl.sprx", "sceSslInit");
    int sslCtx = sslInit ? sslInit(256 * 1024) : -1;
    auto httpInit = (HttpInit)resolveSymbol("/system/common/lib/libSceHttp.sprx", "sceHttpInit");
    if (httpInit && sslCtx >= 0) {
        int ctx = httpInit(pool, sslCtx, 256 * 1024);
        if (ctx >= 0) g_httpCtx = ctx;
    }
    return true;
}

}
