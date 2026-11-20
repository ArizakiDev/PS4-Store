#include "installed.h"

#include <algorithm>
#include <chrono>
#include <dirent.h>
#include <set>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <sys/stat.h>

#include "installer.h"
#include "i18n.h"
#include "platform.h"

namespace {
struct LaunchParam {
    uint32_t size;
    uint32_t userId;
    uint32_t appOpt;
    uint64_t crashReport;
    int32_t  checkFlag;
};
static_assert(sizeof(LaunchParam) == 32, "disposition inattendue de LncAppParam");
}

extern "C" {
int sceAppInstUtilAppUnInstall(const char* titleId);
int sceUserServiceGetForegroundUser(int* userId);
int sceSystemServiceLaunchApp(const char* titleId, const char* const* argv, LaunchParam* param);
}

namespace installed {
namespace {

bool fileExists(const std::string& p) {
    struct stat st;
    return stat(p.c_str(), &st) == 0;
}

bool readSmallFile(const std::string& path, std::string& out) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return false;
    std::stringstream ss; ss << in.rdbuf();
    out = ss.str();
    return !out.empty();
}

std::string hexErr(const char* what, int rc) {
    char b[128];
    std::snprintf(b, sizeof b, "%s (0x%08X)", what, (unsigned)rc);
    return b;
}

bool validTitleId(const std::string& id) {
    if (id.empty() || id.size() > 16) return false;
    for (char c : id)
        if (!((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_')) return false;
    return true;
}

std::string pkgPath(const std::string& id) { return "/user/app/" + id + "/app.pkg"; }

std::vector<std::string> sfoCandidates(const std::string& id) {
    return {
        "/system_data/priv/app/" + id + "/sce_sys/param.sfo",
        "/user/appmeta/" + id + "/param.sfo",
        "/system_data/priv/appmeta/" + id + "/param.sfo",
        "/user/app/" + id + "/sce_sys/param.sfo",
    };
}

std::string upper(std::string s) {
    for (char& c : s) if (c >= 'a' && c <= 'z') c = (char)(c - 32);
    while (!s.empty() && (s.back() == ' ' || s.back() == '\r' || s.back() == '\n')) s.pop_back();
    size_t a = s.find_first_not_of(' ');
    return a == std::string::npos ? std::string() : s.substr(a);
}

bool listDir(const char* dir, std::set<std::string>& out) {
    DIR* d = opendir(dir);
    if (!d) return false;
    while (dirent* e = readdir(d)) {
        std::string n = e->d_name;
        if (n == "." || n == "..") continue;
        out.insert(upper(n));
    }
    closedir(d);
    return true;
}

std::set<std::string> consoleTitleIds() {
    std::set<std::string> ids;
    if (listDir("/user/app", ids)) platform::bootLogf("installes: /user/app lu (%u entrees)", (unsigned)ids.size());
    else {
        platform::bootLog("installes: /user/app illisible, repli sur les metadonnees");
        listDir("/user/appmeta", ids);
        listDir("/system_data/priv/appmeta", ids);
        listDir("/system_data/priv/app", ids);
    }
    std::string all;
    for (const auto& i : ids) { if (all.size() > 380) { all += " ..."; break; } all += i + " "; }
    platform::bootLogf("installes: titres sur la console: %s", all.c_str());
    return ids;
}

uint32_t le32(const std::string& s, size_t o) {
    return (uint32_t)(unsigned char)s[o] | ((uint32_t)(unsigned char)s[o + 1] << 8) |
           ((uint32_t)(unsigned char)s[o + 2] << 16) | ((uint32_t)(unsigned char)s[o + 3] << 24);
}
uint16_t le16(const std::string& s, size_t o) {
    return (uint16_t)((unsigned char)s[o] | ((unsigned char)s[o + 1] << 8));
}

bool sfoString(const std::string& sfo, const char* key, std::string& out) {
    if (sfo.size() < 0x14 || sfo.compare(0, 4, std::string("\0PSF", 4)) != 0) return false;
    const uint32_t keyOff = le32(sfo, 8), dataOff = le32(sfo, 12), count = le32(sfo, 16);
    if (count > 512 || keyOff >= sfo.size() || dataOff >= sfo.size()) return false;
    for (uint32_t i = 0; i < count; ++i) {
        const size_t e = 0x14 + (size_t)i * 16;
        if (e + 16 > sfo.size()) return false;
        const size_t kpos = (size_t)keyOff + le16(sfo, e);
        if (kpos >= sfo.size()) return false;
        size_t kend = sfo.find('\0', kpos);
        if (kend == std::string::npos) return false;
        if (sfo.compare(kpos, kend - kpos, key) != 0 || kend - kpos != std::strlen(key)) continue;
        const uint16_t fmt = le16(sfo, e + 2);
        const uint32_t len = le32(sfo, e + 4);
        const size_t dpos = (size_t)dataOff + le32(sfo, e + 12);
        if (fmt != 0x0004 && fmt != 0x0204) return false;
        if (dpos >= sfo.size() || len == 0 || dpos + len > sfo.size()) return false;
        out.assign(sfo, dpos, len);
        size_t z = out.find('\0');
        if (z != std::string::npos) out.resize(z);
        return !out.empty();
    }
    return false;
}

}

bool parseSfoVersion(const std::string& sfo, std::string& version) {
    return sfoString(sfo, "VERSION", version) || sfoString(sfo, "APP_VER", version);
}

int compareVersions(const std::string& a, const std::string& b) {
    auto split = [](const std::string& s) {
        std::vector<int> v;
        std::string cur;
        for (char c : s) {
            if (c >= '0' && c <= '9') cur += c;
            else if (c == '.') { v.push_back(cur.empty() ? 0 : std::atoi(cur.c_str())); cur.clear(); }
        }
        if (!cur.empty() || v.empty()) v.push_back(cur.empty() ? 0 : std::atoi(cur.c_str()));
        return v;
    };
    std::vector<int> x = split(a), y = split(b);
    const size_t n = std::max(x.size(), y.size());
    for (size_t i = 0; i < n; ++i) {
        int xi = i < x.size() ? x[i] : 0, yi = i < y.size() ? y[i] : 0;
        if (xi != yi) return xi < yi ? -1 : 1;
    }
    return 0;
}

State classify(const Game& g, const Entry* e) {
    if (!e || !e->installed) return State::NotInstalled;
    if (!e->version.empty() && !g.version.empty() && compareVersions(e->version, g.version) < 0)
        return State::UpdateAvailable;
    return State::UpToDate;
}


Manager::~Manager() {
    quit_ = true;
    join(scanThread_);
    join(actionThread_);
}

Manager::Event Manager::lastEvent() const { std::lock_guard<std::mutex> l(m_); return event_; }

void Manager::post(bool ok, const std::string& msg) {
    std::lock_guard<std::mutex> l(m_);
    event_.ok = ok;
    event_.message = msg;
    ++event_.serial;
}

bool Manager::snapshot(std::map<std::string, Entry>& out, unsigned& lastVersion) const {
    std::lock_guard<std::mutex> l(m_);
    if (lastVersion == version_) return false;
    out = entries_;
    lastVersion = version_;
    return true;
}

void Manager::refresh(const std::vector<std::string>& titleIds) {
    if (scanning_.load()) return;
    join(scanThread_);
    scanning_ = true;
    scanThread_ = std::thread([this, titleIds] {
        try { scan(titleIds, false); }
        catch (...) { platform::logCaught("installed_scan"); }
        scanning_ = false;
    });
}

void Manager::scan(std::vector<std::string> ids, bool merge) {
    std::map<std::string, Entry> found;
    const std::set<std::string> onConsole = consoleTitleIds();
    for (const std::string& id : ids) {
        if (quit_) return;
        if (!validTitleId(id)) continue;
        Entry e;
        const bool hasPkg = onConsole.count(upper(id)) > 0;
        std::string sfo, sfoUsed;
        if (hasPkg)
            for (const std::string& p : sfoCandidates(id)) {
                if (readSmallFile(p, sfo) && parseSfoVersion(sfo, e.version)) { sfoUsed = p; break; }
                e.version.clear();
            }
        e.installed = hasPkg;
        platform::bootLogf("installes: site=%s sur_console=%s param.sfo=%s version=%s", id.c_str(), hasPkg ? "oui" : "non",
                           sfoUsed.empty() ? "introuvable" : sfoUsed.c_str(), e.version.empty() ? "?" : e.version.c_str());
        found[id] = std::move(e);
    }
    std::lock_guard<std::mutex> l(m_);
    bool changed = !merge && found.size() != entries_.size();
    for (const auto& kv : found) {
        auto it = entries_.find(kv.first);
        if (it == entries_.end() || it->second.installed != kv.second.installed ||
            it->second.version != kv.second.version) { changed = true; break; }
    }
    if (!changed) return;
    if (merge) { for (auto& kv : found) entries_[kv.first] = std::move(kv.second); }
    else entries_ = std::move(found);
    ++version_;
}

void Manager::launch(const std::string& titleId, const std::string& name) {
    if (busy_.load()) return;
    join(actionThread_);
    busy_ = true;
    actionThread_ = std::thread([this, titleId, name] {
        try {
            if (!validTitleId(titleId)) { post(false, "Identifiant de titre invalide"); busy_ = false; return; }
            int user = 0;
            sceUserServiceGetForegroundUser(&user);
            LaunchParam p;
            std::memset(&p, 0, sizeof p);
            p.size = sizeof p;
            p.userId = (uint32_t)user;
            if (launchedHook_) launchedHook_(titleId, name);
            if (beforeLaunch_) beforeLaunch_();
            int rc = sceSystemServiceLaunchApp(titleId.c_str(), nullptr, &p);
            platform::bootLogf("installes: LaunchApp(%s) rc=0x%08X", titleId.c_str(), (unsigned)rc);
            if (rc != 0) {
                if (launchFailed_) launchFailed_();
                post(false, hexErr(("Lancement de « " + name + " » refusé").c_str(), rc));
            } else post(true, i18n::tr("ps4.launching", {{"name", name}}));
        } catch (...) {
            platform::logCaught("installed_launch");
            post(false, "Erreur interne pendant le lancement");
        }
        busy_ = false;
    });
}

void Manager::uninstall(const std::string& titleId, const std::string& name) {
    if (busy_.load()) return;
    join(actionThread_);
    busy_ = true;
    actionThread_ = std::thread([this, titleId, name] {
        try {
            if (!validTitleId(titleId)) { post(false, "Identifiant de titre invalide"); busy_ = false; return; }
            std::string err;
            if (!installer::init(err)) { post(false, err); busy_ = false; return; }
            int rc = sceAppInstUtilAppUnInstall(titleId.c_str());
            if (rc != 0) {
                post(false, hexErr(("Désinstallation de « " + name + " » refusée").c_str(), rc));
                busy_ = false;
                return;
            }
            for (int i = 0; i < 20 && !quit_ && fileExists(pkgPath(titleId)); ++i)
                std::this_thread::sleep_for(std::chrono::milliseconds(500));
            post(true, i18n::tr("ps4.uninstalled", {{"name", name}}));
            scan({titleId}, true);
        } catch (...) {
            platform::logCaught("installed_uninstall");
            post(false, "Erreur interne pendant la désinstallation");
        }
        busy_ = false;
    });
}

std::vector<std::string> listConsoleTitles() {
    const std::set<std::string> ids = consoleTitleIds();
    return std::vector<std::string>(ids.begin(), ids.end());
}

bool isTitleInstalled(const std::string& titleId) {
    if (!validTitleId(titleId)) return false;
    return platform::fileExists(pkgPath(titleId));
}

}
