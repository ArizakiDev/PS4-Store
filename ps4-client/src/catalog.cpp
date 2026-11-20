#include "catalog.h"

#include "config.h"
#include "http.h"
#include "json.h"
#include "platform.h"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>

namespace {

std::string field(const json::Object& o, const char* key) {
    auto it = o.find(key);
    return it == o.end() ? std::string() : it->second;
}

}

bool gameFromObject(const json::Object& o, Game& out) {
    Game g;
    g.id = field(o, "id");
    g.title_id = field(o, "title_id");
    g.titre = field(o, "titre");
    g.description = field(o, "description");
    g.version = field(o, "version");
    g.firmware_min = field(o, "firmware_min");
    g.categorie = field(o, "categorie");
    g.icon_url = field(o, "icon_url");
    g.pkg_url = field(o, "pkg_url");
    g.size = field(o, "size");
    g.resource_type = field(o, "resource_type");
    if (g.resource_type != "update" && g.resource_type != "dlc" && g.resource_type != "plugin" && g.resource_type != "payload")
        g.resource_type = "pkg";
    g.parent_title_id = field(o, "parent_title_id");
    g.changelog_latest = field(o, "changelog_latest");
    g.regions = field(o, "regions");
    if (g.regions != "EU" && g.regions != "US") g.regions = "BOTH";
    g.target_type = field(o, "target_type");
    for (int k = 0; k < 2; ++k) {
        const std::string p = k == 0 ? "eu_" : "us_";
        Game::Region& r = k == 0 ? g.eu : g.us;
        r.title_id = field(o, (p + "title_id").c_str());
        r.install_dir = field(o, (p + "install_dir").c_str());
        r.filename = field(o, (p + "filename").c_str());
        r.ini_section = field(o, (p + "ini_section").c_str());
        r.ini_line = field(o, (p + "ini_line").c_str());
    }
    g.fw = (float)std::atof(g.firmware_min.c_str());
    g.author_name = field(o, "author_name");
    g.updated_at = field(o, "updated_at");
    g.likes = std::atoi(field(o, "likes").c_str());
    g.downloads = std::atoi(field(o, "downloads_count").c_str());
    g.featuredRank = std::atoi(field(o, "featured_rank").c_str());
    g.featuredLabel = field(o, "featured_label");
    { const std::string r = field(o, "fw_reliability"); g.fwReliability = r.empty() ? -1 : std::atoi(r.c_str()); }
    if (g.id.empty()) g.id = g.title_id;
    if (g.titre.empty() || g.pkg_url.empty()) return false;
    out = std::move(g);
    return true;
}

namespace {

std::vector<Game> toGames(const std::vector<json::Object>& objs) {
    std::vector<Game> out;
    for (const auto& o : objs) {
        Game g;
        if (gameFromObject(o, g)) out.push_back(std::move(g));
    }
    return out;
}

const std::string kCacheFile = std::string(config::CACHE_DIR) + "/catalog.json";

}

void Catalog::refresh() {
    if (state_ == State::Loading) return;
    join();
    state_ = State::Loading;
    th_ = std::thread([this] {
        try { run(); }
        catch (...) {
            platform::logCaught("catalog");
            { std::lock_guard<std::mutex> l(m_); error_ = "Erreur interne pendant la lecture du catalogue"; }
            state_ = State::Failed;
        }
    });
}

std::string Catalog::error() const { std::lock_guard<std::mutex> l(m_); return error_; }

bool Catalog::snapshot(std::vector<Game>& out, unsigned& lastVersion) const {
    std::lock_guard<std::mutex> l(m_);
    if (lastVersion == version_) return false;
    out = games_;
    lastVersion = version_;
    return true;
}

void Catalog::run() {
    std::string body, err;
    long code = http::get(server_ + "/api/games", body, err);
    std::vector<json::Object> objs;
    bool ok = code == 200 && json::parseObjectArray(body, objs);
    platform::bootLogf("catalog: GET /api/games -> code=%ld octets=%u json=%s%s%s", code, (unsigned)body.size(),
                       ok ? "OK" : "ECHEC", err.empty() ? "" : " err=", err.c_str());

    if (ok) {
        std::string tmp = kCacheFile + ".tmp";
        std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
        if (out) { out << body; out.close(); std::remove(kCacheFile.c_str()); std::rename(tmp.c_str(), kCacheFile.c_str()); }
        fromCache_ = false;
    } else {
        std::string reason = err.empty() ? (code == 200 ? "Réponse invalide du serveur" : "Erreur réseau") : err;
        std::ifstream in(kCacheFile, std::ios::binary);
        if (in) {
            std::stringstream ss; ss << in.rdbuf();
            ok = json::parseObjectArray(ss.str(), objs);
            fromCache_ = ok;
        }
        if (!ok) {
            { std::lock_guard<std::mutex> l(m_); error_ = reason + " — " + server_; }
            state_ = State::Failed;
            return;
        }
        std::lock_guard<std::mutex> l(m_);
        error_ = reason;
    }

    {
        std::lock_guard<std::mutex> l(m_);
        games_ = toGames(objs);
        ++version_;
        if (!fromCache_) error_.clear();
    }
    platform::bootLogf("catalog: %u jeu(x) charge(s)%s", (unsigned)objs.size(), fromCache_ ? " (cache hors ligne)" : "");
    state_ = State::Ready;
}
