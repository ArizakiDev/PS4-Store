#pragma once
#include <atomic>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "catalog.h"

namespace installed {

struct Entry {
    bool installed = false;
    std::string version;
};

enum class State { NotInstalled, UpToDate, UpdateAvailable };

std::vector<std::string> listConsoleTitles();

int compareVersions(const std::string& a, const std::string& b);

bool isTitleInstalled(const std::string& titleId);

State classify(const Game& g, const Entry* e);

bool parseSfoVersion(const std::string& sfo, std::string& version);

class Manager {
public:
    struct Event {
        unsigned serial = 0;
        bool ok = true;
        std::string message;
    };

    Manager() = default;
    ~Manager();

    void refresh(const std::vector<std::string>& titleIds);
    void launch(const std::string& titleId, const std::string& name);
    void uninstall(const std::string& titleId, const std::string& name);

    void setLaunchHooks(std::function<void()> before, std::function<void()> failed) {
        beforeLaunch_ = std::move(before); launchFailed_ = std::move(failed);
    }
    void setLaunchedHook(std::function<void(const std::string& titleId, const std::string& name)> h) { launchedHook_ = std::move(h); }

    bool snapshot(std::map<std::string, Entry>& out, unsigned& lastVersion) const;

    bool busy() const { return busy_.load(); }
    Event lastEvent() const;

private:
    void post(bool ok, const std::string& msg);
    void scan(std::vector<std::string> ids, bool merge);
    void join(std::thread& t) { if (t.joinable()) t.join(); }

    std::function<void()> beforeLaunch_, launchFailed_;
    std::function<void(const std::string&, const std::string&)> launchedHook_;
    std::thread scanThread_, actionThread_;
    std::atomic<bool> scanning_{false};
    std::atomic<bool> busy_{false};
    std::atomic<bool> quit_{false};

    mutable std::mutex m_;
    std::map<std::string, Entry> entries_;
    unsigned version_ = 0;
    Event event_;
};

}
