#pragma once
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "appinfo.h"
#include "catalog.h"
#include "installer.h"

class Downloader {
public:
    enum class Phase { Idle, Preparing };

    struct Task {
        int id = -1;
        std::string title;
        uint64_t expectedSize = 0;
        float fraction = -1.f;
        int failures = 0;
    };

    struct Event {
        unsigned serial = 0;
        bool ok = true;
        bool alert = false;
        std::string message;
    };

    Downloader();
    ~Downloader();

    void start(const Game& g);
    void cancel();

    Phase phase() const { return phase_.load(); }
    const Game& game() const { return game_; }
    bool isSelfUpdate() const { return game_.id == kSelfUpdateId; }
    float downloadFraction() const { return dlFraction_.load(); }
    Event lastEvent() const;
    std::vector<Task> tasks() const;

private:
    void prepare(Game g);
    bool installSelf(const Game& g, const installer::PkgHeader& hdr);
    void monitor();
    void post(bool ok, const std::string& msg, bool alert = false);

    std::atomic<Phase> phase_{Phase::Idle};
    std::atomic<bool> cancel_{false};
    std::atomic<float> dlFraction_{-1.f};
    std::atomic<bool> quit_{false};
    Game game_;
    std::thread prepThread_, monThread_;

    mutable std::mutex m_;
    std::vector<Task> tasks_;
    Event event_;
};
