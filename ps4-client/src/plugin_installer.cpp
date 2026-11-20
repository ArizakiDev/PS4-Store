#include "plugin_installer.h"

#include <cstdio>

#include "http.h"
#include "i18n.h"
#include "installed.h"
#include "platform.h"
#include "text.h"

namespace plugin {

namespace {

const char* kIniPath = "/data/GoldHEN/plugins.ini";
const char* kRoot = "/data/GoldHEN/";

bool regionActive(const Game& g, int region) {
    return g.regions == "BOTH" || (region == REGION_EU ? g.regions == "EU" : g.regions == "US");
}
const Game::Region& regionOf(const Game& g, int region) { return region == REGION_EU ? g.eu : g.us; }

bool safeTarget(const Game::Region& r, std::string& path) {
    if (r.install_dir.compare(0, std::char_traits<char>::length(kRoot), kRoot) != 0) return false;
    if (r.install_dir.find("..") != std::string::npos) return false;
    if (r.filename.empty() || r.filename.find('/') != std::string::npos || r.filename.find('\\') != std::string::npos ||
        r.filename.find("..") != std::string::npos) return false;
    path = r.install_dir + (r.install_dir.back() == '/' ? "" : "/") + r.filename;
    return true;
}

bool readWhole(const std::string& path, std::string& out) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return false;
    out.clear();
    char buf[4096];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) out.append(buf, n);
    std::fclose(f);
    return true;
}

bool writeAtomic(const std::string& path, const std::string& data) {
    const std::string tmp = path + ".tmp";
    FILE* f = std::fopen(tmp.c_str(), "wb");
    if (!f) return false;
    bool ok = data.empty() || std::fwrite(data.data(), 1, data.size(), f) == data.size();
    ok = (std::fclose(f) == 0) && ok;
    if (!ok) { std::remove(tmp.c_str()); return false; }
    std::remove(path.c_str());
    if (std::rename(tmp.c_str(), path.c_str()) != 0) { std::remove(tmp.c_str()); return false; }
    return true;
}

std::string trim(const std::string& s) {
    size_t a = 0, b = s.size();
    while (a < b && (s[a] == ' ' || s[a] == '\t' || s[a] == '\r' || s[a] == '\n')) ++a;
    while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t' || s[b - 1] == '\r' || s[b - 1] == '\n')) --b;
    return s.substr(a, b - a);
}
std::string lower(std::string s) { for (char& c : s) if (c >= 'A' && c <= 'Z') c = (char)(c + 32); return s; }

std::string normSection(const std::string& s) {
    std::string t = trim(s.empty() ? "[default]" : s);
    if (t.front() != '[') t = "[" + t;
    if (t.back() != ']') t += "]";
    return t;
}

std::vector<std::string> splitLines(const std::string& c) {
    std::vector<std::string> v;
    size_t p = 0;
    while (p < c.size()) {
        size_t e = c.find('\n', p);
        if (e == std::string::npos) { v.push_back(c.substr(p)); break; }
        v.push_back(c.substr(p, e - p));
        p = e + 1;
    }
    return v;
}
std::string joinLines(const std::vector<std::string>& v) {
    std::string o;
    for (const auto& l : v) { o += l; o += '\n'; }
    return o;
}
bool isHeader(const std::string& l) { std::string t = trim(l); return !t.empty() && t.front() == '['; }

}

Plan planFor(const Game& g) {
    Plan p;
    p.euSupported = regionActive(g, REGION_EU) && !g.eu.title_id.empty();
    p.usSupported = regionActive(g, REGION_US) && !g.us.title_id.empty();
    if (p.euSupported) p.euInstalled = installed::isTitleInstalled(g.eu.title_id);
    if (p.usSupported) p.usInstalled = installed::isTitleInstalled(g.us.title_id);
    return p;
}

bool iniAddLine(std::string& content, const std::string& sectionIn, const std::string& lineIn) {
    const std::string section = lower(normSection(sectionIn)), line = trim(lineIn);
    if (line.empty()) return false;
    std::vector<std::string> v = splitLines(content);
    int head = -1;
    for (int i = 0; i < (int)v.size(); ++i) if (isHeader(v[i]) && lower(trim(v[i])) == section) { head = i; break; }
    if (head < 0) {
        if (!v.empty() && !trim(v.back()).empty()) v.push_back("");
        v.push_back(normSection(sectionIn));
        v.push_back(line);
        content = joinLines(v);
        return true;
    }
    int end = head + 1, lastUsed = head;
    for (; end < (int)v.size() && !isHeader(v[end]); ++end) {
        if (trim(v[end]) == line) return false;
        if (!trim(v[end]).empty()) lastUsed = end;
    }
    v.insert(v.begin() + lastUsed + 1, line);
    content = joinLines(v);
    return true;
}

bool iniRemoveLine(std::string& content, const std::string& sectionIn, const std::string& lineIn) {
    const std::string section = lower(normSection(sectionIn)), line = trim(lineIn);
    std::vector<std::string> v = splitLines(content);
    int head = -1;
    for (int i = 0; i < (int)v.size(); ++i) if (isHeader(v[i]) && lower(trim(v[i])) == section) { head = i; break; }
    if (head < 0) return false;
    bool changed = false;
    int end = head + 1;
    for (; end < (int)v.size() && !isHeader(v[end]);) {
        if (trim(v[end]) == line) { v.erase(v.begin() + end); changed = true; }
        else ++end;
    }
    if (!changed) return false;
    bool empty = true;
    for (int i = head + 1; i < end; ++i) if (!trim(v[i]).empty()) { empty = false; break; }
    if (empty && section != "[default]") v.erase(v.begin() + head, v.begin() + end);
    content = joinLines(v);
    return true;
}

Manager::~Manager() {
    join(actionThread_);
    join(scanThread_);
}

Manager::Event Manager::lastEvent() const { std::lock_guard<std::mutex> l(m_); return event_; }

void Manager::post(bool ok, const std::string& msg) {
    std::lock_guard<std::mutex> l(m_);
    event_.ok = ok;
    event_.message = msg;
    ++event_.serial;
}

bool Manager::snapshot(std::set<std::string>& ids, unsigned& lastVersion) const {
    std::lock_guard<std::mutex> l(m_);
    if (lastVersion == version_) return false;
    ids = present_;
    lastVersion = version_;
    return true;
}

void Manager::refresh(const std::vector<Game>& games) {
    if (scanning_.load()) return;
    join(scanThread_);
    std::vector<Game> mods;
    for (const auto& g : games) if (g.resource_type == "plugin") mods.push_back(g);
    scanning_ = true;
    scanThread_ = std::thread([this, mods] {
        try {
            std::set<std::string> found;
            for (const auto& g : mods)
                for (int r : {REGION_EU, REGION_US}) {
                    std::string path;
                    if (regionActive(g, r) && safeTarget(regionOf(g, r), path) && platform::fileExists(path)) { found.insert(g.id); break; }
                }
            std::lock_guard<std::mutex> l(m_);
            if (found != present_) { present_ = found; ++version_; }
        } catch (...) { platform::logCaught("plugin_scan"); }
        scanning_ = false;
    });
}

void Manager::install(const Game& g, int mask) {
    if (busy_.exchange(true)) return;
    join(actionThread_);
    actionThread_ = std::thread([this, g, mask] {
        try { doInstall(g, mask); }
        catch (...) { platform::logCaught("plugin_install"); post(false, i18n::tr("ps4.plugin.fail", {{"err", "exception"}})); }
        busy_ = false;
    });
}

void Manager::uninstall(const Game& g) {
    if (busy_.exchange(true)) return;
    join(actionThread_);
    actionThread_ = std::thread([this, g] {
        try { doUninstall(g); }
        catch (...) { platform::logCaught("plugin_uninstall"); post(false, i18n::tr("ps4.plugin.fail", {{"err", "exception"}})); }
        busy_ = false;
    });
}

void Manager::doInstall(Game g, int mask) {
    auto fail = [&](const std::string& why) { post(false, i18n::tr("ps4.plugin.fail", {{"err", why}})); };

    struct Target { int region; std::string path; };
    std::vector<Target> targets;
    for (int r : {REGION_EU, REGION_US}) {
        if (!(mask & r) || !regionActive(g, r)) continue;
        std::string path;
        if (!safeTarget(regionOf(g, r), path)) { fail("chemin invalide"); return; }
        targets.push_back({r, path});
    }
    if (targets.empty()) { fail("aucune region"); return; }

    std::string body, err;
    long code = http::get(g.pkg_url, body, err, 60);
    if (code != 200 || body.empty()) { fail(err.empty() ? "HTTP " + std::to_string(code) : err); return; }

    std::set<std::string> written;
    for (const auto& t : targets) {
        if (written.count(t.path)) continue;
        const std::string dir = t.path.substr(0, t.path.rfind('/'));
        if (!platform::makeDirs(dir)) { fail("mkdir " + dir); return; }
        if (!writeAtomic(t.path, body)) { fail("ecriture " + t.path); return; }
        written.insert(t.path);
        platform::bootLogf("plugin: %s (%u octets)", t.path.c_str(), (unsigned)body.size());
    }

    if (g.target_type == "plugin") {
        std::string ini;
        readWhole(kIniPath, ini);
        bool changed = false;
        for (const auto& t : targets) {
            const Game::Region& r = regionOf(g, t.region);
            if (!r.ini_line.empty()) changed = iniAddLine(ini, r.ini_section, r.ini_line) || changed;
        }
        if (changed && !writeAtomic(kIniPath, ini)) { fail("plugins.ini"); return; }
    }
    post(true, i18n::tr("ps4.plugin.done", {{"name", g.titre}}));
}

void Manager::doUninstall(Game g) {
    std::string ini;
    const bool hadIni = readWhole(kIniPath, ini);
    bool iniChanged = false;
    for (int r : {REGION_EU, REGION_US}) {
        if (!regionActive(g, r)) continue;
        const Game::Region& reg = regionOf(g, r);
        std::string path;
        if (safeTarget(reg, path)) std::remove(path.c_str());
        if (hadIni && g.target_type == "plugin" && !reg.ini_line.empty()) iniChanged = iniRemoveLine(ini, reg.ini_section, reg.ini_line) || iniChanged;
    }
    if (iniChanged && !writeAtomic(kIniPath, ini)) { post(false, i18n::tr("ps4.plugin.fail", {{"err", "plugins.ini"}})); return; }
    post(true, i18n::tr("ps4.plugin.removed", {{"name", g.titre}}));
}

}
