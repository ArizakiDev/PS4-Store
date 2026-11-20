#pragma once
#include <atomic>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "catalog.h"

namespace plugin {

enum RegionMask { REGION_EU = 1, REGION_US = 2 };

struct Plan {
    bool euSupported = false, usSupported = false;
    bool euInstalled = false, usInstalled = false;
    int supportedMask() const { return (euSupported ? REGION_EU : 0) | (usSupported ? REGION_US : 0); }
    int installedMask() const { return (euInstalled ? REGION_EU : 0) | (usInstalled ? REGION_US : 0); }
};
Plan planFor(const Game& g);

bool iniAddLine(std::string& content, const std::string& section, const std::string& line);
bool iniRemoveLine(std::string& content, const std::string& section, const std::string& line);

class Manager {
public:
    struct Event { unsigned serial = 0; bool ok = true; std::string message; };

    Manager() = default;
    ~Manager();

    void install(const Game& g, int regionMask);
    void uninstall(const Game& g);
    void refresh(const std::vector<Game>& games);

    bool snapshot(std::set<std::string>& ids, unsigned& lastVersion) const;
    bool busy() const { return busy_.load(); }
    Event lastEvent() const;

private:
    void post(bool ok, const std::string& msg);
    void doInstall(Game g, int mask);
    void doUninstall(Game g);
    void join(std::thread& t) { if (t.joinable()) t.join(); }

    std::thread actionThread_, scanThread_;
    std::atomic<bool> busy_{false}, scanning_{false};
    mutable std::mutex m_;
    std::set<std::string> present_;
    unsigned version_ = 0;
    Event event_;
};

}
