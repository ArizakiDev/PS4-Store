#pragma once
#include <SDL2/SDL.h>

#include <atomic>
#include <condition_variable>
#include <deque>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "catalog.h"

std::string iconCachePath(const Game& g);

class ImageCache {
public:
    static constexpr int SIZE = 300;
    static constexpr int LARGE = 440;

    explicit ImageCache(SDL_Renderer* renderer);
    ~ImageCache();

    void request(const Game& g);
    void requestLarge(const Game& g);
    SDL_Texture* get(const std::string& id) const;
    SDL_Texture* getLarge(const std::string& id) const { return get(id + "#L"); }
    static constexpr int TINY = 32;
    bool getTiny(const std::string& id, std::vector<unsigned char>& out) const;
    void pump(int maxPerFrame = 2);
    void clearAll();

    void suspend();
    void resume();
    bool suspended() const { return paused_; }

private:
    struct Job { std::string id, url, path; int size = SIZE; };
    struct Decoded { std::string id; std::vector<unsigned char> rgba; std::vector<unsigned char> tiny; int size = SIZE; };

    void worker();
    bool ensureFile(const Job& job);
    bool decode(const Job& job, Decoded& out);

    SDL_Renderer* renderer_;
    std::thread thread_;
    std::mutex m_;
    std::condition_variable cv_;
    std::deque<Job> jobs_;
    std::deque<Decoded> ready_;
    std::set<std::string> known_;
    std::map<std::string, SDL_Texture*> textures_;
    std::map<std::string, std::vector<unsigned char>> tiny_;
    std::deque<std::string> largeOrder_;
    bool quit_ = false;
    bool paused_ = false;
    unsigned generation_ = 0;
};
