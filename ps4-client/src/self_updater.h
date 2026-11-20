#pragma once
#include <atomic>
#include <chrono>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

class SelfUpdater {
public:
    enum class State { Idle, Checking, UpToDate, Downloading, Ready, Failed };
    struct Info { std::string version, pkgUrl, notes; };
    struct Entry { std::string version, notes, date; };

    static constexpr const char* kUpdateDir = "/data/PS4Store/update";
    static constexpr const char* kUpdatePkg = "/data/PS4Store/update/PS4Store_update.pkg";
    static constexpr const char* kUpdaterElf = "/data/PS4Store/updater.elf";
    static constexpr const char* kMarker = "/data/PS4Store/update/applying.txt";

    explicit SelfUpdater(std::string serverUrl) : server_(std::move(serverUrl)) {}
    ~SelfUpdater();

    void check(bool force);
    State state() const { return state_.load(); }
    float progress() const { return progress_.load(); }
    Info info() const;
    std::vector<Entry> history() const;
    std::string error() const;

    bool canApply(std::string& err) const;
    void markApplying() const;
    static bool consumeApplyMarker(std::string& version);

    static bool installUpdaterElf(const std::string& bytes);

    static bool launchUpdaterAndExit();

private:
    void run();
    void join() { if (th_.joinable()) th_.join(); }

    std::string server_;
    std::thread th_;
    std::atomic<State> state_{State::Idle};
    std::atomic<float> progress_{-1.f};
    std::chrono::steady_clock::time_point lastCheck_{};
    bool everChecked_ = false;
    std::chrono::seconds retry_{45};
    mutable std::mutex m_;
    Info info_;
    std::vector<Entry> history_;
    std::string error_;
};
