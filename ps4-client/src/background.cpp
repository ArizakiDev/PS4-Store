#include "background.h"

#include <algorithm>
#include <cmath>

#include "gfx.h"

namespace {

constexpr int RIB_W = 1920, RIB_H = 150;
constexpr float TAU = 6.28318530718f;

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
            const float dx = fx - 0.78f, dy = (fy - 0.88f) * 0.56f;
            const float glow = std::max(0.f, 1.f - sqrtf(dx * dx + dy * dy) / 0.55f);
            const float g2 = glow * glow * 0.42f;
            c.r += (0 - c.r) * g2; c.g += (112 - c.g) * g2; c.b += (209 - c.b) * g2;
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
    if (assets_) return;
    assets_ = true;

    struct Spec { int k1, k2; float ph1, ph2, a1, a2, sigma, alpha; };
    const Spec specs[3] = {{1, 3, 0.0f, 1.3f, 26.f, 9.f, 15.f, 150.f},
                           {2, 5, 2.1f, 0.4f, 20.f, 7.f, 12.f, 115.f},
                           {1, 2, 4.0f, 2.6f, 30.f, 10.f, 18.f, 90.f}};
    for (int i = 0; i < 3; ++i) {
        const Spec& s = specs[i];
        std::vector<float> lut(RIB_H * 2);
        for (int d = 0; d < RIB_H * 2; ++d) { const float dd = d * 0.5f; lut[d] = s.alpha * expf(-(dd * dd) / (2 * s.sigma * s.sigma)); }
        std::vector<unsigned char> px((size_t)RIB_W * RIB_H * 4, 0);
        for (int x = 0; x < RIB_W; ++x) {
            const float p = TAU * x / RIB_W;
            const float cy = RIB_H / 2.f + s.a1 * sinf(p * s.k1 + s.ph1) + s.a2 * sinf(p * s.k2 + s.ph2);
            const float mix = 0.5f + 0.5f * sinf(p * 2 + s.ph1);
            const unsigned char cr = (unsigned char)(0 + 46 * mix), cg = (unsigned char)(112 + 43 * mix), cb = (unsigned char)(209 + 46 * mix);
            for (int y = 0; y < RIB_H; ++y) {
                const int idx = std::min(RIB_H * 2 - 1, (int)(fabsf(y - cy) * 2.f));
                unsigned char* o = &px[((size_t)y * RIB_W + x) * 4];
                o[0] = cr; o[1] = cg; o[2] = cb; o[3] = (unsigned char)lut[idx];
            }
        }
        ribbon_[i] = gfx::makeTexture(r_, px.data(), RIB_W, RIB_H);
    }

    const int G = 32;
    std::vector<unsigned char> g((size_t)G * G * 4);
    for (int y = 0; y < G; ++y)
        for (int x = 0; x < G; ++x) {
            const float d = sqrtf((x - 15.5f) * (x - 15.5f) + (y - 15.5f) * (y - 15.5f)) / 15.5f;
            const float a = std::max(0.f, 1.f - d);
            unsigned char* o = &g[((size_t)y * G + x) * 4];
            o[0] = 190; o[1] = 228; o[2] = 255; o[3] = (unsigned char)(255 * a * a);
        }
    glow_ = gfx::makeTexture(r_, g.data(), G, G);
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

    const int nRib = quality >= 3 ? 3 : quality >= 2 ? 2 : quality >= 1 ? 1 : 0;
    static const float yBase[3] = {600.f, 800.f, 380.f}, speed[3] = {34.f, -22.f, 48.f};
    for (int i = 0; i < nRib; ++i) {
        if (!ribbon_[i]) continue;
        float off = fmodf(t_ * speed[i], (float)RIB_W);
        if (off < 0.f) off += RIB_W;
        const float bob = 30.f * sinf(t_ * 0.45f + i * 1.7f);
        const int y = (int)((yBase[i] + bob) * H / 1080.f) - RIB_H / 2;
        SDL_SetTextureAlphaMod(ribbon_[i], (Uint8)(255.f * (0.62f + 0.28f * sinf(t_ * 0.7f + i * 2.1f))));
        SDL_Rect a{-(int)off, y, RIB_W, RIB_H}, b{RIB_W - (int)off, y, RIB_W, RIB_H};
        SDL_RenderCopy(r_, ribbon_[i], nullptr, &a);
        SDL_RenderCopy(r_, ribbon_[i], nullptr, &b);
    }

    if (quality >= 2 && glow_) {
        const int n = quality >= 3 ? 26 : 12;
        for (int i = 0; i < n; ++i) {
            const float s1 = fmodf(i * 0.6180339f, 1.f), s2 = fmodf(i * 0.7548776f + 0.3f, 1.f), s3 = fmodf(i * 0.5698403f + 0.6f, 1.f);
            const float sz = 8.f + 16.f * s3;
            const float rise = 12.f + 26.f * s2;
            float y = fmodf(s2 * H + H - t_ * rise, (float)H + 40.f);
            float x = s1 * W + 22.f * sinf(t_ * (0.3f + s3 * 0.4f) + i);
            const float tw = 0.35f + 0.65f * (0.5f + 0.5f * sinf(t_ * (0.8f + s1) + i * 1.9f));
            SDL_SetTextureAlphaMod(glow_, (Uint8)(150.f * tw));
            SDL_Rect d{(int)(x - sz / 2), (int)(y - sz / 2), (int)sz, (int)sz};
            SDL_RenderCopy(r_, glow_, nullptr, &d);
        }
    }
}
