#include "updater.h"

#include "appinfo.h"
#include "http.h"
#include "installed.h"
#include "json.h"
#include "platform.h"

void Updater::check(bool force) {
    if (state_ == State::Checking) return;
    auto now = std::chrono::steady_clock::now();
    if (!force && everChecked_ && now - lastCheck_ < std::chrono::minutes(30)) return;
    join();
    everChecked_ = true;
    lastCheck_ = now;
    state_ = State::Checking;
    th_ = std::thread([this] {
        try { run(); }
        catch (...) {
            platform::logCaught("updater");
            { std::lock_guard<std::mutex> l(m_); error_ = "Erreur interne"; }
            state_ = State::Failed;
        }
    });
}

Updater::Info Updater::info() const { std::lock_guard<std::mutex> l(m_); return info_; }
std::string Updater::error() const { std::lock_guard<std::mutex> l(m_); return error_; }

Game Updater::asGame() const {
    Info i = info();
    Game g;
    g.id = kSelfUpdateId;
    g.title_id = APP_TITLE_ID;
    g.titre = "PS4Store " + i.version;
    g.version = i.version;
    g.pkg_url = i.pkgUrl;
    return g;
}

void Updater::run() {
    std::string body, err;
    long code = http::get(server_ + "/api/client/latest", body, err, 15);
    json::Object o;
    if (code != 200 || !json::parseObject(body, o) || o["version"].empty()) {
        std::string reason = code == 404 ? "Le serveur ne propose pas de mise à jour (/api/client/latest)"
                           : !err.empty() ? err : "Réponse invalide du serveur";
        platform::bootLogf("updater: echec code=%ld (%s)", code, reason.c_str());
        { std::lock_guard<std::mutex> l(m_); error_ = reason; }
        state_ = State::Failed;
        return;
    }
    Info i;
    i.version = o["version"];
    const std::string& path = o["pkg_path"];
    i.pkgUrl = !path.empty() && path[0] == '/' ? server_ + path
             : o["pkg_url"].empty() ? server_ + "/store/PS4Store.pkg" : o["pkg_url"];
    i.notes = o["notes"].empty() ? o["changelog"] : o["notes"];
    const bool newer = installed::compareVersions(APP_VERSION, i.version) < 0;
    platform::bootLogf("updater: installee=%s serveur=%s -> %s", APP_VERSION, i.version.c_str(),
                       newer ? "MISE A JOUR DISPONIBLE" : "a jour");
    { std::lock_guard<std::mutex> l(m_); info_ = i; error_.clear(); }
    state_ = newer ? State::Available : State::UpToDate;
}
