#pragma once
#include <atomic>
#include <chrono>
#include <mutex>
#include <string>
#include <thread>

class SelfUpdater {
public:
    enum class State { Idle, Checking, UpToDate, Downloading, Ready, Failed };
    struct Info { std::string version, pkgUrl, notes; };

    static constexpr const char* kUpdateDir = "/data/PS4Store/update";
    static constexpr const char* kUpdatePkg = "/data/PS4Store/update/PS4Store_update.pkg";
    static constexpr const char* kUpdaterElf = "/data/PS4Store/updater.elf";

    explicit SelfUpdater(std::string serverUrl) : server_(std::move(serverUrl)) {}
    ~SelfUpdater();

    void check(bool force);
    State state() const { return state_.load(); }
    float progress() const { return progress_.load(); }
    Info info() const;
    std::string error() const;

    bool canApply(std::string& err) const;

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
    mutable std::mutex m_;
    Info info_;
    std::string error_;
};
