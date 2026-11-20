#pragma once
#include <atomic>
#include <chrono>
#include <mutex>
#include <string>
#include <thread>

#include "catalog.h"

class Updater {
public:
    enum class State { Idle, Checking, UpToDate, Available, Failed };
    struct Info { std::string version, pkgUrl, notes; };

    explicit Updater(std::string serverUrl) : server_(std::move(serverUrl)) {}
    ~Updater() { join(); }

    void check(bool force);

    State state() const { return state_.load(); }
    Info info() const;
    std::string error() const;

    Game asGame() const;

private:
    void run();
    void join() { if (th_.joinable()) th_.join(); }

    std::string server_;
    std::thread th_;
    std::atomic<State> state_{State::Idle};
    std::chrono::steady_clock::time_point lastCheck_{};
    bool everChecked_ = false;
    mutable std::mutex m_;
    Info info_;
    std::string error_;
};
