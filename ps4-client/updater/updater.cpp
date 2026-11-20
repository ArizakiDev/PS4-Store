#include <orbis/Sysmodule.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <sys/stat.h>

#define UPDATE_PKG "/data/PS4Store/update/PS4Store_update.pkg"
#define APP_PKG    "/user/app/PSTR00001/app.pkg"
#define LOG_FILE   "/data/PS4Store/updater.log"

namespace {
struct LaunchParam {
    uint32_t size;
    uint32_t userId;
    uint32_t appOpt;
    uint64_t crashReport;
    int32_t  checkFlag;
};
}

extern "C" {
int sceKernelUsleep(unsigned int microseconds);
int sceAppInstUtilInitialize(void);
int sceAppInstUtilAppInstallPkg(const char* pkgPath, void* reserved);
int sceUserServiceInitialize(void* params);
int sceUserServiceGetForegroundUser(int* userId);
int sceSystemServiceLaunchApp(const char* titleId, const char* const* argv, LaunchParam* param);
}

static void logLine(const char* fmt, long a = 0) {
    if (FILE* f = std::fopen(LOG_FILE, "a")) { std::fprintf(f, fmt, a); std::fputc('\n', f); std::fclose(f); }
}

static long mtimeOf(const char* path) {
    struct stat st;
    return stat(path, &st) == 0 ? (long)st.st_mtime : 0;
}

int main(int, char**) {
    logLine("updater: demarrage");
    sceSysmoduleLoadModuleInternal(ORBIS_SYSMODULE_INTERNAL_SYSTEM_SERVICE);
    sceSysmoduleLoadModuleInternal(ORBIS_SYSMODULE_INTERNAL_USER_SERVICE);
    sceSysmoduleLoadModuleInternal(ORBIS_SYSMODULE_INTERNAL_APP_INST_UTIL);

    sceKernelUsleep(1500000);

    const long before = mtimeOf(APP_PKG);
    sceAppInstUtilInitialize();
    int rc = sceAppInstUtilAppInstallPkg(UPDATE_PKG, nullptr);
    logLine("updater: AppInstallPkg rc=0x%08lX", (long)(unsigned)rc);

    bool installed = false;
    if (rc == 0) {
        for (int i = 0; i < 90 && !installed; ++i) {
            sceKernelUsleep(1000000);
            const long now = mtimeOf(APP_PKG);
            installed = now != 0 && now != before;
        }
        logLine(installed ? "updater: installation terminee" : "updater: fin d'installation non confirmee (delai)");
    }
    if (installed) std::remove(UPDATE_PKG);

    int user = 0;
    sceUserServiceGetForegroundUser(&user);
    LaunchParam p;
    std::memset(&p, 0, sizeof p);
    p.size = sizeof p;
    p.userId = (uint32_t)user;
    rc = sceSystemServiceLaunchApp("PSTR00001", nullptr, &p);
    logLine("updater: LaunchApp rc=0x%08lX", (long)(unsigned)rc);
    return 0;
}
