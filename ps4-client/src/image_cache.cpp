#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#define STBI_ONLY_JPEG
#define STBI_NO_STDIO
#include "../external/stb_image.h"

#include "image_cache.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <dirent.h>
#include <fstream>
#include <sstream>

#include "config.h"
#include "gfx.h"
#include "http.h"
#include "platform.h"

std::string iconCachePath(const Game& g) {
    unsigned long long h = 1469598103934665603ULL;
    for (unsigned char c : g.icon_url) { h ^= c; h *= 1099511628211ULL; }
    char name[64];
    std::snprintf(name, sizeof name, "/icon_%016llx.png", h);
    return std::string(config::CACHE_DIR) + name;
}

namespace {

std::string cachePathFor(const Game& g) { return iconCachePath(g); }

bool readFile(const std::string& path, std::string& out) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return false;
    std::stringstream ss; ss << in.rdbuf();
    out = ss.str();
    return !out.empty();
}

void roundCorners(std::vector<unsigned char>& rgba, int n, float r) {
    for (int y = 0; y < n; ++y) {
        for (int x = 0; x < n; ++x) {
            float cx = x + 0.5f, cy = y + 0.5f;
            float dx = std::max(r - cx, cx - (n - r));
            float dy = std::max(r - cy, cy - (n - r));
            if (dx <= 0.f || dy <= 0.f) continue;
            float d = std::sqrt(dx * dx + dy * dy) - r;
            float cov = d <= -0.5f ? 1.f : (d >= 0.5f ? 0.f : 0.5f - d);
            rgba[(y * n + x) * 4 + 3] = (unsigned char)(rgba[(y * n + x) * 4 + 3] * cov);
        }
    }
}

}

ImageCache::ImageCache(SDL_Renderer* renderer) : renderer_(renderer) {
    thread_ = std::thread([this] {
        try { worker(); }
        catch (...) { platform::logCaught("image_cache"); }
    });
}

ImageCache::~ImageCache() {
    { std::lock_guard<std::mutex> l(m_); quit_ = true; }
    cv_.notify_all();
    if (thread_.joinable()) thread_.join();
    for (auto& kv : textures_) SDL_DestroyTexture(kv.second);
}

void ImageCache::request(const Game& g) {
    if (g.icon_url.empty()) return;
    std::lock_guard<std::mutex> l(m_);
    if (paused_ || known_.count(g.id)) return;
    known_.insert(g.id);
    jobs_.push_back({g.id, g.icon_url, cachePathFor(g)});
    cv_.notify_one();
}

void ImageCache::requestLarge(const Game& g) {
    if (g.icon_url.empty()) return;
    const std::string key = g.id + "#L";
    std::lock_guard<std::mutex> l(m_);
    if (paused_ || known_.count(key)) return;
    known_.insert(key);
    Job j{key, g.icon_url, cachePathFor(g)};
    j.size = LARGE;
    jobs_.push_back(j);
    cv_.notify_one();
}

SDL_Texture* ImageCache::get(const std::string& id) const {
    auto it = textures_.find(id);
    return it == textures_.end() ? nullptr : it->second;
}

void ImageCache::pump(int maxPerFrame) {
    for (int i = 0; i < maxPerFrame; ++i) {
        Decoded d;
        {
            std::lock_guard<std::mutex> l(m_);
            if (ready_.empty()) return;
            d = std::move(ready_.front());
            ready_.pop_front();
        }
        SDL_Texture* t = gfx::makeTexture(renderer_, d.rgba.data(), d.size, d.size);
        if (!t) continue;
        auto it = textures_.find(d.id);
        if (it != textures_.end()) SDL_DestroyTexture(it->second);
        textures_[d.id] = t;

        if (!d.tiny.empty()) tiny_[d.id] = std::move(d.tiny);

        if (d.size == LARGE) {
            for (auto o = largeOrder_.begin(); o != largeOrder_.end(); ++o)
                if (*o == d.id) { largeOrder_.erase(o); break; }
            largeOrder_.push_back(d.id);
            while (largeOrder_.size() > 4) {
                const std::string old = largeOrder_.front();
                largeOrder_.pop_front();
                auto ot = textures_.find(old);
                if (ot != textures_.end()) { SDL_DestroyTexture(ot->second); textures_.erase(ot); }
                std::lock_guard<std::mutex> l(m_);
                known_.erase(old);
            }
        }
    }
}

bool ImageCache::getTiny(const std::string& id, std::vector<unsigned char>& out) const {
    auto it = tiny_.find(id);
    if (it == tiny_.end()) return false;
    out = it->second;
    return true;
}

void ImageCache::clearAll() {
    tiny_.clear();
    {
        std::lock_guard<std::mutex> l(m_);
        jobs_.clear();
        ready_.clear();
        known_.clear();
        ++generation_;
    }
    for (auto& kv : textures_) SDL_DestroyTexture(kv.second);
    textures_.clear();
    largeOrder_.clear();
    if (DIR* d = opendir(config::CACHE_DIR)) {
        while (dirent* e = readdir(d)) {
            std::string n = e->d_name;
            if (n.rfind("icon_", 0) == 0) std::remove((std::string(config::CACHE_DIR) + "/" + n).c_str());
        }
        closedir(d);
    }
}

void ImageCache::suspend() {
    {
        std::lock_guard<std::mutex> l(m_);
        paused_ = true;
        jobs_.clear();
        ready_.clear();
        known_.clear();
        ++generation_;
    }
    for (auto& kv : textures_) SDL_DestroyTexture(kv.second);
    textures_.clear();
    tiny_.clear();
    largeOrder_.clear();
}

void ImageCache::resume() {
    {
        std::lock_guard<std::mutex> l(m_);
        paused_ = false;
    }
    cv_.notify_all();
}

bool ImageCache::ensureFile(const Job& job) {
    FILE* f = std::fopen(job.path.c_str(), "rb");
    if (f) { std::fclose(f); return true; }
    std::string body, err;
    if (http::get(job.url, body, err, 30) != 200 || body.empty()) return false;
    std::string tmp = job.path + ".tmp";
    std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
    if (!out) return false;
    out.write(body.data(), (std::streamsize)body.size());
    out.close();
    std::remove(job.path.c_str());
    return std::rename(tmp.c_str(), job.path.c_str()) == 0;
}

bool ImageCache::decode(const Job& job, Decoded& out) {
    std::string raw;
    if (!readFile(job.path, raw)) return false;
    int w = 0, h = 0, comp = 0;
    unsigned char* px = stbi_load_from_memory((const unsigned char*)raw.data(), (int)raw.size(), &w, &h, &comp, 4);
    if (!px) { std::remove(job.path.c_str()); return false; }
    if (w < 2 || h < 2) { stbi_image_free(px); return false; }

    const int S = job.size;
    const int side = std::min(w, h);
    const int ox = (w - side) / 2, oy = (h - side) / 2;
    const float step = (float)side / S;
    out.id = job.id;
    out.size = S;
    out.rgba.assign((size_t)S * S * 4, 0);
    for (int y = 0; y < S; ++y) {
        int y0 = oy + (int)(y * step), y1 = std::max(y0 + 1, oy + (int)((y + 1) * step));
        for (int x = 0; x < S; ++x) {
            int x0 = ox + (int)(x * step), x1 = std::max(x0 + 1, ox + (int)((x + 1) * step));
            unsigned sum[4] = {0, 0, 0, 0};
            unsigned cnt = 0;
            for (int sy = y0; sy < y1 && sy < h; ++sy)
                for (int sx = x0; sx < x1 && sx < w; ++sx) {
                    const unsigned char* p = px + ((size_t)sy * w + sx) * 4;
                    sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; sum[3] += p[3]; ++cnt;
                }
            if (!cnt) continue;
            unsigned char* d = &out.rgba[((size_t)y * S + x) * 4];
            for (int c = 0; c < 4; ++c) d[c] = (unsigned char)(sum[c] / cnt);
        }
    }
    stbi_image_free(px);
    roundCorners(out.rgba, S, S * 18.f / 300.f);

    if (S == SIZE) {
        out.tiny.assign((size_t)TINY * TINY * 4, 0);
        for (int ty = 0; ty < TINY; ++ty)
            for (int tx = 0; tx < TINY; ++tx) {
                const int x0 = tx * SIZE / TINY, x1 = (tx + 1) * SIZE / TINY, y0 = ty * SIZE / TINY, y1 = (ty + 1) * SIZE / TINY;
                unsigned sr = 0, sg = 0, sb = 0, n = 0;
                for (int yy = y0; yy < y1; yy += 2)
                    for (int xx = x0; xx < x1; xx += 2) {
                        const unsigned char* p = &out.rgba[((size_t)yy * SIZE + xx) * 4];
                        sr += p[0]; sg += p[1]; sb += p[2]; ++n;
                    }
                unsigned char* o = &out.tiny[((size_t)ty * TINY + tx) * 4];
                o[0] = (unsigned char)(sr / n); o[1] = (unsigned char)(sg / n); o[2] = (unsigned char)(sb / n); o[3] = 255;
            }
    }
    return true;
}

void ImageCache::worker() {
    for (;;) {
        Job job;
        unsigned gen;
        {
            std::unique_lock<std::mutex> l(m_);
            cv_.wait(l, [&] { return quit_ || (!paused_ && !jobs_.empty()); });
            if (quit_) return;
            job = std::move(jobs_.front());
            jobs_.pop_front();
            gen = generation_;
        }
        Decoded d;
        bool ok = false;
        try {
            bool have = ensureFile(job);
            ok = have && decode(job, d);
            if (!ok) platform::bootLogf("image: echec %s (%s) url=%s", job.id.c_str(), have ? "decodage" : "telechargement", job.url.c_str());
        } catch (...) {
            platform::logCaught("image_cache job");
        }
        std::lock_guard<std::mutex> l(m_);
        if (gen != generation_) continue;
        if (ok) ready_.push_back(std::move(d));
    }
}
