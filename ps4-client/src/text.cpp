#define STB_TRUETYPE_IMPLEMENTATION
#include "../external/stb_truetype.h"

#include "text.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>

#include "gfx.h"
#include "platform.h"

namespace {

unsigned nextCodepoint(const std::string& s, size_t& i) {
    unsigned char c = (unsigned char)s[i++];
    if (c < 0x80) return c;
    int extra = c >= 0xF0 ? 3 : (c >= 0xE0 ? 2 : (c >= 0xC0 ? 1 : 0));
    unsigned cp = extra == 3 ? (c & 0x07) : (extra == 2 ? (c & 0x0F) : (c & 0x1F));
    for (int k = 0; k < extra && i < s.size(); ++k) cp = (cp << 6) | ((unsigned char)s[i++] & 0x3F);
    return extra == 0 ? 0xFFFD : cp;
}

}

TextRenderer::~TextRenderer() {
    for (auto& kv : cache_) if (kv.second.tex) SDL_DestroyTexture(kv.second.tex);
    delete static_cast<stbtt_fontinfo*>(info_);
}

bool TextRenderer::readFile(const std::string& path, std::vector<unsigned char>& out) {
    out.clear();
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) { platform::bootLogf("font: ouverture impossible : %s", path.c_str()); return false; }
    unsigned char chunk[16384];
    size_t n;
    while ((n = std::fread(chunk, 1, sizeof chunk, f)) > 0) out.insert(out.end(), chunk, chunk + n);
    std::fclose(f);
    if (out.size() < 12) { platform::bootLogf("font: fichier vide/trop court : %s", path.c_str()); out.clear(); return false; }
    return true;
}

bool TextRenderer::loadBytes(std::vector<unsigned char>&& data, const std::string& label) {
    if (data.size() < 12) return false;
    int offset = stbtt_GetFontOffsetForIndex(data.data(), 0);
    if (offset < 0) { platform::bootLogf("font: format non reconnu : %s", label.c_str()); return false; }
    auto* fi = new stbtt_fontinfo;
    std::memset(fi, 0, sizeof *fi);
    font_ = std::move(data);
    if (!stbtt_InitFont(fi, font_.data(), offset)) {
        platform::bootLogf("font: stbtt_InitFont a echoue : %s", label.c_str());
        delete fi; font_.clear();
        return false;
    }
    delete static_cast<stbtt_fontinfo*>(info_);
    info_ = fi;
    platform::bootLogf("font: OK %s (%u octets)", label.c_str(), (unsigned)font_.size());
    return true;
}

bool TextRenderer::load(const std::string& ttfPath) {
    const std::string rel = "assets/fonts/font.ttf";
    std::vector<std::string> candidates{ttfPath};
    for (const std::string& c : {rel, "/app0/" + rel, "/mnt/sandbox/PSTR00001_000/app0/" + rel})
        if (c != ttfPath) candidates.push_back(c);

    for (const std::string& path : candidates) {
        std::vector<unsigned char> data;
        if (!readFile(path, data)) continue;
        if (loadBytes(std::move(data), path)) return true;
    }
    return false;
}

int TextRenderer::measure(const std::string& text, int px) {
    if (!info_) return 0;
    auto* fi = static_cast<stbtt_fontinfo*>(info_);
    float scale = stbtt_ScaleForPixelHeight(fi, (float)px);
    float w = 0;
    for (size_t i = 0; i < text.size();) {
        unsigned cp = nextCodepoint(text, i);
        int adv, lsb;
        stbtt_GetCodepointHMetrics(fi, (int)cp, &adv, &lsb);
        w += adv * scale;
    }
    return (int)std::ceil(w);
}

int TextRenderer::width(const std::string& text, int px) {
    if (!info_ || text.empty()) return 0;
    std::string key = std::to_string(px);
    key += ':';
    key += text;
    auto it = widthCache_.find(key);
    if (it != widthCache_.end()) return it->second;
    int w = measure(text, px);
    if (widthCache_.size() > 4000) widthCache_.clear();
    widthCache_.emplace(std::move(key), w);
    return w;
}

std::string TextRenderer::fit(const std::string& text, int px, int maxWidth) {
    if (maxWidth <= 0 || !info_ || text.empty()) return text;
    std::string key = std::to_string(px);
    key += ':';
    key += std::to_string(maxWidth);
    key += ':';
    key += text;
    auto it = fitCache_.find(key);
    if (it != fitCache_.end()) return it->second;

    std::string result = text;
    if (width(text, px) > maxWidth) {
        const std::string ell = "\xE2\x80\xA6";
        auto* fi = static_cast<stbtt_fontinfo*>(info_);
        float scale = stbtt_ScaleForPixelHeight(fi, (float)px);
        int budget = maxWidth - width(ell, px);
        float acc = 0;
        size_t keep = 0;
        for (size_t i = 0; i < text.size();) {
            unsigned cp = nextCodepoint(text, i);
            int adv, lsb;
            stbtt_GetCodepointHMetrics(fi, (int)cp, &adv, &lsb);
            acc += adv * scale;
            if (std::ceil(acc) > budget) break;
            keep = i;
        }
        result = text.substr(0, keep) + ell;
    }
    if (fitCache_.size() > 2000) fitCache_.clear();
    fitCache_.emplace(std::move(key), result);
    return result;
}

TextRenderer::Entry* TextRenderer::get(const std::string& text, int px, SDL_Color color) {
    if (!info_ || text.empty()) return nullptr;
    char head[32];
    std::snprintf(head, sizeof head, "%d:%02X%02X%02X:", px, color.r, color.g, color.b);
    std::string key = head;
    key += text;
    auto it = cache_.find(key);
    if (it != cache_.end()) { it->second.used = frame_; return it->second.tex ? &it->second : nullptr; }

    auto* fi = static_cast<stbtt_fontinfo*>(info_);
    float scale = stbtt_ScaleForPixelHeight(fi, (float)px);
    int asc, desc, gap;
    stbtt_GetFontVMetrics(fi, &asc, &desc, &gap);
    int baseline = (int)std::ceil(asc * scale);
    int h = (int)std::ceil((asc - desc) * scale) + 2;
    int w = width(text, px) + 4;

    std::vector<unsigned char> alpha((size_t)w * h, 0);
    float penX = 1.f;
    for (size_t i = 0; i < text.size();) {
        unsigned cp = nextCodepoint(text, i);
        int adv, lsb;
        stbtt_GetCodepointHMetrics(fi, (int)cp, &adv, &lsb);
        int x0, y0, x1, y1;
        stbtt_GetCodepointBitmapBox(fi, (int)cp, scale, scale, &x0, &y0, &x1, &y1);
        int gx = (int)penX + x0, gy = baseline + y0;
        int gw = x1 - x0, gh = y1 - y0;
        if (gw > 0 && gh > 0 && gx >= 0 && gy >= 0 && gx + gw <= w && gy + gh <= h) {
            std::vector<unsigned char> glyph((size_t)gw * gh);
            stbtt_MakeCodepointBitmap(fi, glyph.data(), gw, gh, gw, scale, scale, (int)cp);
            for (int yy = 0; yy < gh; ++yy)
                for (int xx = 0; xx < gw; ++xx) {
                    unsigned char& dst = alpha[(size_t)(gy + yy) * w + gx + xx];
                    unsigned v = dst + glyph[(size_t)yy * gw + xx];
                    dst = (unsigned char)std::min(255u, v);
                }
        }
        penX += adv * scale;
    }

    std::vector<unsigned char> rgba((size_t)w * h * 4);
    for (size_t p = 0; p < (size_t)w * h; ++p) {
        rgba[p * 4 + 0] = color.r;
        rgba[p * 4 + 1] = color.g;
        rgba[p * 4 + 2] = color.b;
        rgba[p * 4 + 3] = alpha[p];
    }
    Entry e;
    e.tex = gfx::makeTexture(renderer_, rgba.data(), w, h);
    e.w = w; e.h = h; e.used = frame_;
    auto ins = cache_.emplace(key, e).first;
    return ins->second.tex ? &ins->second : nullptr;
}

void TextRenderer::draw(const std::string& text, int px, float x, float y, SDL_Color color, float alpha,
                        Align align, int maxWidth) {
    Entry* e = get(fit(text, px, maxWidth), px, color);
    if (!e) return;
    float dx = align == Center ? x - e->w / 2.f : (align == Right ? x - e->w : x);
    Uint8 a = (Uint8)(std::max(0.f, std::min(1.f, alpha)) * color.a + 0.5f);
    if (a != e->alphaSet) { SDL_SetTextureAlphaMod(e->tex, a); e->alphaSet = a; }
    SDL_Rect dst{(int)std::lround(dx), (int)std::lround(y), e->w, e->h};
    SDL_RenderCopy(renderer_, e->tex, nullptr, &dst);
}

void TextRenderer::endFrame() {
    ++frame_;
    if (cache_.size() < 600) return;
    for (auto it = cache_.begin(); it != cache_.end();) {
        if (frame_ - it->second.used > 120) {
            if (it->second.tex) SDL_DestroyTexture(it->second.tex);
            it = cache_.erase(it);
        } else ++it;
    }
}
