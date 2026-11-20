#include "downloader.h"

#include <chrono>
#include <cstdio>

#include "config.h"
#include "http.h"
#include "appinfo.h"
#include "i18n.h"
#include "image_cache.h"
#include "installer.h"
#include "platform.h"

Downloader::Downloader() {
    monThread_ = std::thread([this] {
        try { monitor(); }
        catch (...) { platform::logCaught("downloader_monitor"); }
    });
}

Downloader::~Downloader() {
    quit_ = true;
    cancel_ = true;
    if (prepThread_.joinable()) prepThread_.join();
    if (monThread_.joinable()) monThread_.join();
}

Downloader::Event Downloader::lastEvent() const { std::lock_guard<std::mutex> l(m_); return event_; }
std::vector<Downloader::Task> Downloader::tasks() const { std::lock_guard<std::mutex> l(m_); return tasks_; }

void Downloader::post(bool ok, const std::string& msg, bool alert) {
    std::lock_guard<std::mutex> l(m_);
    event_.ok = ok;
    event_.alert = alert;
    event_.message = msg;
    ++event_.serial;
}

void Downloader::start(const Game& g) {
    if (phase_.load() != Phase::Idle) return;
    if (prepThread_.joinable()) prepThread_.join();
    game_ = g;
    cancel_ = false;
    phase_ = Phase::Preparing;
    prepThread_ = std::thread([this, g] {
        try { prepare(g); }
        catch (...) {
            platform::logCaught("downloader_prepare");
            post(false, "Erreur interne pendant la preparation du telechargement");
            phase_ = Phase::Idle;
        }
    });
}

void Downloader::cancel() {
    if (phase_.load() == Phase::Preparing) cancel_ = true;
}

namespace {
std::string humanSize(uint64_t b) {
    char buf[32];
    if (b >= (1ULL << 30)) std::snprintf(buf, sizeof buf, "%.1f Go", (double)b / (double)(1ULL << 30));
    else std::snprintf(buf, sizeof buf, "%.0f Mo", (double)b / (double)(1ULL << 20));
    return buf;
}

}

void Downloader::prepare(Game g) {
    auto fail = [&](const std::string& msg) { post(false, msg); phase_ = Phase::Idle; };
    std::string err;

    if (!installer::init(err)) { fail(err); return; }

    std::string head;
    bool partial = false;
    if (!http::getHead(g.pkg_url, installer::HEADER_BYTES, head, partial, err)) {
        if (cancel_ || http::suspended()) fail(i18n::tr("ps4.dl.cancelled"));
        else fail(i18n::tr("ps4.dl.link", {{"err", err}}));
        return;
    }
    if (cancel_) { post(false, i18n::tr("ps4.dl.cancelled")); phase_ = Phase::Idle; return; }
    if (!partial) {
        fail("Le serveur qui héberge le .pkg ne gère pas les requêtes Range (requis par la console)");
        return;
    }
    installer::PkgHeader hdr;
    if (!installer::parseHeader(head, hdr, err)) { fail(err); return; }
    if (g.id == kSelfUpdateId && (hdr.contentId.find(APP_TITLE_ID) == std::string::npos || std::string(hdr.type) != "PS4GD")) {
        fail("Le paquet de mise à jour ne correspond pas à PS4Store (" + hdr.contentId + ")");
        return;
    }

    {
        const uint64_t need = hdr.size + (512ULL * 1024 * 1024);
        uint64_t freeB = 0;
        if (hdr.size > 0 && platform::getFreeDiskSpaceBytes(freeB)) {
            platform::bootLogf("disque: libre=%llu Mo requis=%llu Mo", (unsigned long long)(freeB >> 20), (unsigned long long)(need >> 20));
            if (freeB <= need) { post(false, i18n::tr("ps4.no_space", {{"need", humanSize(need)}, {"free", humanSize(freeB)}}), true); phase_ = Phase::Idle; return; }
        }
    }

    if (g.id == kSelfUpdateId && installSelf(g, hdr)) { phase_ = Phase::Idle; return; }
    if (cancel_) { post(false, i18n::tr("ps4.dl.cancelled")); phase_ = Phase::Idle; return; }

    std::string icon = iconCachePath(g);
    if (!platform::fileExists(icon)) icon.clear();

    if (cancel_) { post(false, i18n::tr("ps4.dl.cancelled")); phase_ = Phase::Idle; return; }
    int taskId = -1;
    if (!installer::registerAndStart(hdr, g.pkg_url, g.titre, icon, taskId, err)) { fail(err); return; }

    {
        std::lock_guard<std::mutex> l(m_);
        Task t;
        t.id = taskId;
        t.title = g.titre;
        t.expectedSize = hdr.size;
        tasks_.push_back(t);
    }
    post(true, i18n::tr("ps4.dl.sent"));
    phase_ = Phase::Idle;
}

bool Downloader::installSelf(const Game& g, const installer::PkgHeader& hdr) {
    const std::string dir = std::string(config::DATA_DIR) + "/update";
    const std::string file = dir + "/PS4Store_update.pkg";
    auto stop = [&](bool ok, const std::string& msg, bool alert) { dlFraction_ = -1.f; post(ok, msg, alert); return true; };
    if (!platform::makeDirs(dir)) return stop(false, i18n::tr("ps4.self.fail", {{"err", "mkdir " + dir}}), true);
    std::remove(file.c_str());

    dlFraction_ = 0.f;
    uint64_t total = 0;
    std::string err;
    long code = http::downloadToFile(g.pkg_url, file, total, [this](uint64_t done, uint64_t all) {
        dlFraction_ = all > 0 ? (float)((double)done / (double)all) : -1.f;
    }, &cancel_, err);
    if (cancel_ || http::suspended()) { std::remove((file + ".part").c_str()); dlFraction_ = -1.f; post(false, i18n::tr("ps4.dl.cancelled")); return true; }
    if (code != 200) return stop(false, i18n::tr("ps4.self.fail", {{"err", err.empty() ? "HTTP " + std::to_string(code) : err}}), true);

    FILE* f = std::fopen(file.c_str(), "rb");
    uint64_t got = 0;
    if (f) { std::fseek(f, 0, SEEK_END); long pos = std::ftell(f); got = pos > 0 ? (uint64_t)pos : 0; std::fclose(f); }
    if (hdr.size > 0 && got != hdr.size) { std::remove(file.c_str()); return stop(false, i18n::tr("ps4.self.size"), true); }
    dlFraction_ = 1.f;

    std::string ierr;
    if (installer::installLocalPkg(file, ierr)) {
        platform::bootLogf("auto-update: installation locale lancee (%s)", file.c_str());
        return stop(true, i18n::tr("ps4.self.installing"), true);
    }
    platform::bootLogf("auto-update: installation locale refusee (%s) -> repli BGFT", ierr.c_str());
    dlFraction_ = -1.f;
    return false;
}

void Downloader::monitor() {
    std::unique_lock<std::mutex> lock(m_, std::defer_lock);
    while (!quit_) {
        for (int i = 0; i < 10 && !quit_; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
        if (quit_) break;
        lock.lock();
        if (tasks_.empty()) { lock.unlock(); continue; }

        std::vector<Task> snapshot = tasks_;
        lock.unlock();

        struct Outcome { bool remove = false; bool ok = true; std::string msg; };
        std::vector<Outcome> out(snapshot.size());
        for (size_t i = 0; i < snapshot.size(); ++i) {
            Task& t = snapshot[i];
            installer::Progress p;
            if (!installer::progress(t.id, p)) {
                if (++t.failures > 30) out[i].remove = true;
                continue;
            }
            t.failures = 0;
            if (p.error != 0) {
                char b[96];
                std::snprintf(b, sizeof b, "Échec du téléchargement système de « %s » (0x%08X)", t.title.c_str(), (unsigned)p.error);
                out[i] = {true, false, b};
            } else if (p.length > 0 && t.expectedSize > 0 && p.length != t.expectedSize) {
                installer::stopTask(t.id);
                out[i] = {true, false, "La console télécharge un autre paquet que celui du lien ; tâche arrêtée. Supprimez-la dans Téléchargements."};
            } else if (p.length > 0 && p.transferred >= p.length) {
                out[i] = {true, true, "« " + t.title + " » est téléchargé ; l'installation se termine dans les notifications."};
            } else if (p.length > 0) {
                t.fraction = (float)((double)p.transferred / (double)p.length);
            } else {
                t.fraction = p.preparingPercent > 0 ? p.preparingPercent / 100.f : -1.f;
            }
        }

        lock.lock();
        for (size_t i = 0; i < snapshot.size(); ++i) {
            for (size_t j = 0; j < tasks_.size(); ++j) {
                if (tasks_[j].id != snapshot[i].id) continue;
                if (out[i].remove) {
                    if (!out[i].msg.empty()) {
                        event_.ok = out[i].ok;
                        event_.message = out[i].msg;
                        ++event_.serial;
                    }
                    tasks_.erase(tasks_.begin() + (long)j);
                } else {
                    tasks_[j].fraction = snapshot[i].fraction;
                    tasks_[j].failures = snapshot[i].failures;
                }
                break;
            }
        }
        lock.unlock();
    }
}
