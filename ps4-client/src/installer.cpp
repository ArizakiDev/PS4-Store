#include "installer.h"

#include <cstdio>
#include <cstring>
#include <strings.h>

#include "platform.h"

namespace {

struct BgftInit { void* heap; size_t heapSize; };

struct BgftParam {
    int userId, entitlementType;
    const char *id, *contentUrl, *contentExUrl, *contentName, *iconPath, *skuId;
    int option;
    const char *playgoScenarioId, *releaseDate, *packageType, *packageSubType;
    unsigned long packageSize;
};

struct BgftProgress {
    unsigned bits;
    int errorResult;
    unsigned long length, transferred, lengthTotal, transferredTotal;
    unsigned numIndex, numTotal, restSec, restSecTotal;
    int preparingPercent, localCopyPercent;
};

constexpr int BGFT_ENTITLEMENT_NONE = 5;
constexpr int BGFT_OPTION_DISABLE_CDN_QUERY_PARAM = 0x10000;

}

extern "C" {
int sceBgftServiceInit(BgftInit*);
int sceBgftServiceTerm(void);
int sceBgftServiceIntDownloadRegisterTask(BgftParam*, int* task);
int sceBgftServiceDownloadStartTask(int task);
int sceBgftServiceDownloadStopTask(int task);
int sceBgftServiceDownloadGetProgress(int task, BgftProgress*);
int sceAppInstUtilInitialize(void);
int sceAppInstUtilAppInstallPkg(const char* pkgPath, void* reserved);
int sceUserServiceGetForegroundUser(int* userId);
}

namespace installer {
namespace {

bool g_ready = false;
alignas(16) char g_heap[1 << 20];

uint64_t be(const std::string& s, size_t off, int bytes) {
    uint64_t v = 0;
    for (int i = 0; i < bytes; ++i) v = (v << 8) | (unsigned char)s[off + i];
    return v;
}

std::string hexErr(const char* what, int rc) {
    char b[96];
    std::snprintf(b, sizeof b, "%s (0x%08X)", what, (unsigned)rc);
    return b;
}

}

bool parseHeader(const std::string& hdr, PkgHeader& out, std::string& err) {
    if (hdr.size() < 0x440 || hdr.compare(0, 4, "\x7F" "CNT") != 0) {
        err = "Le lien ne pointe pas vers un fichier .pkg PS4 valide";
        return false;
    }
    out.contentId = hdr.substr(0x40, 36);
    for (char c : out.contentId)
        if (c < 0x20 || c > 0x7E) { err = "En-tête .pkg illisible (content id)"; return false; }

    switch (be(hdr, 0x74, 4)) {
        case 0x1A: out.type = "PS4GD"; break;
        case 0x1B: out.type = "PS4AC"; break;
        case 0x1C: out.type = "PS4AL"; break;
        case 0x1E: out.type = "PS4DP"; break;
        default: err = "Type de paquet non pris en charge"; return false;
    }
    out.flags = (uint32_t)be(hdr, 0x78, 4);
    out.size = be(hdr, 0x430, 8);
    if (out.size == 0) { err = "Taille du paquet nulle dans l'en-tête"; return false; }
    return true;
}

std::string bgftUrl(const std::string& url, const std::string& contentId) {
    if (url.size() >= 4 && strcasecmp(url.c_str() + url.size() - 4, ".pkg") == 0) return url;
    return url + (url.find('?') == std::string::npos ? "?" : "&") + "f=" + contentId + ".pkg";
}

bool init(std::string& err) {
    if (g_ready) return true;
    platform::loadModule("/system/common/lib/libSceSystemService.sprx");
    platform::loadModule("/system/common/lib/libSceAppInstUtil.sprx");
    if (!platform::loadModule("/system/common/lib/libSceBgft.sprx")) {
        err = "Service BGFT indisponible (jailbreak actif ?)";
        return false;
    }
    int rc = sceAppInstUtilInitialize();
    if (rc != 0) {
        err = hexErr("sceAppInstUtilInitialize a échoué", rc);
        return false;
    }
    BgftInit bi{g_heap, sizeof g_heap};
    rc = sceBgftServiceInit(&bi);
    if (rc != 0) {
        err = hexErr("sceBgftServiceInit a échoué", rc);
        return false;
    }
    g_ready = true;
    return true;
}

bool installLocalPkg(const std::string& path, std::string& err) {
    if (!g_ready && !init(err)) return false;
    int rc = sceAppInstUtilAppInstallPkg(path.c_str(), nullptr);
    if (rc != 0) { err = hexErr("sceAppInstUtilAppInstallPkg a échoué", rc); return false; }
    return true;
}

void shutdown() {
    if (!g_ready) return;
    sceBgftServiceTerm();
    g_ready = false;
}

bool registerAndStart(const PkgHeader& hdr, const std::string& url, const std::string& name,
                      const std::string& iconPath, int& taskId, std::string& err) {
    if (!g_ready && !init(err)) return false;

    std::string finalUrl = bgftUrl(url, hdr.contentId);
    int user = 0;
    sceUserServiceGetForegroundUser(&user);

    BgftParam p;
    std::memset(&p, 0, sizeof p);
    p.userId = user;
    p.entitlementType = BGFT_ENTITLEMENT_NONE;
    p.id = hdr.contentId.c_str();
    p.contentUrl = finalUrl.c_str();
    p.contentName = name.c_str();
    p.iconPath = iconPath.c_str();
    p.playgoScenarioId = "0";
    p.option = BGFT_OPTION_DISABLE_CDN_QUERY_PARAM;
    p.packageType = hdr.type;
    p.packageSubType = "";
    p.packageSize = (unsigned long)hdr.size;

    taskId = -1;
    int rc = sceBgftServiceIntDownloadRegisterTask(&p, &taskId);
    if (rc != 0) {
        unsigned u = (unsigned)rc;
        if (u == 0x80990088u || u == 0x80990015u || u == 0x80990086u)
            err = "Ce titre est déjà en cours d'installation ou déjà présent sur la console";
        else
            err = hexErr("Enregistrement de la tâche refusé", rc);
        return false;
    }
    rc = sceBgftServiceDownloadStartTask(taskId);
    if (rc != 0) {
        err = hexErr("Démarrage de la tâche refusé", rc);
        return false;
    }
    return true;
}

bool progress(int taskId, Progress& out) {
    BgftProgress bp;
    std::memset(&bp, 0, sizeof bp);
    if (sceBgftServiceDownloadGetProgress(taskId, &bp) != 0) return false;
    out.length = bp.length;
    out.transferred = bp.transferred;
    out.error = bp.errorResult;
    out.preparingPercent = bp.preparingPercent;
    return true;
}

void stopTask(int taskId) { sceBgftServiceDownloadStopTask(taskId); }

}
