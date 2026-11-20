#include "self_updater.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <sys/stat.h>

#include "appinfo.h"
#include "http.h"
#include "installed.h"
#include "installer.h"
#include "json.h"
#include "platform.h"

extern "C" {
int sceSystemServiceLoadExec(const char* path, const char* const* argv);
}

namespace {
bool fileSize(const std::string& path, unsigned long long& size) {
    struct stat st;
    if (stat(path.c_str(), &st) != 0) return false;
    size = (unsigned long long)st.st_size;
    return true;
}
}

SelfUpdater::~SelfUpdater() {
    http::abortAll();
    join();
}

void SelfUpdater::check(bool force) {
    if (state_ == State::Checking || state_ == State::Downloading) return;
    auto now = std::chrono::steady_clock::now();
    if (!force && everChecked_ && now - lastCheck_ < std::chrono::minutes(30)) return;
    if (state_ == State::Ready && !force) return;
    join();
    everChecked_ = true;
    lastCheck_ = now;
    state_ = State::Checking;
    progress_ = -1.f;
    th_ = std::thread([this] {
        try { run(); }
        catch (...) {
            platform::logCaught("self_updater");
            { std::lock_guard<std::mutex> l(m_); error_ = "Erreur interne"; }
            state_ = State::Failed;
        }
    });
}

SelfUpdater::Info SelfUpdater::info() const { std::lock_guard<std::mutex> l(m_); return info_; }
std::string SelfUpdater::error() const { std::lock_guard<std::mutex> l(m_); return error_; }

bool SelfUpdater::canApply(std::string& err) const {
    unsigned long long a = 0, b = 0;
    if (!fileSize(kUpdatePkg, a) || a == 0) { err = std::string("Paquet de mise a jour absent : ") + kUpdatePkg; return false; }
    if (!fileSize(kUpdaterElf, b) || b == 0) { err = std::string("updater.elf absent : ") + kUpdaterElf; return false; }
    return true;
}

void SelfUpdater::run() {
    std::string body, err;
    long code = http::get(server_ + "/api/client-version", body, err, 15);
    json::Object o;
    if (code != 200 || !json::parseObject(body, o) || o["version"].empty()) {
        const std::string reason = code == 404 ? "Le serveur ne propose pas de mise a jour" : !err.empty() ? err : "Reponse invalide du serveur";
        platform::bootLogf("self_updater: verification impossible code=%ld (%s)", code, reason.c_str());
        { std::lock_guard<std::mutex> l(m_); error_ = reason; }
        state_ = State::Failed;
        return;
    }
    Info i;
    i.version = o["version"];
    const std::string& path = o["pkg_path"];
    i.pkgUrl = !path.empty() && path[0] == '/' ? server_ + path : server_ + "/store/PS4Store.pkg";
    i.notes = o["notes"].empty() ? o["changelog"] : o["notes"];
    const unsigned long long expected = (unsigned long long)std::strtoull(o["file_size"].c_str(), nullptr, 10);
    const bool newer = installed::compareVersions(APP_VERSION, i.version) < 0;
    platform::bootLogf("self_updater: installee=%s serveur=%s -> %s", APP_VERSION, i.version.c_str(), newer ? "MISE A JOUR" : "a jour");
    { std::lock_guard<std::mutex> l(m_); info_ = i; error_.clear(); }

    if (!newer) {
        std::remove(kUpdatePkg);
        state_ = State::UpToDate;
        return;
    }

    unsigned long long have = 0;
    if (expected > 0 && fileSize(kUpdatePkg, have) && have == expected) {
        platform::bootLog("self_updater: paquet deja telecharge");
        state_ = State::Ready;
        return;
    }

    if (!platform::makeDirs(kUpdateDir)) { { std::lock_guard<std::mutex> l(m_); error_ = "Dossier de mise a jour inaccessible"; } state_ = State::Failed; return; }
    std::remove(kUpdatePkg);
    state_ = State::Downloading;
    progress_ = 0.f;
    uint64_t total = 0;
    code = http::downloadToFile(i.pkgUrl, kUpdatePkg, total, [this](uint64_t done, uint64_t all) {
        progress_ = all > 0 ? (float)((double)done / (double)all) : -1.f;
    }, nullptr, err);
    if (code != 200) {
        platform::bootLogf("self_updater: telechargement echoue code=%ld (%s)", code, err.c_str());
        { std::lock_guard<std::mutex> l(m_); error_ = err.empty() ? "HTTP " + std::to_string(code) : err; }
        state_ = State::Failed;
        return;
    }

    unsigned long long got = 0;
    fileSize(kUpdatePkg, got);
    std::string head, herr;
    bool ok = got > 0 && (expected == 0 || got == expected);
    if (ok) {
        if (FILE* f = std::fopen(kUpdatePkg, "rb")) {
            char buf[installer::HEADER_BYTES];
            size_t n = std::fread(buf, 1, sizeof buf, f);
            std::fclose(f);
            head.assign(buf, n);
        }
        installer::PkgHeader hdr;
        ok = installer::parseHeader(head, hdr, herr) && hdr.contentId.find(APP_TITLE_ID) != std::string::npos && std::string(hdr.type) == "PS4GD";
        if (!ok && herr.empty()) herr = "Le paquet ne correspond pas a PS4Store";
    } else herr = "Paquet incomplet";
    if (!ok) {
        std::remove(kUpdatePkg);
        { std::lock_guard<std::mutex> l(m_); error_ = herr; }
        platform::bootLogf("self_updater: paquet refuse (%s)", herr.c_str());
        state_ = State::Failed;
        return;
    }
    platform::bootLogf("self_updater: v%s prete (%llu octets)", i.version.c_str(), got);
    progress_ = 1.f;
    state_ = State::Ready;
}

bool SelfUpdater::installUpdaterElf(const std::string& bytes) {
    if (bytes.empty()) return false;
    unsigned long long cur = 0;
    if (fileSize(kUpdaterElf, cur) && cur == bytes.size()) return true;
    platform::makeDirs("/data/PS4Store");
    const std::string tmp = std::string(kUpdaterElf) + ".tmp";
    FILE* f = std::fopen(tmp.c_str(), "wb");
    if (!f) return false;
    bool ok = std::fwrite(bytes.data(), 1, bytes.size(), f) == bytes.size();
    ok = (std::fclose(f) == 0) && ok;
    if (!ok) { std::remove(tmp.c_str()); return false; }
    chmod(tmp.c_str(), 0777);
    std::remove(kUpdaterElf);
    return std::rename(tmp.c_str(), kUpdaterElf) == 0;
}

bool SelfUpdater::launchUpdaterAndExit() {
    installer::shutdown();
    platform::bootLog("self_updater: lancement de updater.elf puis sortie");
    const char* const argv[] = {kUpdaterElf, nullptr};
    int rc = sceSystemServiceLoadExec(kUpdaterElf, argv);
    platform::bootLogf("self_updater: LoadExec(updater.elf) rc=0x%08X -> sortie simple", (unsigned)rc);
    sceSystemServiceLoadExec("exit", nullptr);
    return false;
}
