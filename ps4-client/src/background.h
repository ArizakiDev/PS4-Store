#pragma once
#include <SDL2/SDL.h>

#include <string>
#include <vector>

class Background {
public:
    static constexpr int BW = 480, BH = 270;

    explicit Background(SDL_Renderer* r) : r_(r) {}
    ~Background();

    void update(float dt);

    void setBackdrop(const std::string& key, const std::vector<unsigned char>& tiny);
    void setGradient(int ar, int ag, int ab, int br, int bg, int bb, int cr, int cg, int cb);
    const std::string& key() const { return key_; }
    bool hasCover() const { return hasCover_; }

    void draw(int quality, int screenW, int screenH);

private:
    void ensureAssets();
    SDL_Texture* compose(const std::vector<unsigned char>& tiny);

    SDL_Renderer* r_;
    bool assets_ = false;
    SDL_Texture* cur_ = nullptr;
    SDL_Texture* prev_ = nullptr;
    SDL_Texture* ribbon_[3] = {};
    SDL_Texture* glow_ = nullptr;
    std::string key_;
    bool hasCover_ = false;
    bool dirty_ = true;
    std::vector<unsigned char> tiny_;
    float t_ = 0.f, fade_ = 1.f;
};
