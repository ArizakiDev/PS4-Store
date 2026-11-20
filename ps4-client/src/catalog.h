#pragma once
#include <atomic>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

struct Game {
    std::string id, title_id, titre, description, version;
    std::string firmware_min, categorie, icon_url, pkg_url, size;
    std::string resource_type = "pkg", parent_title_id, regions = "BOTH", target_type, changelog_latest;
    struct Region { std::string title_id, install_dir, filename, ini_section, ini_line; };
    Region eu, us;
    float fw = 0.f;
    std::string author_name, updated_at;
    int likes = 0, downloads = 0, fwReliability = -1;
    int featuredRank = 0;
    std::string featuredLabel;
};

namespace json { using Object = std::map<std::string, std::string>; }
bool gameFromObject(const json::Object& o, Game& out);

class Catalog {
public:
    enum class State { Idle, Loading, Ready, Failed };

    explicit Catalog(std::string serverUrl) : server_(std::move(serverUrl)) {}
    ~Catalog() { join(); }

    void refresh();
    State state() const { return state_.load(); }
    std::string error() const;
    bool fromCache() const { return fromCache_.load(); }

    bool snapshot(std::vector<Game>& out, unsigned& lastVersion) const;

    const std::string& server() const { return server_; }

private:
    void run();
    void join() { if (th_.joinable()) th_.join(); }

    std::string server_;
    std::thread th_;
    std::atomic<State> state_{State::Idle};
    std::atomic<bool> fromCache_{false};
    mutable std::mutex m_;
    std::vector<Game> games_;
    std::string error_;
    unsigned version_ = 0;
};
