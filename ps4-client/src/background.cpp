#include "background.h"

#include <algorithm>
#include <cmath>

#include "gfx.h"

namespace {

struct Rgb { float r, g, b; };

Rgb g_a{3, 11, 28}, g_b{10, 43, 110}, g_c{0, 67, 156};

Rgb gradient(float t) {
    const Rgb a = g_a, b = g_b, c = g_c;
    t = std::min(1.f, std::max(0.f, t));
    if (t < 0.55f) { float k = t / 0.55f; return {a.r + (b.r - a.r) * k, a.g + (b.g - a.g) * k, a.b + (b.b - a.b) * k}; }
    float k = (t - 0.55f) / 0.45f;
    return {b.r + (c.r - b.r) * k, b.g + (c.g - b.g) * k, b.b + (c.b - b.b) * k};
}

}

Background::~Background() {
    if (cur_) SDL_DestroyTexture(cur_);
    if (prev_) SDL_DestroyTexture(prev_);
    for (auto* t : ribbon_) if (t) SDL_DestroyTexture(t);
    if (glow_) SDL_DestroyTexture(glow_);
}

void Background::update(float dt) {
    t_ += dt;
    if (fade_ < 1.f) fade_ = std::min(1.f, fade_ + dt / 0.45f);
    if (fade_ >= 1.f && prev_) { SDL_DestroyTexture(prev_); prev_ = nullptr; }
}

void Background::setGradient(int ar, int ag, int ab, int br, int bg, int bb, int cr, int cg, int cb) {
    g_a = Rgb{(float)ar, (float)ag, (float)ab};
    g_b = Rgb{(float)br, (float)bg, (float)bb};
    g_c = Rgb{(float)cr, (float)cg, (float)cb};
    dirty_ = true;
}

void Background::setBackdrop(const std::string& key, const std::vector<unsigned char>& tiny) {
    const bool has = tiny.size() >= (size_t)32 * 32 * 4;
    if (key == key_ && has == hasCover_) return;
    key_ = key;
    hasCover_ = has;
    tiny_ = has ? tiny : std::vector<unsigned char>();
    dirty_ = true;
}

SDL_Texture* Background::compose(const std::vector<unsigned char>& tiny) {
    std::vector<unsigned char> px((size_t)BW * BH * 4);
    const bool cover = tiny.size() >= (size_t)32 * 32 * 4;
    for (int y = 0; y < BH; ++y) {
        const float fy = (float)y / (BH - 1);
        for (int x = 0; x < BW; ++x) {
            const float fx = (float)x / (BW - 1);
            Rgb c = gradient(0.62f * fy + 0.38f * fx);
            if (cover) {
                const float u = fx * 31.f;
                const float v = (fy * ((float)BH / BW) + (1.f - (float)BH / BW) * 0.5f) * 31.f;
                const int u0 = std::min(30, (int)u), v0 = std::min(30, (int)v);
                const float fu = u - u0, fv = v - v0;
                float s[3];
                for (int ch = 0; ch < 3; ++ch) {
                    auto at = [&](int xx, int yy) { return (float)tiny[((size_t)yy * 32 + xx) * 4 + ch]; };
                    s[ch] = (at(u0, v0) * (1 - fu) + at(u0 + 1, v0) * fu) * (1 - fv) + (at(u0, v0 + 1) * (1 - fu) + at(u0 + 1, v0 + 1) * fu) * fv;
                }
                c.r = c.r * 0.46f + s[0] * 0.42f + 0 * 0.12f;
                c.g = c.g * 0.46f + s[1] * 0.42f + 40 * 0.12f;
                c.b = c.b * 0.46f + s[2] * 0.42f + 110 * 0.12f;
            }
            const float d = (float)(((x * 7 + y * 13) & 3) - 1) * 0.5f;
            unsigned char* o = &px[((size_t)y * BW + x) * 4];
            o[0] = (unsigned char)std::min(255.f, std::max(0.f, c.r + d));
            o[1] = (unsigned char)std::min(255.f, std::max(0.f, c.g + d));
            o[2] = (unsigned char)std::min(255.f, std::max(0.f, c.b + d));
            o[3] = 255;
        }
    }
    SDL_Texture* t = gfx::makeTexture(r_, px.data(), BW, BH);
    if (t) SDL_SetTextureBlendMode(t, SDL_BLENDMODE_NONE);
    return t;
}

void Background::ensureAssets() {
    assets_ = true;
}

void Background::draw(int quality, int W, int H) {
    ensureAssets();

    if (dirty_ || !cur_) {
        dirty_ = false;
        if (SDL_Texture* t = compose(tiny_)) {
            if (prev_) SDL_DestroyTexture(prev_);
            prev_ = cur_;
            cur_ = t;
            fade_ = (prev_ && quality >= 3) ? 0.f : 1.f;
            if (fade_ >= 1.f && prev_) { SDL_DestroyTexture(prev_); prev_ = nullptr; }
        }
    }

    SDL_Rect full{0, 0, W, H};
    if (fade_ < 1.f && prev_ && quality >= 3) {
        SDL_RenderCopy(r_, prev_, nullptr, &full);
        SDL_SetTextureBlendMode(cur_, SDL_BLENDMODE_BLEND);
        SDL_SetTextureAlphaMod(cur_, (Uint8)(255.f * fade_));
        SDL_RenderCopy(r_, cur_, nullptr, &full);
        SDL_SetTextureAlphaMod(cur_, 255);
        SDL_SetTextureBlendMode(cur_, SDL_BLENDMODE_NONE);
    } else if (cur_) {
        SDL_RenderCopy(r_, cur_, nullptr, &full);
    } else {
        SDL_SetRenderDrawBlendMode(r_, SDL_BLENDMODE_NONE);
        SDL_SetRenderDrawColor(r_, (Uint8)g_b.r, (Uint8)g_b.g, (Uint8)g_b.b, 255);
        SDL_RenderFillRect(r_, &full);
    }
}
