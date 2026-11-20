#include "ui.h"

#include "appinfo.h"
#include "config.h"
#include "gfx.h"
#include "json.h"
#include "i18n.h"
#include "http.h"
#include "platform.h"
#include "stb_image.h"

#include <orbis/ImeDialog.h>

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace {

SDL_Color kText{255, 255, 255, 255};
SDL_Color kMuted{159, 180, 214, 255};
SDL_Color kAccent{0, 112, 209, 255};
SDL_Color kCyan{46, 155, 255, 255};
SDL_Color kBorder{0, 114, 206, 255};
SDL_Color kBar{3, 11, 28, 255};
SDL_Color kBody{205, 220, 245, 255};
SDL_Color kSurface{8, 24, 58, 255};
const SDL_Color kBtnCross{96, 150, 255, 255};
const SDL_Color kBtnCircle{255, 107, 107, 255};
const SDL_Color kBtnTriangle{74, 222, 128, 255};
const SDL_Color kBtnSquare{244, 114, 182, 255};
const SDL_Color kWhite{255, 255, 255, 255};
const SDL_Color kHeart{255, 82, 108, 255};
const SDL_Color kGreen{48, 209, 88, 255};
const SDL_Color kOrange{255, 159, 10, 255};

const char* kPairAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

constexpr int COLS = 5;
constexpr float CARD = 300.f;
constexpr float GAP_X = 36.f;
constexpr float ROW_H = 410.f;
constexpr float GRID_TOP = 196.f;
constexpr float GRID_BOTTOM = 1016.f;
constexpr float GRID_LEFT = (Ui::W - (COLS * CARD + (COLS - 1) * GAP_X)) / 2.f;

}

Ui::Ui(SDL_Renderer* r, TextRenderer& text, ImageCache& images, Catalog& catalog, Downloader& dl, Input& input,
       const dns_block::Guard& dns, installed::Manager& inst, SelfUpdater& upd, plugin::Manager& plugins, payload::Sender& payloads, RemoteSync& remote)
    : r_(r), text_(text), images_(images), catalog_(catalog), dl_(dl), in_(input), dns_(dns), inst_(inst), upd_(upd),
      plugins_(plugins), payloads_(payloads), remote_(remote), bg_(r) {}

Ui::~Ui() {
    if (reportTh_.joinable()) reportTh_.join();
    for (auto& kv : roundTextures_) SDL_DestroyTexture(kv.second);
    for (auto& kv : ringTextures_) SDL_DestroyTexture(kv.second);
    for (auto& kv : iconTextures_) SDL_DestroyTexture(kv.second);
    if (gloss_) SDL_DestroyTexture(gloss_);
    if (logoTex_) SDL_DestroyTexture(logoTex_);
}


SDL_Texture* Ui::roundTex(int rad) {
    auto it = roundTextures_.find(rad);
    if (it != roundTextures_.end()) return it->second;
    const int n = rad * 2 + 2;
    std::vector<unsigned char> px((size_t)n * n * 4, 255);
    for (int y = 0; y < n; ++y)
        for (int x = 0; x < n; ++x) {
            float cx = x + 0.5f, cy = y + 0.5f;
            float dx = std::max(rad - cx, cx - (n - rad));
            float dy = std::max(rad - cy, cy - (n - rad));
            float a = 1.f;
            if (dx > 0.f && dy > 0.f) {
                float d = std::sqrt(dx * dx + dy * dy) - rad;
                a = d <= -0.5f ? 1.f : (d >= 0.5f ? 0.f : 0.5f - d);
            }
            px[((size_t)y * n + x) * 4 + 3] = (unsigned char)(a * 255.f);
        }
    SDL_Texture* t = gfx::makeTexture(r_, px.data(), n, n);
    roundTextures_[rad] = t;
    return t;
}

void Ui::fillRound(float x, float y, float w, float h, float rad, SDL_Color c, float alpha) {
    if (w < 1.f || h < 1.f || alpha <= 0.f) return;
    Uint8 a = (Uint8)(anim::clamp01(alpha) * c.a + 0.5f);
    if (a == 0) return;
    int rr = (int)std::lround(std::min({rad, w / 2.f, h / 2.f}));
    int X = (int)std::lround(x), Y = (int)std::lround(y), Wd = (int)std::lround(w), Ht = (int)std::lround(h);
    if (rr * 2 > Wd) rr = Wd / 2;
    if (rr * 2 > Ht) rr = Ht / 2;

    SDL_SetRenderDrawBlendMode(r_, a == 255 ? SDL_BLENDMODE_NONE : SDL_BLENDMODE_BLEND);
    SDL_SetRenderDrawColor(r_, c.r, c.g, c.b, a);

    if (rr < 1) {
        SDL_Rect rc{X, Y, Wd, Ht};
        SDL_RenderFillRect(r_, &rc);
        return;
    }
    SDL_Rect body[3];
    int nb = 0;
    if (Ht - 2 * rr > 0) body[nb++] = SDL_Rect{X, Y + rr, Wd, Ht - 2 * rr};
    if (Wd - 2 * rr > 0) {
        body[nb++] = SDL_Rect{X + rr, Y, Wd - 2 * rr, rr};
        body[nb++] = SDL_Rect{X + rr, Y + Ht - rr, Wd - 2 * rr, rr};
    }
    if (nb) SDL_RenderFillRects(r_, body, nb);

    SDL_Texture* t = roundTex(rr);
    if (!t) {
        SDL_Rect corners[4] = {{X, Y, rr, rr}, {X + Wd - rr, Y, rr, rr}, {X, Y + Ht - rr, rr, rr}, {X + Wd - rr, Y + Ht - rr, rr, rr}};
        SDL_RenderFillRects(r_, corners, 4);
        return;
    }
    SDL_SetTextureColorMod(t, c.r, c.g, c.b);
    SDL_SetTextureAlphaMod(t, a);
    const int n = rr * 2 + 2;
    const SDL_Rect src[4] = {{0, 0, rr, rr}, {n - rr, 0, rr, rr}, {0, n - rr, rr, rr}, {n - rr, n - rr, rr, rr}};
    const SDL_Rect dst[4] = {{X, Y, rr, rr}, {X + Wd - rr, Y, rr, rr}, {X, Y + Ht - rr, rr, rr}, {X + Wd - rr, Y + Ht - rr, rr, rr}};
    for (int i = 0; i < 4; ++i) SDL_RenderCopy(r_, t, &src[i], &dst[i]);
}

SDL_Texture* Ui::ringTex(int rad) {
    auto it = ringTextures_.find(rad);
    if (it != ringTextures_.end()) return it->second;
    const int n = rad * 2 + 2;
    std::vector<unsigned char> px((size_t)n * n * 4, 255);
    for (int y = 0; y < n; ++y)
        for (int x = 0; x < n; ++x) {
            float cx = x + 0.5f, cy = y + 0.5f;
            float dx = std::max(rad - cx, cx - (n - rad));
            float dy = std::max(rad - cy, cy - (n - rad));
            float a = 0.f;
            if (dx > 0.f && dy > 0.f) {
                float d = std::sqrt(dx * dx + dy * dy);
                a = std::min(rad - d + 0.5f, d - (rad - 2.f) + 0.5f);
                a = a < 0.f ? 0.f : (a > 1.f ? 1.f : a);
            }
            px[((size_t)y * n + x) * 4 + 3] = (unsigned char)(a * 255.f);
        }
    SDL_Texture* t = gfx::makeTexture(r_, px.data(), n, n);
    ringTextures_[rad] = t;
    return t;
}

void Ui::ringRound(float x, float y, float w, float h, float rad, SDL_Color c, float alpha) {
    Uint8 a = (Uint8)(anim::clamp01(alpha) * c.a + 0.5f);
    if (w < 8.f || h < 8.f || a == 0) return;
    int rr = (int)std::lround(std::min({rad, w / 2.f, h / 2.f}));
    const int X = (int)std::lround(x), Y = (int)std::lround(y), Wd = (int)std::lround(w), Ht = (int)std::lround(h);
    if (rr < 3) rr = 3;
    SDL_SetRenderDrawBlendMode(r_, a == 255 ? SDL_BLENDMODE_NONE : SDL_BLENDMODE_BLEND);
    SDL_SetRenderDrawColor(r_, c.r, c.g, c.b, a);
    const SDL_Rect strips[4] = {{X + rr, Y, Wd - 2 * rr, 2}, {X + rr, Y + Ht - 2, Wd - 2 * rr, 2},
                                {X, Y + rr, 2, Ht - 2 * rr}, {X + Wd - 2, Y + rr, 2, Ht - 2 * rr}};
    SDL_RenderFillRects(r_, strips, 4);
    SDL_Texture* t = ringTex(rr);
    if (!t) return;
    SDL_SetTextureColorMod(t, c.r, c.g, c.b);
    SDL_SetTextureAlphaMod(t, a);
    const int n = rr * 2 + 2;
    const SDL_Rect src[4] = {{0, 0, rr, rr}, {n - rr, 0, rr, rr}, {0, n - rr, rr, rr}, {n - rr, n - rr, rr, rr}};
    const SDL_Rect dst[4] = {{X, Y, rr, rr}, {X + Wd - rr, Y, rr, rr}, {X, Y + Ht - rr, rr, rr}, {X + Wd - rr, Y + Ht - rr, rr, rr}};
    for (int i = 0; i < 4; ++i) SDL_RenderCopy(r_, t, &src[i], &dst[i]);
}

void Ui::glassPanel(float x, float y, float w, float h, float rad, bool opaque) {
    (void)opaque;
    fillRound(x, y, w, h, std::min(rad, 12.f), kSurface, 1.f);
}

void Ui::panelOpaque(float x, float y, float w, float h, float rad) { glassPanel(x, y, w, h, rad); }

void Ui::panel(float x, float y, float w, float h, float rad, float alpha) {
    fillRound(x, y, w, h, std::min(rad, 12.f), kSurface, 0.94f * alpha);
}


namespace {
float segDist(float px, float py, float ax, float ay, float bx, float by) {
    const float vx = bx - ax, vy = by - ay;
    float t = ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy);
    t = t < 0.f ? 0.f : (t > 1.f ? 1.f : t);
    const float dx = px - (ax + t * vx), dy = py - (ay + t * vy);
    return std::sqrt(dx * dx + dy * dy);
}

bool symbolHit(PsBtn b, float fx, float fy, float N) {
    const float tw = 0.075f * N;
    switch (b) {
        case PsBtn::Cross:
            return std::max(std::fabs(fx), std::fabs(fy)) <= 0.25f * N && std::min(std::fabs(fx - fy), std::fabs(fx + fy)) * 0.7071f <= tw;
        case PsBtn::Circle:
            return std::fabs(std::sqrt(fx * fx + fy * fy) - 0.25f * N) <= tw;
        case PsBtn::Square:
            return std::fabs(std::max(std::fabs(fx), std::fabs(fy)) - 0.22f * N) <= tw;
        case PsBtn::Triangle: {
            const float ax = 0.f, ay = -0.27f * N, bx = -0.27f * N, by = 0.20f * N, cx = 0.27f * N, cy = 0.20f * N;
            return std::min({segDist(fx, fy, ax, ay, bx, by), segDist(fx, fy, bx, by, cx, cy), segDist(fx, fy, cx, cy, ax, ay)}) <= tw;
        }
        default: return false;
    }
}

SDL_Color btnColor(PsBtn b) {
    switch (b) {
        case PsBtn::Cross: return kBtnCross;
        case PsBtn::Circle: return kBtnCircle;
        case PsBtn::Triangle: return kBtnTriangle;
        default: return kBtnSquare;
    }
}
}

SDL_Texture* Ui::iconTex(PsBtn b, int size) {
    const int key = (int)b * 1000 + size;
    auto it = iconTextures_.find(key);
    if (it != iconTextures_.end()) return it->second;
    const int N = size, SS = 3;
    const SDL_Color col = btnColor(b);
    const float R = N / 2.f - 0.5f;
    std::vector<unsigned char> px((size_t)N * N * 4, 0);
    for (int y = 0; y < N; ++y)
        for (int x = 0; x < N; ++x) {
            float pr = 0, pg = 0, pb = 0, pa = 0;
            for (int sy = 0; sy < SS; ++sy)
                for (int sx = 0; sx < SS; ++sx) {
                    const float fx = x + (sx + 0.5f) / SS - N / 2.f, fy = y + (sy + 0.5f) / SS - N / 2.f;
                    const float dist = std::sqrt(fx * fx + fy * fy);
                    float r = 0, g = 0, bl = 0, a = 0;
                    auto layer = [&](float lr, float lg, float lb, float la) {
                        r = lr * la + r * (1 - la); g = lg * la + g * (1 - la); bl = lb * la + bl * (1 - la); a = la + a * (1 - la);
                    };
                    if (dist <= R && symbolHit(b, fx, fy, (float)N)) layer(col.r, col.g, col.b, 1.f);
                    pr += r; pg += g; pb += bl; pa += a;
                }
            unsigned char* o = &px[((size_t)y * N + x) * 4];
            if (pa > 0.f) {
                o[0] = (unsigned char)std::min(255.f, pr / pa); o[1] = (unsigned char)std::min(255.f, pg / pa);
                o[2] = (unsigned char)std::min(255.f, pb / pa); o[3] = (unsigned char)(255.f * pa / (SS * SS));
            }
        }
    SDL_Texture* t = gfx::makeTexture(r_, px.data(), N, N);
    iconTextures_[key] = t;
    return t;
}

float Ui::psIconWidth(PsBtn b, int size) {
    switch (b) {
        case PsBtn::L1: return text_.width("L1", 17) + 26.f;
        case PsBtn::R1: return text_.width("R1", 17) + 26.f;
        case PsBtn::Options: return text_.width("OPTIONS", 15) + 26.f;
        case PsBtn::Touchpad: return size * 1.6f;
        default: return (float)size;
    }
}

float Ui::drawPsButtonIcon(PsBtn b, float x, float y, int size, float alpha) {
    const float w = psIconWidth(b, size);
    if (b == PsBtn::L1 || b == PsBtn::R1 || b == PsBtn::Options) {
        const float h = size * 0.82f, py = y + (size - h) / 2.f;
        fillRound(x, py, w, h, h * 0.3f, SDL_Color{208, 214, 226, 255}, alpha);
        const char* label = b == PsBtn::L1 ? "L1" : b == PsBtn::R1 ? "R1" : "OPTIONS";
        text_.draw(label, b == PsBtn::Options ? 15 : 17, x + w / 2, py + (b == PsBtn::Options ? 5.f : 4.f), SDL_Color{12, 22, 48, 255}, alpha, TextRenderer::Center);
        return w;
    }
    if (b == PsBtn::Touchpad) {
        const float h = size * 0.78f, py = y + (size - h) / 2.f;
        fillRound(x, py, w, h, h * 0.26f, SDL_Color{208, 214, 226, 255}, alpha);
        fillRound(x + w * 0.26f, py + h * 0.62f, w * 0.48f, h * 0.1f, h * 0.05f, SDL_Color{20, 24, 34, 255}, alpha);
        return w;
    }
    if (SDL_Texture* t = iconTex(b, size)) {
        SDL_SetTextureAlphaMod(t, (Uint8)(anim::clamp01(alpha) * 255));
        SDL_Rect d{(int)std::lround(x), (int)std::lround(y), size, size};
        SDL_RenderCopy(r_, t, nullptr, &d);
    }
    return w;
}

void Ui::drawButton(float x, float y, float w, float h, PsBtn icon, const std::string& label, bool primary) {
    if (primary) fillRound(x, y, w, h, 8.f, kAccent, 1.f);
    else {
        fillRound(x, y, w, h, 8.f, kBorder, 0.5f);
        fillRound(x + 1.5f, y + 1.5f, w - 3.f, h - 3.f, 6.5f, kSurface, 1.f);
    }
    const int is = 30;
    const float iw = psIconWidth(icon, is), tw = (float)text_.width(label, 22);
    const float sx = x + (w - (iw + 12.f + tw)) / 2.f;
    drawPsButtonIcon(icon, sx, y + (h - is) / 2.f, is);
    text_.draw(label, 22, sx + iw + 12.f, y + (h - 22.f) / 2.f - 2.f, primary ? kWhite : kText);
}

void Ui::drawBadge(const std::string& label, float x, float y, SDL_Color c, float alpha) {
    const float h = 30.f, w = (float)text_.width(label, 17) + 28.f;
    fillRound(x - 1.f, y - 1.f, w + 2.f, h + 2.f, h / 2 + 1.f, c, 0.55f * alpha);
    fillRound(x, y, w, h, h / 2, SDL_Color{4, 12, 34, 255}, 0.78f * alpha);
    text_.draw(label, 17, x + w / 2, y + 5.f, c, alpha, TextRenderer::Center);
}

void Ui::drawGloss(float x, float y, float size, float alpha) {
    if (!gloss_) {
        const int GW = 32, GH = 32;
        std::vector<unsigned char> px((size_t)GW * GH * 4);
        for (int yy = 0; yy < GH; ++yy)
            for (int xx = 0; xx < GW; ++xx) {
                const float v = 1.f - (float)yy / GH;
                const float diag = 0.65f + 0.35f * (1.f - (float)xx / GW);
                unsigned char* o = &px[((size_t)yy * GW + xx) * 4];
                o[0] = o[1] = o[2] = 255;
                o[3] = (unsigned char)(70.f * v * v * diag);
            }
        gloss_ = gfx::makeTexture(r_, px.data(), GW, GH);
    }
    if (!gloss_) return;
    SDL_SetTextureAlphaMod(gloss_, (Uint8)(anim::clamp01(alpha) * 255));
    SDL_Rect d{(int)std::lround(x), (int)std::lround(y), (int)std::lround(size), (int)std::lround(size * 0.42f)};
    SDL_RenderCopy(r_, gloss_, nullptr, &d);
}

std::vector<std::string> Ui::wrap(const std::string& s, int px, int maxW, int maxLines) {
    std::vector<std::string> lines;
    std::string cur, word;
    auto flushWord = [&] {
        if (word.empty()) return;
        std::string t = cur.empty() ? word : cur + " " + word;
        if (!cur.empty() && text_.width(t, px) > maxW) { lines.push_back(cur); cur = word; }
        else cur = t;
        word.clear();
    };
    for (char c : s) {
        if (c == ' ' || c == '\n') flushWord();
        else word += c;
    }
    flushWord();
    if (!cur.empty()) lines.push_back(cur);
    if ((int)lines.size() > maxLines) {
        lines.resize(maxLines);
        lines.back() += "\xE2\x80\xA6";
    }
    return lines;
}


const Game* Ui::selectedGame() const {
    if (sel_ < 0 || sel_ >= (int)filtered_.size()) return nullptr;
    if (filtered_[sel_] < 0 || filtered_[sel_] >= (int)games_.size()) return nullptr;
    return &games_[filtered_[sel_]];
}

installed::State Ui::stateOf(const Game& g, std::string* installedVersion) const {
    const std::string& t = g.resource_type;
    if (t == "plugin") return pluginPresent_.count(g.id) ? installed::State::UpToDate : installed::State::NotInstalled;
    if (t == "payload" || t == "dlc") return installed::State::NotInstalled;
    if (g.title_id.empty()) return installed::State::NotInstalled;
    auto it = instMap_.find(g.title_id);
    const installed::Entry* e = it == instMap_.end() ? nullptr : &it->second;
    if (installedVersion) *installedVersion = e ? e->version : std::string();
    if (t == "update") {
        if (!e || !e->installed || e->version.empty()) return installed::State::NotInstalled;
        return installed::compareVersions(e->version, g.version) >= 0 ? installed::State::UpToDate : installed::State::NotInstalled;
    }
    return installed::classify(g, e);
}

bool Ui::baseInstalled(const Game& g) const {
    const std::string& id = g.parent_title_id.empty() ? g.title_id : g.parent_title_id;
    auto it = instMap_.find(id);
    return it != instMap_.end() && it->second.installed;
}

bool Ui::canUninstall(const Game& g, installed::State st) const {
    if (g.resource_type == "plugin") return st == installed::State::UpToDate;
    return g.resource_type == "pkg" && st != installed::State::NotInstalled;
}

std::string Ui::primaryLabel(const Game& g, installed::State st) const {
    const std::string& t = g.resource_type;
    if (t == "payload") return i18n::tr("ps4.send");
    if (t == "update" && st == installed::State::UpToDate) return std::string();
    if (t == "pkg" && st == installed::State::UpToDate) return i18n::tr("ps4.launch");
    if (st == installed::State::UpdateAvailable) return i18n::tr("ps4.update");
    return i18n::tr("ps4.install");
}

std::string Ui::tabLabel(int i) const {
    switch (tabKind(i)) {
        case K_ALL: return i18n::tr("ps4.tab.all");
        case K_NEW: return i18n::tr("ps4.tab.new");
        case K_FEATURED: return i18n::tr("ps4.tab.featured");
        case K_INSTALLED: return i18n::tr("ps4.tab.installed");
        case K_LIBRARY: return i18n::tr("ps4.tab.library");
        default: return i18n::tr("ps4.tab.settings");
    }
}

std::string Ui::typeLabel(const Game& g) const { return i18n::tr("ps4.type." + g.resource_type); }

void Ui::notify(bool ok, const std::string& msg, float seconds) {
    toastMsg_ = msg;
    toastOk_ = ok;
    toastTimer_ = seconds;
    toastA_.set(1.f);
}

void Ui::rebuildRelated() {
    related_.clear();
    const Game* g = selectedGame();
    if (g && g->resource_type == "pkg" && !g->title_id.empty())
        for (int i = 0; i < (int)games_.size(); ++i)
            if (games_[i].resource_type != "pkg" && games_[i].parent_title_id == g->title_id) related_.push_back(i);
    if (relSel_ >= (int)related_.size()) relSel_ = std::max(0, (int)related_.size() - 1);
}

void Ui::beginPlugin(const Game& g) {
    if (offline()) { notify(false, i18n::tr("ps4.offline_blocked")); return; }
    if (plugins_.busy()) return;
    const plugin::Plan plan = plugin::planFor(g);
    const int sup = plan.supportedMask(), inst = plan.installedMask();
    platform::bootLogf("plugin: %s regions=%s EU(%s)=%d US(%s)=%d", g.titre.c_str(), g.regions.c_str(), g.eu.title_id.c_str(), plan.euInstalled,
                       g.us.title_id.c_str(), plan.usInstalled);
    if (!sup) { notify(false, i18n::tr("ps4.plugin.fail", {{"err", "Title ID"}})); return; }
    pending_ = g;
    if (inst == (plugin::REGION_EU | plugin::REGION_US)) { modal_ = Modal::Region; regionSel_ = 0; }
    else if (inst != 0) plugins_.install(g, inst);
    else modal_ = Modal::Force;
}

void Ui::activate(const Game& g, installed::State st) {
    const std::string& t = g.resource_type;
    if (t == "pkg" && st == installed::State::UpToDate) { if (!inst_.busy()) inst_.launch(g.title_id, g.titre); return; }
    if (t == "update" && st == installed::State::UpToDate) { notify(true, i18n::tr("ps4.already_installed")); return; }
    if (t == "payload") {
        if (offline()) notify(false, i18n::tr("ps4.offline_blocked"));
        else if (!payloads_.busy()) payloads_.send(g);
        return;
    }
    if (t == "plugin") { beginPlugin(g); return; }
    if (offline()) { notify(false, i18n::tr("ps4.offline_blocked")); return; }
    if ((t == "update" || t == "dlc") && !baseInstalled(g)) { notify(false, i18n::tr("ps4.base_missing")); return; }
    dl_.start(g);
    detail_ = false;
    relatedOpen_ = false;
    detailA_.snap(0.f);
}

void Ui::applyTheme() {
    const settings::Palette& p = settings::palette(cfg_.theme);
    kText = p.text; kMuted = p.muted; kAccent = p.accent; kCyan = p.cyan; kBorder = p.border; kSurface = p.surface;
    kBody = p.body; kBar = p.bar;
    bg_.setGradient(p.grad[0], p.grad[1], p.grad[2], p.grad[3], p.grad[4], p.grad[5], p.grad[6], p.grad[7], p.grad[8]);
}

void Ui::applyLanguage() {
    i18n::setIndex(i18n::indexOf(cfg_.lang) < 0 ? 0 : i18n::indexOf(cfg_.lang));
    tabsMeasured_ = false;
}

void Ui::saveSettings() {
    if (!settings::save(cfg_)) platform::bootLog("settings: ecriture impossible");
}

void Ui::initSettings(const settings::Values& v) {
    cfg_ = v;
    applyTheme();
    applyLanguage();
}

void Ui::rescan() {
    std::vector<std::string> ids;
    for (const auto& g : games_)
        if (!g.title_id.empty() && std::find(ids.begin(), ids.end(), g.title_id) == ids.end()) ids.push_back(g.title_id);
    inst_.refresh(ids);
    plugins_.refresh(games_);
}


namespace {
const char* const* kbRows() {
    static const char* const azerty[4] = {"1234567890", "azertyuiop", "qsdfghjklm", "wxcvbn'.-_"};
    static const char* const qwerty[4] = {"1234567890", "qwertyuiop", "asdfghjkl-", "zxcvbnm'._"};
    return std::string(i18n::kCodes[i18n::index()]) == "fr" ? azerty : qwerty;
}
char kbChar(int i) { return kbRows()[i / 10][i % 10]; }

std::string foldKey(const std::string& s) {
    std::string o; o.reserve(s.size());
    for (size_t i = 0; i < s.size(); ++i) {
        const unsigned char c = (unsigned char)s[i];
        if (c == 0xC3 && i + 1 < s.size()) {
            const unsigned char d = (unsigned char)s[++i];
            const unsigned char e = (d >= 0x80 && d <= 0x9F) ? (unsigned char)(d + 0x20) : d;
            char r = '?';
            if (e >= 0xA0 && e <= 0xA5) r = 'a'; else if (e == 0xA7) r = 'c'; else if (e >= 0xA8 && e <= 0xAB) r = 'e';
            else if (e >= 0xAC && e <= 0xAF) r = 'i'; else if (e == 0xB1) r = 'n'; else if (e >= 0xB2 && e <= 0xB6) r = 'o';
            else if (e >= 0xB9 && e <= 0xBC) r = 'u'; else if (e == 0xBD || e == 0xBF) r = 'y';
            o += r;
        } else o += (c >= 'A' && c <= 'Z') ? (char)(c + 32) : (char)c;
    }
    return o;
}
}

bool Ui::matchesQuery(const Game& g) const {
    if (query_.empty()) return true;
    const std::string hay = foldKey(g.titre + " " + g.title_id + " " + g.categorie + " " + g.author_name);
    const std::string q = foldKey(query_);
    size_t i = 0;
    while (i < q.size()) {
        while (i < q.size() && q[i] == ' ') ++i;
        size_t j = i;
        while (j < q.size() && q[j] != ' ') ++j;
        if (j > i && hay.find(q.substr(i, j - i)) == std::string::npos) return false;
        i = j;
    }
    return true;
}

void Ui::rebuildFilter(const std::string& keepId) {
    filtered_.clear();
    for (int i = 0; i < (int)games_.size(); ++i) {
        const std::string& rt = games_[i].resource_type;
        const TabKind kind = tabKind(tab_);
        bool ok = kind == K_FEATURED ? games_[i].featuredRank > 0
                : kind == K_LIBRARY ? libraryIds_.count(games_[i].id) > 0
                : kind == K_INSTALLED ? ((rt == "pkg" || rt == "plugin") && stateOf(games_[i]) != installed::State::NotInstalled)
                : kind == K_NEW ? !games_[i].updated_at.empty()
                                : true;
        if (ok && matchesQuery(games_[i])) filtered_.push_back(i);
    }
    {
        const TabKind kd = tabKind(tab_);
        if (cfg_.sort != 0 && (kd == K_ALL || kd == K_INSTALLED || kd == K_LIBRARY)) {
            std::stable_sort(filtered_.begin(), filtered_.end(), [this](int a, int b) {
                const Game& x = games_[a];
                const Game& y = games_[b];
                if (cfg_.sort == 1) return foldKey(x.titre) < foldKey(y.titre);
                if (cfg_.sort == 2) return x.updated_at > y.updated_at;
                return x.likes > y.likes;
            });
        }
    }
    if (tabKind(tab_) == K_NEW) {
        std::stable_sort(filtered_.begin(), filtered_.end(), [this](int a, int b) { return games_[a].updated_at > games_[b].updated_at; });
        if (filtered_.size() > 24) filtered_.resize(24);
    }
    if (tabKind(tab_) == K_FEATURED)
        std::stable_sort(filtered_.begin(), filtered_.end(), [this](int a, int b) { return games_[a].featuredRank < games_[b].featuredRank; });
    if (!keepId.empty())
        for (int k = 0; k < (int)filtered_.size(); ++k)
            if (games_[filtered_[k]].id == keepId) { sel_ = k; break; }
    sel_ = std::min(sel_, std::max(0, (int)filtered_.size() - 1));
    cardScale_.assign(filtered_.size(), anim::Smooth(1.f, 38.f));
    ensureVisible();
}

void Ui::setTab(int t) {
    t = std::max(0, std::min(tabCount() - 1, t));
    if (tabKind(t) == K_SETTINGS) {
        settings_ = true; setRow_ = 0; refreshDisk();
        pillX_.set(tabX_[t]);
        pillW_.set(tabW_[t]);
        return;
    }
    if (t == tab_) return;
    tab_ = t;
    sel_ = 0;
    rebuildFilter();
    scrollY_.snap(0.f);
    scrollTarget_ = 0.f;
    gridAlpha_.snap(0.f);
    gridAlpha_.set(1.f);
    pillX_.set(tabX_[tab_]);
    pillW_.set(tabW_[tab_]);
}

void Ui::ensureVisible() {
    int row = sel_ / COLS;
    float top = row * ROW_H;
    float viewH = GRID_BOTTOM - GRID_TOP;
    float t = scrollTarget_;
    if (top < t) t = top;
    else if (top + ROW_H - 40.f > t + viewH) t = top + ROW_H - 40.f - viewH;
    int rows = ((int)filtered_.size() + COLS - 1) / COLS;
    float maxScroll = std::max(0.f, rows * ROW_H - viewH);
    scrollTarget_ = anim::clampf(t, 0.f, maxScroll);
    scrollY_.set(scrollTarget_);
}

void Ui::update(float dt) {
    updPoll_ += dt;
    if (updPoll_ >= 60.f) { updPoll_ = 0.f; upd_.check(false); }
    time_ += dt;
    bg_.update(dt);

    avgDt_ += (std::min(dt, 0.1f) - avgDt_) * 0.06f;
    if (++qFrames_ >= 90) {
        qFrames_ = 0;
        if (avgDt_ > 0.021f && quality_ > 0) {
            qualityMax_ = quality_ - 1;
            --quality_;
            qGood_ = 0;
            platform::bootLogf("ui: image moyenne %.1f ms -> qualite des effets %d", avgDt_ * 1000.f, quality_);
        } else if (avgDt_ < 0.0185f && quality_ < qualityMax_) {
            if (++qGood_ >= 4) { ++quality_; qGood_ = 0; platform::bootLogf("ui: image moyenne %.1f ms -> qualite des effets %d", avgDt_ * 1000.f, quality_); }
        } else qGood_ = 0;
    }

    if (!tabsMeasured_) {
        float total = 0.f, gap = 6.f;
        const int nTabs = tabCount();
        for (int i = 0; i < nTabs; ++i) { tabW_[i] = text_.width(tabLabel(i), 24) + 44.f + 0.f; total += tabW_[i] + (i ? gap : 0); }
        float x = W - 96.f - total;
        for (int i = 0; i < nTabs; ++i) { tabX_[i] = x; x += tabW_[i] + gap; }
        pillX_.snap(tabX_[tab_]);
        pillW_.snap(tabW_[tab_]);
        tabsMeasured_ = true;
    }

    std::string prevId;
    if (const Game* cur = selectedGame()) prevId = cur->id;
    if (catalog_.snapshot(games_, catalogVersion_)) {
        requested_ = false;
        rebuildFilter(prevId);
        if (catalog_.fromCache() && !offlineWarned_) { offlineWarned_ = true; alerts_.push_back(i18n::tr("ps4.alert.offline")); }
        if (!catalog_.fromCache()) offlineWarned_ = false;
        rescan();
        rescanTimer_ = 8.f;
    }
    if (inst_.snapshot(instMap_, instVersion_)) rebuildFilter(prevId);
    if (plugins_.snapshot(pluginPresent_, pluginVersion_)) rebuildFilter(prevId);
    if (!requested_ && !games_.empty()) {
        for (const auto& g : games_) images_.request(g);
        requested_ = true;
    }

    bool modalDl = dl_.phase() == Downloader::Phase::Preparing;

    if (imeActive_) {
        pollIme();
    } else if (!alerts_.empty()) {
        if (in_.pressed(B_CROSS) || in_.pressed(B_CIRCLE)) alerts_.erase(alerts_.begin());
    } else if (modalDl) {
        if (in_.pressed(B_CIRCLE)) dl_.cancel();
    } else if (pairOpen_) {
        const bool working = remote_.pairState() == RemoteSync::PairState::Working;
        if (in_.pressed(B_CIRCLE) && !working) { pairOpen_ = false; pairWaiting_ = false; }
        else if (!working) {
            if (in_.pressed(B_TRIANGLE)) startIme(1);
            if (in_.pressed(B_LEFT) && pairCursor_ % 8 > 0) --pairCursor_;
            if (in_.pressed(B_RIGHT) && pairCursor_ % 8 < 7) ++pairCursor_;
            if (in_.pressed(B_UP) && pairCursor_ >= 8) pairCursor_ -= 8;
            if (in_.pressed(B_DOWN) && pairCursor_ < 24) pairCursor_ += 8;
            if (in_.pressed(B_CROSS) && pairCode_.size() < 6) { pairCode_ += kPairAlphabet[pairCursor_]; pairError_.clear(); }
            if (in_.pressed(B_SQUARE) && !pairCode_.empty()) pairCode_.pop_back();
            if (in_.pressed(B_OPTIONS) && pairCode_.size() == 6) {
                if (offline()) pairError_ = i18n::tr("ps4.offline_blocked");
                else { pairError_.clear(); pairWaiting_ = true; remote_.pair(pairCode_, "PS4"); }
            }
        }
    } else if (searchOpen_) {
        if (in_.pressed(B_CIRCLE) || in_.pressed(B_OPTIONS) || in_.pressed(B_TOUCHPAD)) searchOpen_ = false;
        else {
            if (in_.pressed(B_LEFT)) kbCursor_ = (kbCursor_ / 10) * 10 + (kbCursor_ % 10 + 9) % 10;
            if (in_.pressed(B_RIGHT)) kbCursor_ = (kbCursor_ / 10) * 10 + (kbCursor_ % 10 + 1) % 10;
            if (in_.pressed(B_UP)) kbCursor_ = (kbCursor_ + 30) % 40;
            if (in_.pressed(B_DOWN)) kbCursor_ = (kbCursor_ + 10) % 40;
            bool changed = false;
            if (in_.pressed(B_CROSS) && query_.size() < 40) { query_ += kbChar(kbCursor_); changed = true; }
            if (in_.pressed(B_SQUARE) && !query_.empty()) { query_.pop_back(); changed = true; }
            if (in_.pressed(B_TRIANGLE) && !query_.empty() && query_.back() != ' ' && query_.size() < 40) { query_ += ' '; changed = true; }
            if (in_.pressed(B_L1) && !query_.empty()) { query_.clear(); changed = true; }
            if (changed) { sel_ = 0; rebuildFilter(); }
        }
    } else if (modal_ == Modal::Region) {
        if (in_.pressed(B_CIRCLE)) modal_ = Modal::None;
        else {
            if (in_.pressed(B_LEFT)) regionSel_ = std::max(0, regionSel_ - 1);
            if (in_.pressed(B_RIGHT)) regionSel_ = std::min(2, regionSel_ + 1);
            if (in_.pressed(B_CROSS)) {
                modal_ = Modal::None;
                plugins_.install(pending_, regionSel_ == 0 ? plugin::REGION_EU : regionSel_ == 1 ? plugin::REGION_US : (plugin::REGION_EU | plugin::REGION_US));
            }
        }
    } else if (modal_ == Modal::Force) {
        if (in_.pressed(B_CIRCLE)) modal_ = Modal::None;
        else if (in_.pressed(B_CROSS)) { modal_ = Modal::None; plugins_.install(pending_, plugin::planFor(pending_).supportedMask()); }
    } else if (historyOpen_) {
        const int hn = (int)upd_.history().size();
        if (in_.pressed(B_CIRCLE) || in_.pressed(B_TRIANGLE) || in_.pressed(B_OPTIONS)) historyOpen_ = false;
        else {
            if (in_.pressed(B_UP) && histSel_ > 0) --histSel_;
            if (in_.pressed(B_DOWN) && histSel_ + 1 < hn) ++histSel_;
        }
    } else if (settings_) {
        if (in_.pressed(B_CIRCLE) || in_.pressed(B_OPTIONS) || in_.pressed(B_L1) || in_.pressed(B_R1)) { settings_ = false; pillX_.set(tabX_[tab_]); pillW_.set(tabW_[tab_]); }
        else {
            if (in_.pressed(B_TRIANGLE)) { historyOpen_ = true; histSel_ = 0; }
            if (in_.pressed(B_UP) && setRow_ > 0) --setRow_;
            if (in_.pressed(B_DOWN) && setRow_ < 5) ++setRow_;
            const int d = (in_.pressed(B_RIGHT) || (in_.pressed(B_CROSS) && setRow_ < 3)) ? 1 : in_.pressed(B_LEFT) ? -1 : 0;
            if (setRow_ == 0 && d != 0) {
                const int idx = (i18n::index() + d + i18n::COUNT) % i18n::COUNT;
                cfg_.lang = i18n::kCodes[idx];
                applyLanguage();
                saveSettings();
            } else if (setRow_ == 2 && d != 0) {
                cfg_.sort = (cfg_.sort + d + 4) % 4;
                saveSettings();
                rebuildFilter();
            } else if (setRow_ == 1 && d != 0) {
                cfg_.theme = (cfg_.theme + d + settings::THEMES) % settings::THEMES;
                applyTheme();
                saveSettings();
            } else if (setRow_ == 3 && in_.pressed(B_CROSS) && upd_.state() == SelfUpdater::State::Ready) {
                std::string perr;
                if (upd_.canApply(perr)) { applyRequested_ = true; notify(true, i18n::tr("ps4.upd.applying"), 8.f); }
                else { platform::bootLogf("auto-update: %s", perr.c_str()); alerts_.push_back(i18n::tr("ps4.upd.apply_fail")); }
            } else if (setRow_ == 3 && in_.pressed(B_CROSS)) {
                manualCheck_ = true;
                upd_.check(true);
                notify(true, i18n::tr("ps4.set.checking"), 2.5f);
            } else if (setRow_ == 4 && in_.pressed(B_CROSS)) {
                images_.clearAll();
                const int n = platform::clearDirectory(config::CACHE_DIR);
                requested_ = false;
                catalog_.refresh();
                notify(true, i18n::tr("ps4.set.cache_cleared", {{"n", std::to_string(n)}}));
            } else if (setRow_ == 5 && in_.pressed(B_CROSS)) {
                if (remote_.paired()) {
                    remote_.unlink();
                    cfg_.device_token.clear();
                    cfg_.paired_username.clear();
                    saveSettings();
                    tabsMeasured_ = false;
                    if (tabKind(tab_) == K_LIBRARY) setTab(2);
                    notify(true, i18n::tr("ps4.pair.unlinked"));
                } else {
                    pairOpen_ = true; pairWaiting_ = false; pairCode_.clear(); pairError_.clear(); pairCursor_ = 0;
                    startIme(1);
                }
            }
        }
    } else if (relatedOpen_) {
        rebuildRelated();
        const int n = (int)related_.size();
        if (n == 0 || in_.pressed(B_CIRCLE)) relatedOpen_ = false;
        else {
            if (in_.pressed(B_UP) && relSel_ > 0) --relSel_;
            if (in_.pressed(B_DOWN) && relSel_ + 1 < n) ++relSel_;
            if (in_.pressed(B_CROSS)) { const Game& rg = games_[related_[relSel_]]; activate(rg, stateOf(rg)); }
        }
    } else if (confirmSelfUpdate_) {
        if (in_.pressed(B_CIRCLE) || upd_.state() != SelfUpdater::State::Ready) confirmSelfUpdate_ = false;
        else if (in_.pressed(B_CROSS)) {
            confirmSelfUpdate_ = false;
            std::string perr;
            if (upd_.canApply(perr)) { applyRequested_ = true; notify(true, i18n::tr("ps4.upd.applying"), 8.f); }
            else { platform::bootLogf("auto-update: %s", perr.c_str()); alerts_.push_back(i18n::tr("ps4.upd.apply_fail")); }
        }
    } else if (confirmUninstall_) {
        const Game* g = selectedGame();
        if (!g || in_.pressed(B_CIRCLE)) confirmUninstall_ = false;
        else if (in_.pressed(B_CROSS)) {
            confirmUninstall_ = false;
            if (g->resource_type == "plugin") { if (!plugins_.busy()) plugins_.uninstall(*g); }
            else if (!inst_.busy()) inst_.uninstall(g->title_id, g->titre);
            detail_ = false;
            detailA_.snap(0.f);
        }
    } else if (detail_) {
        const Game* g = selectedGame();
        installed::State st = g ? stateOf(*g) : installed::State::NotInstalled;
        rebuildRelated();
        if (in_.pressed(B_CIRCLE)) detail_ = false;
        else if (g) {
            if (in_.pressed(B_CROSS)) activate(*g, st);
            else if (in_.pressed(B_SQUARE) && canUninstall(*g, st) && !inst_.busy() && !plugins_.busy()) confirmUninstall_ = true;
            else if (in_.pressed(B_TRIANGLE) && !related_.empty()) { relatedOpen_ = true; relSel_ = 0; }
            else if (in_.pressed(B_OPTIONS)) startReport(*g);
        }
    } else {
        if (in_.pressed(B_TOUCHPAD)) { if (!startIme()) { searchOpen_ = true; kbCursor_ = 0; } }
        if (in_.pressed(B_CIRCLE) && !query_.empty()) { query_.clear(); sel_ = 0; rebuildFilter(); }
        if (in_.pressed(B_R1)) setTab(tab_ + 1);
        if (in_.pressed(B_L1)) setTab(tab_ - 1);
        int n = (int)filtered_.size();
        if (n > 0) {
            int s = sel_;
            if (in_.pressed(B_LEFT) && s % COLS > 0) --s;
            if (in_.pressed(B_RIGHT) && s % COLS < COLS - 1 && s + 1 < n) ++s;
            if (in_.pressed(B_UP) && s >= COLS) s -= COLS;
            if (in_.pressed(B_DOWN)) { if (s + COLS < n) s += COLS; else if ((s / COLS) < ((n - 1) / COLS)) s = n - 1; }
            if (s != sel_) { sel_ = s; ensureVisible(); }
            if (in_.pressed(B_CROSS)) { detail_ = true; rebuildRelated(); refreshDisk(); }
        }
        if (in_.pressed(B_SQUARE)) { setTab(tabCount() - 1); }
        if (in_.pressed(B_OPTIONS) && upd_.state() == SelfUpdater::State::Ready) confirmSelfUpdate_ = true;
        if (in_.pressed(B_TRIANGLE)) {
            upd_.check(true);
            images_.clearAll();
            requested_ = false;
            catalog_.refresh();
            rescan();
        }
    }

    if (sel_ != lastSel_) { lastSel_ = sel_; selIdle_ = 0.f; largeAsked_ = false; }
    else selIdle_ += dt;
    if (!largeAsked_ && (selIdle_ > 0.3f || detail_)) {
        if (const Game* g = selectedGame()) { images_.requestLarge(*g); largeAsked_ = true; }
    }

    detailA_.k = detail_ ? 40.f : 60.f;
    dlA_.k = modalDl ? 40.f : 60.f;
    detailA_.set(detail_ ? 1.f : 0.f);
    dlA_.set(modalDl ? 1.f : 0.f);
    detailA_.update(dt);
    dlA_.update(dt);
    scrollY_.update(dt);
    pillX_.update(dt);
    pillW_.update(dt);
    gridAlpha_.update(dt);
    for (size_t i = 0; i < cardScale_.size(); ++i) {
        cardScale_[i].set((int)i == sel_ && !modalDl ? 1.06f : 1.f);
        cardScale_[i].update(dt);
    }

    Downloader::Event ev = dl_.lastEvent();
    if (ev.serial != toastSerial_ && ev.alert) {
        toastSerial_ = ev.serial;
        alerts_.push_back(ev.message);
    } else if (ev.serial != toastSerial_) {
        toastSerial_ = ev.serial;
        toastOk_ = ev.ok;
        toastMsg_ = ev.message;
        toastTimer_ = ev.ok ? 5.5f : 8.f;
        toastA_.set(1.f);
    }
    if (upd_.state() == SelfUpdater::State::Ready && !updAnnounced_) {
        updAnnounced_ = true;
        confirmSelfUpdate_ = true;
        settings_ = false;
    }
    if (upd_.state() != SelfUpdater::State::Ready) updAnnounced_ = false;
    if (manualCheck_) {
        const SelfUpdater::State us = upd_.state();
        if (us == SelfUpdater::State::UpToDate) { manualCheck_ = false; notify(true, i18n::tr("ps4.set.uptodate_toast")); }
        else if (us == SelfUpdater::State::Failed) { manualCheck_ = false; notify(false, i18n::tr("ps4.set.check_failed")); }
        else if (us == SelfUpdater::State::Ready) manualCheck_ = false;
    }
    if (settings_ || detail_) { diskTimer_ -= dt; if (diskTimer_ <= 0.f) refreshDisk(); }
    pollReport();

    installed::Manager::Event iev = inst_.lastEvent();
    if (iev.serial != instSerial_) {
        instSerial_ = iev.serial;
        toastOk_ = iev.ok;
        toastMsg_ = iev.message;
        toastTimer_ = iev.ok ? 5.5f : 8.f;
        toastA_.set(1.f);
    }
    plugin::Manager::Event pev = plugins_.lastEvent();
    if (pev.serial != pluginSerial_) {
        pluginSerial_ = pev.serial;
        notify(pev.ok, pev.message, pev.ok ? 5.5f : 8.f);
        plugins_.refresh(games_);
    }
    payload::Sender::Event yev = payloads_.lastEvent();
    if (yev.serial != payloadSerial_) {
        payloadSerial_ = yev.serial;
        notify(yev.ok, yev.message, yev.ok ? 5.5f : 8.f);
    }
    if (toastTimer_ > 0.f) { toastTimer_ -= dt; if (toastTimer_ <= 0.f) toastA_.set(0.f); }
    toastA_.update(dt);

    auto tasks = dl_.tasks();
    sysBar_.set(!tasks.empty() && tasks[0].fraction >= 0.f ? tasks[0].fraction : 0.f);
    if (tasks.empty()) sysBar_.snap(0.f);
    sysBar_.update(dt);

    if (!tasks.empty()) lastTaskSeen_ = time_;
    rescanTimer_ -= dt;
    if (rescanTimer_ <= 0.f) {
        rescanTimer_ = 8.f;
        if (!games_.empty() && time_ - lastTaskSeen_ < 90.f) rescan();
    }

    if (remote_.snapshot(libraryIds_, likedIds_, remoteUser_, remoteVersion_)) rebuildFilter(prevId);
    if (remote_.takeRevoked()) {
        cfg_.device_token.clear();
        cfg_.paired_username.clear();
        saveSettings();
        tabsMeasured_ = false;
        if (tabKind(tab_) == K_LIBRARY) setTab(2);
        alerts_.push_back(i18n::tr("ps4.pair.revoked"));
    }
    {
        std::string tok, user;
        if (remote_.takePairResult(tok, user)) {
            cfg_.device_token = tok;
            cfg_.paired_username = user;
            saveSettings();
            remote_.setToken(tok, user);
            tabsMeasured_ = false;
            pairOpen_ = false;
            pairWaiting_ = false;
            notify(true, i18n::tr("ps4.pair.ok", {{"name", user}}), 6.f);
        } else if (pairWaiting_ && remote_.pairState() == RemoteSync::PairState::Failed) {
            pairWaiting_ = false;
            pairError_ = i18n::tr("ps4.pair.fail", {{"err", remote_.pairError()}});
        }
    }
    heartbeatTimer_ -= dt;
    if (heartbeatTimer_ <= 0.f && remote_.paired()) {
        heartbeatTimer_ = 10.f;
        remote_.setHeartbeat(buildHeartbeat());
    }
    if (cmdUninstallActive_) {
        const installed::Manager::Event e = inst_.lastEvent();
        if (e.serial != cmdSerial_) {
            cmdUninstallActive_ = false;
            if (e.ok) { remote_.ackCommand(cmdId_); notify(true, i18n::tr("ps4.cmd.uninstalled", {{"name", cmdName_}}), 6.f); rescan(); }
            else notify(false, i18n::tr("ps4.cmd.failed", {{"name", cmdName_}}), 8.f);
        }
    } else if (remote_.paired() && !inst_.busy() && !modalDl && alerts_.empty() && !remoteActive_) {
        RemoteSync::Command c;
        if (remote_.popCommand(c)) handleCommand(c);
    }
    if (remoteActive_) {
        bool done = false, ok = false;
        if (remoteKind_ == 1) { auto e = plugins_.lastEvent(); if (e.serial != remoteSerial_) { done = true; ok = e.ok; } }
        else if (remoteKind_ == 2) { auto e = payloads_.lastEvent(); if (e.serial != remoteSerial_) { done = true; ok = e.ok; } }
        else { auto e = dl_.lastEvent(); if (e.serial != remoteSerial_) { done = true; ok = e.ok; } }
        if (done) {
            remoteActive_ = false;
            if (ok) { remote_.ack(remoteQueue_); notify(true, i18n::tr("ps4.remote.started", {{"name", remoteName_}}), 6.f); }
            else notify(false, i18n::tr("ps4.remote.failed", {{"name", remoteName_}}), 8.f);
        }
    } else if (remote_.paired() && !offline() && !modalDl && dl_.phase() == Downloader::Phase::Idle && !plugins_.busy() && !payloads_.busy() &&
               !inst_.busy() && alerts_.empty()) {
        RemoteSync::Request rq;
        if (remote_.popRequest(rq)) startRemote(rq);
    }

    images_.pump(2);
}

std::string Ui::buildHeartbeat() const {
    auto esc = [](const std::string& v) { return json::escape(v); };
    uint64_t freeB = 0, total = 0;
    platform::getFreeDiskSpaceBytes(freeB, &total);
    std::string out = "{\"state\":\"store\",\"app_version\":\"" APP_VERSION "\",\"disk_free\":" + std::to_string((unsigned long long)freeB) +
                      ",\"disk_total\":" + std::to_string((unsigned long long)total) + ",\"installed\":[";
    bool first = true;
    std::set<std::string> seen;
    auto add = [&](const std::string& tid, const std::string& name, const std::string& ver, const std::string& size, const char* type) {
        if (tid.empty() || !seen.insert(tid).second) return;
        if (!first) out += ',';
        first = false;
        out += "{\"title_id\":\"" + esc(tid) + "\",\"name\":\"" + esc(name) + "\",\"version\":\"" + esc(ver) + "\",\"size\":\"" + esc(size) + "\",\"type\":\"" + type + "\"}";
    };
    for (const auto& g : games_) {
        if (g.resource_type != "pkg" && g.resource_type != "plugin") continue;
        std::string v;
        if (stateOf(g, &v) == installed::State::NotInstalled) continue;
        add(g.title_id, g.titre, g.resource_type == "plugin" ? g.version : v, g.size, g.resource_type.c_str());
    }
    for (const std::string& id : installed::listConsoleTitles()) add(id, id, "", "", "pkg");
    out += "]}";
    return out;
}

void Ui::handleCommand(const RemoteSync::Command& c) {
    platform::bootLogf("remote: commande %s %s", c.action.c_str(), c.titleId.c_str());
    const std::string name = c.name.empty() ? c.titleId : c.name;
    if (c.action == "launch") {
        remote_.ackCommandNow(c.id);
        notify(true, i18n::tr("ps4.cmd.launching", {{"name", name}}), 6.f);
        inst_.launch(c.titleId, name);
    } else if (c.action == "uninstall") {
        if (c.titleId == APP_TITLE_ID) { remote_.ackCommand(c.id); return; }
        cmdUninstallActive_ = true;
        cmdId_ = c.id;
        cmdName_ = name;
        cmdSerial_ = inst_.lastEvent().serial;
        inst_.uninstall(c.titleId, name);
    }
}

void Ui::startRemote(const RemoteSync::Request& rq) {
    const Game& g = rq.game;
    remoteActive_ = true;
    remoteQueue_ = rq.queueId;
    remoteName_ = g.titre;
    platform::bootLogf("remote: demande %s (%s)", rq.queueId.c_str(), g.titre.c_str());
    if (g.resource_type == "plugin") {
        const plugin::Plan plan = plugin::planFor(g);
        const int mask = plan.installedMask() ? plan.installedMask() : plan.supportedMask();
        remoteKind_ = 1;
        remoteSerial_ = plugins_.lastEvent().serial;
        if (!mask) { notify(false, i18n::tr("ps4.remote.failed", {{"name", g.titre}}), 8.f); remoteActive_ = false; return; }
        plugins_.install(g, mask);
    } else if (g.resource_type == "payload") {
        remoteKind_ = 2;
        remoteSerial_ = payloads_.lastEvent().serial;
        payloads_.send(g);
    } else {
        remoteKind_ = 0;
        remoteSerial_ = dl_.lastEvent().serial;
        dl_.start(g);
    }
}


void Ui::onSuspend() {
    dl_.cancel();
    confirmUninstall_ = false;
    confirmSelfUpdate_ = false;
    relatedOpen_ = false;
    modal_ = Modal::None;
    images_.suspend();
    requested_ = false;
    largeAsked_ = false;
    lastSel_ = -1;
}

void Ui::onResume() {
    images_.resume();
    requested_ = false;
    largeAsked_ = false;
    lastSel_ = -1;
    upd_.check(false);
    rescan();
    rescanTimer_ = 8.f;
    if (!games_.empty() && (catalog_.fromCache() || catalog_.state() == Catalog::State::Failed)) catalog_.refresh();
    else if (games_.empty() && catalog_.state() != Catalog::State::Loading) catalog_.refresh();
}


void Ui::render() {
    const bool page = detailA_.value > 0.02f || dlA_.value > 0.02f;

    {
        bg_.draw(quality_, W, H);
    }

    if (!page) drawGrid();
    drawHeader();
    drawStatus();
    drawHints();
    drawDetail();
    drawPreparing();
    drawRelated();
    drawSettings();
    drawHistory();
    drawPair();
    drawSearch();
    drawRegionModal();
    drawConfirm();
    drawAlert();
    drawToast();

    text_.endFrame();
    SDL_RenderPresent(r_);
}

void Ui::ensureLogo() {
    if (logoTex_) return;
    static bool tried = false;
    if (tried) return;
    tried = true;
    std::vector<unsigned char> raw;
    if (!TextRenderer::readFile("/app0/sce_sys/icon0.png", raw) && !TextRenderer::readFile("sce_sys/icon0.png", raw)) return;
    int w = 0, h = 0, comp = 0;
    unsigned char* px = stbi_load_from_memory(raw.data(), (int)raw.size(), &w, &h, &comp, 4);
    if (!px) return;
    logoTex_ = gfx::makeTexture(r_, px, w, h);
    stbi_image_free(px);
}

void Ui::drawHeader() {
    SDL_SetRenderDrawBlendMode(r_, SDL_BLENDMODE_BLEND);
    SDL_SetRenderDrawColor(r_, kBar.r, kBar.g, kBar.b, quality_ >= 1 ? 150 : 200);
    SDL_Rect band{0, 0, W, 176};
    SDL_RenderFillRect(r_, &band);
    SDL_SetRenderDrawColor(r_, kBorder.r, kBorder.g, kBorder.b, 90);
    SDL_Rect line{0, 175, W, 1};
    SDL_RenderFillRect(r_, &line);

    ensureLogo();
    const float lx = 96.f, ly = 52.f, ls = 72.f;
    if (logoTex_) {
        SDL_Rect d{(int)lx, (int)ly, (int)ls, (int)ls};
        SDL_RenderCopy(r_, logoTex_, nullptr, &d);
    }
    const float tx = lx + ls + 24.f;
    text_.draw("PS4Store", 40, tx, 50.f, kText);
    std::string sub = "v" APP_VERSION "   |   " + std::to_string(filtered_.size()) + " " + i18n::tr(filtered_.size() > 1 ? "ps4.title_other" : "ps4.title_one");
    if (time_ - updAt_ > 2.f) {
        updAt_ = time_;
        int n = 0;
        for (const auto& g : games_) if (stateOf(g) == installed::State::UpdateAvailable) ++n;
        updCount_ = n;
    }
    if (updCount_ > 0) sub += "   |   " + i18n::tr("ps4.updates_n", {{"n", std::to_string(updCount_)}});
    if (!query_.empty()) sub += "   |   " + i18n::tr("ps4.search") + " : " + query_;
    text_.draw(sub, 20, tx, 104.f, kMuted, 1.f, TextRenderer::Left, 760);

    const float ty = 70.f;
    const int nTabs = tabCount();
    for (int i = 0; i < nTabs; ++i) {
        const bool active = i == tab_ || (settings_ && tabKind(i) == K_SETTINGS);
        text_.draw(tabLabel(i), 26, tabX_[i] + tabW_[i] / 2, ty, active ? kWhite : kMuted, 1.f, TextRenderer::Center);
    }
    fillRound(pillX_.value + 22.f, ty + 50.f, std::max(10.f, pillW_.value - 44.f), 4.f, 2.f, kWhite, 1.f);
}

void Ui::drawCover(const Game& g, float x, float y, float size, float alpha) {
    if (SDL_Texture* t = images_.get(g.id)) {
        SDL_SetTextureAlphaMod(t, (Uint8)(anim::clamp01(alpha) * 255));
        SDL_SetTextureColorMod(t, 255, 255, 255);
        SDL_Rect d{(int)std::lround(x), (int)std::lround(y), (int)std::lround(size), (int)std::lround(size)};
        SDL_RenderCopy(r_, t, nullptr, &d);
    } else {
        fillRound(x, y, size, size, size * 18.f / 300.f, kSurface, alpha);
        std::string ini = g.titre.empty() ? "?" : g.titre.substr(0, 1);
        text_.draw(ini, (int)(size * 0.32f), x + size / 2, y + size * 0.30f, kMuted, alpha * 0.5f, TextRenderer::Center);
    }
}

void Ui::drawPill(const std::string& label, float x, float y, int px, SDL_Color c, bool solid, float alpha) {
    const float h = px + 14.f, w = (float)text_.width(label, px) + 28.f;
    if (solid) {
        drawBadge(label, x, y, c, alpha);
    } else {
        fillRound(x, y, w + 20.f, h, h / 2, c, 0.14f * alpha);
        fillRound(x + 12.f, y + h / 2 - 5.f, 10.f, 10.f, 5.f, c, alpha);
        text_.draw(label, px, x + 30.f, y + 6.f, c, alpha);
    }
}

void Ui::drawGrid() {
    if (filtered_.empty()) return;
    const float a = gridAlpha_.value;
    const int n = (int)filtered_.size();

    SDL_Rect clip{0, 176, W, 1020 - 176};
    SDL_RenderSetClipRect(r_, &clip);

    for (int i = 0; i < n; ++i) {
        int row = i / COLS, col = i % COLS;
        float x = GRID_LEFT + col * (CARD + GAP_X);
        float y = GRID_TOP + row * ROW_H - scrollY_.value;
        if (y + ROW_H < 0.f || y > H) continue;
        const Game& g = games_[filtered_[i]];
        float s = cardScale_.size() > (size_t)i ? cardScale_[i].value : 1.f;
        float sz = CARD * s;
        float cx = x + CARD / 2, cy = y + CARD / 2;
        float cxs = cx - sz / 2, cys = cy - sz / 2;
        const bool selected = i == sel_ && dl_.phase() == Downloader::Phase::Idle;

        if (selected) {
            const float k = anim::clamp01((s - 1.f) / 0.06f);
            fillRound(cxs - 5.f, cys - 5.f, sz + 10.f, sz + 10.f, 14.f * s + 5.f, kWhite, a * k);
        }

        drawCover(g, cxs, cys, sz, a);

        {
            installed::State st = stateOf(g);
            if (st == installed::State::UpToDate) drawBadge(i18n::tr("ps4.badge.installed"), cxs + 12.f, cys + 12.f, kBtnTriangle, a);
            else if (st == installed::State::UpdateAvailable) drawBadge(i18n::tr("ps4.badge.update"), cxs + 12.f, cys + 12.f, kOrange, a);
            {
                const std::string lk = std::to_string(g.likes);
                const float lw = (float)text_.width(lk, 17) + 52.f, lh = 30.f, lx = cxs + 12.f, ly = cys + sz - 12.f - lh;
                fillRound(lx, ly, lw, lh, lh / 2, SDL_Color{4, 12, 34, 255}, 0.78f * a);
                drawHeartIcon(lx + 12.f, ly + 8.f, 16.f, kHeart, a);
                text_.draw(lk, 17, lx + 36.f, ly + 5.f, kText, a, TextRenderer::Left);
            }
            if (g.featuredRank > 0) {
                const std::string fl = g.featuredLabel.empty() ? i18n::tr("ps4.tab.featured") : g.featuredLabel;
                drawBadge(fl, cxs + sz - 12.f - (text_.width(fl, 17) + 28.f), cys + sz - 12.f - 30.f, kOrange, a);
            }
            if (g.resource_type != "pkg") {
                const std::string tl = typeLabel(g);
                drawBadge(tl, cxs + sz - 12.f - (text_.width(tl, 17) + 28.f), cys + 12.f, kCyan, a);
            }
        }

        float ty = y + CARD + 22.f;
        text_.draw(g.titre, 26, x + 4, ty, kText, a, TextRenderer::Left, (int)CARD - 8);
        text_.draw("v" + g.version + "  " + g.size + "  FW " + g.firmware_min + "+", 19, x + 4, ty + 36.f, kMuted, a,
                   TextRenderer::Left, (int)CARD - 8);
    }
    SDL_RenderSetClipRect(r_, nullptr);
}

void Ui::drawStatus() {
    auto st = catalog_.state();
    if (st == Catalog::State::Loading && games_.empty()) {
        float pulse = 0.55f + 0.45f * std::sin(time_ * 3.2f);
        text_.draw(i18n::tr("ps4.loading_catalog"), 32, W / 2.f, 500, kText, pulse, TextRenderer::Center);
        text_.draw(catalog_.server(), 20, W / 2.f, 552, kMuted, 1.f, TextRenderer::Center);
    } else if (st == Catalog::State::Failed && games_.empty()) {
        text_.draw(i18n::tr("ps4.server_unreachable"), 36, W / 2.f, 450, kText, 1.f, TextRenderer::Center);
        text_.draw(catalog_.error(), 20, W / 2.f, 504, kMuted, 1.f, TextRenderer::Center, 1400);
        text_.draw(i18n::tr("ps4.check_config"), 22, W / 2.f, 548, kMuted, 1.f, TextRenderer::Center, 1400);
    } else if (st == Catalog::State::Ready && games_.empty()) {
        text_.draw(i18n::tr("ps4.catalog_empty"), 36, W / 2.f, 500, kText, 1.f, TextRenderer::Center);
    } else if (!games_.empty() && filtered_.empty()) {
        text_.draw(i18n::tr(tabKind(tab_) == K_LIBRARY ? "ps4.library.empty" : tabKind(tab_) == K_INSTALLED ? "ps4.none_installed" : tabKind(tab_) == K_FEATURED ? "ps4.featured.empty" : tabKind(tab_) == K_NEW ? "ps4.new.empty" : "ps4.empty"), 30, W / 2.f, 500, kMuted, 1.f, TextRenderer::Center);
    }
}

void Ui::drawHints() {
    SDL_SetRenderDrawBlendMode(r_, SDL_BLENDMODE_BLEND);
    SDL_SetRenderDrawColor(r_, kBar.r, kBar.g, kBar.b, 150);
    SDL_Rect band{0, 1020, W, 60};
    SDL_RenderFillRect(r_, &band);
    SDL_SetRenderDrawColor(r_, kBorder.r, kBorder.g, kBorder.b, 110);
    SDL_Rect line{0, 1020, W, 1};
    SDL_RenderFillRect(r_, &line);

    struct Hint { std::vector<PsBtn> icons; std::string label; };
    std::vector<Hint> hints;
    const Game* sg = selectedGame();
    installed::State sst = sg ? stateOf(*sg) : installed::State::NotInstalled;
    if (!alerts_.empty()) hints = {{{PsBtn::Cross}, i18n::tr("ps4.ok")}};
    else if (pairOpen_) hints = {{{PsBtn::Cross}, i18n::tr("ps4.add")}, {{PsBtn::Square}, i18n::tr("ps4.delete")},
                                 {{PsBtn::Triangle}, i18n::tr("ps4.keyboard")}, {{PsBtn::Options}, i18n::tr("ps4.validate")}, {{PsBtn::Circle}, i18n::tr("ps4.cancel")}};
    else if (searchOpen_) hints = {{{PsBtn::Cross}, i18n::tr("ps4.search.type")}, {{PsBtn::Square}, i18n::tr("ps4.delete")}, {{PsBtn::Triangle}, i18n::tr("ps4.space")},
                                   {{PsBtn::L1}, i18n::tr("ps4.search.clear_all")}, {{PsBtn::Options}, i18n::tr("ps4.validate")}};
    else if (modal_ == Modal::Region) hints = {{{PsBtn::Cross}, i18n::tr("ps4.confirm")}, {{PsBtn::Circle}, i18n::tr("ps4.cancel")}};
    else if (modal_ == Modal::Force) hints = {{{PsBtn::Cross}, i18n::tr("ps4.plugin.force")}, {{PsBtn::Circle}, i18n::tr("ps4.cancel")}};
    else if (historyOpen_) hints = {{{PsBtn::Circle}, i18n::tr("ps4.back")}};
    else if (settings_) hints = {{{PsBtn::Cross}, i18n::tr(setRow_ >= 3 ? "ps4.hint.select" : "ps4.settings.change")}, {{PsBtn::Triangle}, i18n::tr("ps4.history.short")}, {{PsBtn::L1, PsBtn::R1}, i18n::tr("ps4.tabs")}, {{PsBtn::Circle}, i18n::tr("ps4.back")}};
    else if (relatedOpen_) hints = {{{PsBtn::Cross}, sg && !related_.empty() ? primaryLabel(games_[related_[std::min(relSel_, (int)related_.size() - 1)]], stateOf(games_[related_[std::min(relSel_, (int)related_.size() - 1)]])) : i18n::tr("ps4.install")},
                                    {{PsBtn::Circle}, i18n::tr("ps4.close")}};
    else if (confirmSelfUpdate_) hints = {{{PsBtn::Cross}, i18n::tr("ps4.update")}, {{PsBtn::Circle}, i18n::tr("ps4.later")}};
    else if (confirmUninstall_) hints = {{{PsBtn::Cross}, i18n::tr("ps4.confirm_uninstall_btn")}, {{PsBtn::Circle}, i18n::tr("ps4.cancel")}};
    else if (detail_) {
        const std::string pl = sg ? primaryLabel(*sg, sst) : std::string();
        if (!pl.empty()) hints.push_back({{PsBtn::Cross}, pl});
        if (sg && canUninstall(*sg, sst)) hints.push_back({{PsBtn::Square}, i18n::tr("ps4.uninstall")});
        if (!related_.empty()) hints.push_back({{PsBtn::Triangle}, i18n::tr("ps4.related_open", {{"n", std::to_string(related_.size())}})});
        hints.push_back({{PsBtn::Options}, i18n::tr("ps4.report")});
        hints.push_back({{PsBtn::Circle}, i18n::tr("ps4.close")});
    } else {
        hints = {{{PsBtn::L1, PsBtn::R1}, i18n::tr("ps4.tabs")}, {{PsBtn::Cross}, i18n::tr("ps4.details")},
                 {{PsBtn::Square}, i18n::tr("ps4.settings.title")}, {{PsBtn::Triangle}, i18n::tr("ps4.refresh")}};
        hints.push_back({{PsBtn::Touchpad}, i18n::tr("ps4.search")});
        if (!query_.empty()) hints.push_back({{PsBtn::Circle}, i18n::tr("ps4.search.clear")});
        if (upd_.state() == SelfUpdater::State::Ready) hints.push_back({{PsBtn::Options}, i18n::tr("ps4.update_store")});
    }
    float x = 96.f;
    for (const auto& h : hints) {
        for (PsBtn ic : h.icons) x += drawPsButtonIcon(ic, x, 1035.f, 30) + 6.f;
        x += 6.f;
        text_.draw(h.label, 20, x, 1038, kMuted);
        x += text_.width(h.label, 20) + 52.f;
    }

    auto tasks = dl_.tasks();
    if (!tasks.empty()) {
        std::string label = i18n::tr("ps4.console_task", {{"name", tasks[0].title}});
        if (tasks.size() > 1) label += " +" + std::to_string(tasks.size() - 1);
        char pct[16] = "";
        if (tasks[0].fraction >= 0.f) std::snprintf(pct, sizeof pct, "  %d %%", (int)std::lround(sysBar_.value * 100.f));
        label += pct;
        const float right = W - 96.f, barW = 160.f;
        text_.draw(label, 20, right - barW - 18.f, 1038, kText, 1.f, TextRenderer::Right, 620);
        fillRound(right - barW, 1046.f, barW, 6.f, 3.f, kMuted, 0.28f);
        float f = tasks[0].fraction >= 0.f ? sysBar_.value : 0.f;
        if (f > 0.f) fillRound(right - barW, 1046.f, std::max(6.f, barW * f), 6.f, 3.f, kAccent, 1.f);
    }
}

void Ui::drawDetail() {
    float a = detailA_.value;
    const Game* g = selectedGame();
    if (a <= 0.02f || !g) return;

    const float pw = 1240.f, ph = 800.f;
    const float x = (W - pw) / 2.f;
    const float y = 176.f + (1020.f - 176.f - ph) / 2.f + (1.f - a) * 90.f;
    panelOpaque(x, y, pw, ph, 30.f);

    const float pad = 48.f;
    const float cs = (float)ImageCache::LARGE;
    const float cy = y + (ph - cs) / 2.f;
    if (SDL_Texture* big = images_.getLarge(g->id)) {
        SDL_SetTextureAlphaMod(big, 255);
        SDL_SetTextureColorMod(big, 255, 255, 255);
        SDL_Rect d{(int)std::lround(x + pad), (int)std::lround(cy), ImageCache::LARGE, ImageCache::LARGE};
        SDL_RenderCopy(r_, big, nullptr, &d);
    } else {
        drawCover(*g, x + pad, cy, cs, 1.f);
    }

    const float tx = x + pad + cs + 52.f;
    const float tw = pw - (tx - x) - pad;
    text_.draw((g->resource_type != "pkg" ? typeLabel(*g) + "  ·  " : std::string()) + g->categorie + "  ·  " + i18n::tr("ps4.fw_min", {{"fw", g->firmware_min}}), 20, tx, y + 48.f, kMuted);
    text_.draw(g->titre, 50, tx, y + 78.f, kText, 1.f, TextRenderer::Left, (int)tw);
    if (!g->author_name.empty()) text_.draw(i18n::tr("ps4.published_by", {{"name", g->author_name}}), 22, tx, y + 142.f, kAccent, 1.f, TextRenderer::Left, (int)tw);

    std::string info = i18n::tr("ps4.version") + " " + g->version + "   ·   " + g->size + "   ·   " + i18n::tr("ps4.fw_min", {{"fw", g->firmware_min}});
    if (g->resource_type == "plugin" || g->resource_type == "payload")
        info += "   ·   " + i18n::tr("ps4.region_label") + " " + (g->regions == "EU" ? std::string("EU") : g->regions == "US" ? std::string("US") : std::string("EU / US"));
    text_.draw(info, 22, tx, y + 180.f, kBody, 1.f, TextRenderer::Left, (int)tw);
    std::string ids = i18n::tr("ps4.title_id_label") + " " + g->title_id;
    const std::string upd = fmtDate(g->updated_at);
    if (!upd.empty()) ids += "   ·   " + i18n::tr("ps4.updated_on", {{"date", upd}});
    text_.draw(ids, 22, tx, y + 216.f, kMuted, 1.f, TextRenderer::Left, (int)tw);

    {
        float sx = tx, sy = y + 260.f;
        drawHeartIcon(sx, sy + 3.f, 22.f, kHeart, 1.f);
        const std::string lk = i18n::tr("ps4.stat.likes", {{"n", std::to_string(g->likes)}});
        text_.draw(lk, 22, sx + 32.f, sy, kText);
        sx += 32.f + text_.width(lk, 22) + 34.f;
        drawDownIcon(sx, sy + 2.f, 20.f, kCyan, 1.f);
        const std::string dl = i18n::tr("ps4.stat.downloads", {{"n", std::to_string(g->downloads)}});
        text_.draw(dl, 22, sx + 32.f, sy, kText);
        sx += 32.f + text_.width(dl, 22) + 34.f;
        const bool has = g->fwReliability >= 0;
        text_.draw(has ? i18n::tr("ps4.stat.reliability", {{"pct", std::to_string(g->fwReliability)}}) : i18n::tr("ps4.stat.reliability_none"), 22, sx, sy,
                   !has ? kMuted : g->fwReliability >= 70 ? kGreen : kOrange, 1.f, TextRenderer::Left, (int)std::max(120.f, x + pw - pad - sx));
    }

    std::string instVer;
    const installed::State st = stateOf(*g, &instVer);
    const std::string shownVer = instVer.empty() ? std::string() : " (v" + instVer + ")";
    if (st == installed::State::UpToDate)
        drawPill(i18n::tr("ps4.badge.installed") + shownVer, tx, y + 308.f, 20, kGreen, false, 1.f);
    else if (st == installed::State::UpdateAvailable)
        drawPill(i18n::tr("ps4.update_avail", {{"from", instVer}, {"to", g->version}}), tx, y + 308.f, 20, kOrange, false, 1.f);

    const bool hasRelated = !related_.empty();
    auto lines = wrap(g->description, 24, (int)tw, 3);
    float ly = y + 358.f;
    for (const auto& l : lines) { text_.draw(l, 24, tx, ly, kBody); ly += 36.f; }
    if (!g->changelog_latest.empty()) text_.draw(g->changelog_latest, 20, tx, y + 470.f, kMuted, 1.f, TextRenderer::Left, (int)tw);

    const std::string primary = primaryLabel(*g, st);
    if (diskValid_ && (g->resource_type == "pkg" || g->resource_type == "update" || g->resource_type == "dlc") && st != installed::State::UpToDate) {
        const uint64_t need = parseSizeBytes(g->size);
        if (need > 0 && diskFree_ >= need)
            text_.draw(i18n::tr("ps4.after_install", {{"free", fmtGb(diskFree_ - need)}}), 22, tx, y + 512.f, kMuted, 1.f, TextRenderer::Left, (int)tw);
    }

    const float by = y + ph - pad - 52.f;
    const float bw = 300.f;
    float bx = tx;
    if (!primary.empty()) { drawButton(bx, by, bw, 52.f, PsBtn::Cross, primary, true); bx += bw + 22.f; }
    if (canUninstall(*g, st)) drawButton(bx, by, 250.f, 52.f, PsBtn::Square, i18n::tr("ps4.uninstall"), false);
    drawButton(tx, by - 68.f, 560.f, 52.f, PsBtn::Options, i18n::tr("ps4.report"), false);
    if (hasRelated) drawButton(tx, by - 136.f, 560.f, 52.f, PsBtn::Triangle, i18n::tr("ps4.related_open", {{"n", std::to_string(related_.size())}}), false);
}

void Ui::drawConfirm() {
    const Game* g = selectedGame();
    const bool selfUp = confirmSelfUpdate_;
    if (!selfUp && (!confirmUninstall_ || !g)) return;
    const bool mod = !selfUp && g->resource_type == "plugin";
    const std::vector<std::string> notes = selfUp ? wrap(upd_.info().notes, 22, 760, 5) : std::vector<std::string>();
    const float pw = 860.f, ph = 300.f + (notes.empty() ? 0.f : notes.size() * 32.f + 14.f);
    const float x = (W - pw) / 2.f, y = 176.f + (1020.f - 176.f - ph) / 2.f;
    glassPanel(x, y, pw, ph, 30.f, true);
    const float pad = 56.f;
    text_.draw(selfUp ? i18n::tr("ps4.update_confirm", {{"v", upd_.info().version}})
                      : i18n::tr(mod ? "ps4.remove_mod_title" : "ps4.uninstall_title"), 34, x + pad, y + 44.f, kText, 1.f, TextRenderer::Left, (int)(pw - 2 * pad));
    text_.draw(selfUp ? "v" APP_VERSION " \xE2\x86\x92 v" + upd_.info().version : g->titre, 26, x + pad, y + 100.f, kOrange, 1.f, TextRenderer::Left, (int)(pw - 2 * pad));
    float ny = y + 148.f;
    for (const auto& l : notes) { text_.draw(l, 22, x + pad, ny, kBody, 1.f, TextRenderer::Left, (int)(pw - 2 * pad)); ny += 32.f; }
    if (!notes.empty()) ny += 14.f;
    text_.draw(i18n::tr(selfUp ? "ps4.update_confirm_text" : mod ? "ps4.remove_mod_text" : "ps4.uninstall_text"), 22, x + pad, ny, kMuted, 1.f, TextRenderer::Left, (int)(pw - 2 * pad));
    drawButton(x + pad, y + ph - pad - 52.f, 280.f, 52.f, PsBtn::Cross, i18n::tr(selfUp ? "ps4.update" : "ps4.confirm"), true);
    drawButton(x + pad + 302.f, y + ph - pad - 52.f, 230.f, 52.f, PsBtn::Circle, i18n::tr(selfUp ? "ps4.later" : "ps4.cancel"), false);
}

void Ui::drawRegionModal() {
    if (modal_ == Modal::None) return;
    const float pw = 980.f, ph = 340.f;
    const float x = (W - pw) / 2.f, y = 176.f + (1020.f - 176.f - ph) / 2.f;
    glassPanel(x, y, pw, ph, 30.f, true);
    const float pad = 56.f;
    const int maxW = (int)(pw - 2 * pad);
    if (modal_ == Modal::Force) {
        text_.draw(i18n::tr("ps4.plugin.warn_title"), 34, x + pad, y + 44.f, kText, 1.f, TextRenderer::Left, maxW);
        text_.draw(pending_.titre, 26, x + pad, y + 100.f, kOrange, 1.f, TextRenderer::Left, maxW);
        text_.draw(i18n::tr("ps4.plugin.none"), 22, x + pad, y + 148.f, kMuted, 1.f, TextRenderer::Left, maxW);
        text_.draw(i18n::tr("ps4.plugin.warn_text"), 22, x + pad, y + 184.f, kMuted, 1.f, TextRenderer::Left, maxW);
        drawButton(x + pad, y + ph - pad - 52.f, 280.f, 52.f, PsBtn::Cross, i18n::tr("ps4.plugin.force"), true);
        drawButton(x + pad + 302.f, y + ph - pad - 52.f, 230.f, 52.f, PsBtn::Circle, i18n::tr("ps4.cancel"), false);
        return;
    }
    text_.draw(i18n::tr("ps4.region.pick"), 34, x + pad, y + 44.f, kText, 1.f, TextRenderer::Left, maxW);
    text_.draw(pending_.titre, 26, x + pad, y + 96.f, kOrange, 1.f, TextRenderer::Left, maxW);
    const std::string labels[3] = {i18n::tr("ps4.region.eu"), i18n::tr("ps4.region.us"), i18n::tr("ps4.region.both")};
    const std::string subs[3] = {pending_.eu.title_id, pending_.us.title_id, pending_.eu.title_id + " + " + pending_.us.title_id};
    const float cw = (pw - 2 * pad - 2 * 24.f) / 3.f, cy = y + 160.f, chh = 110.f;
    for (int i = 0; i < 3; ++i) {
        const float cx = x + pad + i * (cw + 24.f);
        const bool on = i == regionSel_;
        if (on) {
            const float pulse = 0.5f + 0.5f * std::sin(time_ * 3.2f);
            fillRound(cx - 4.f, cy - 4.f, cw + 8.f, chh + 8.f, 24.f, kCyan, 0.20f + 0.16f * pulse);
        }
        fillRound(cx, cy, cw, chh, 20.f, on ? kAccent : kBorder, on ? 1.f : 0.55f);
        if (!on) fillRound(cx + 2.f, cy + 2.f, cw - 4.f, chh - 4.f, 18.f, kSurface, 0.97f);
        text_.draw(labels[i], 30, cx + cw / 2, cy + 20.f, on ? kWhite : kText, 1.f, TextRenderer::Center, (int)cw - 16);
        text_.draw(subs[i], 18, cx + cw / 2, cy + 68.f, on ? kWhite : kMuted, 1.f, TextRenderer::Center, (int)cw - 16);
    }
}

void Ui::refreshDisk() {
    uint64_t freeB = 0, total = 0;
    diskValid_ = platform::getFreeDiskSpaceBytes(freeB, &total) && total > 0;
    diskFree_ = diskValid_ ? freeB : 0;
    diskTotal_ = diskValid_ ? total : 0;
    diskTimer_ = 5.f;
}

uint64_t Ui::parseSizeBytes(const std::string& s) {
    size_t i = 0;
    while (i < s.size() && !(s[i] >= '0' && s[i] <= '9')) ++i;
    double v = 0, frac = 0.1;
    bool seenDot = false, any = false;
    for (; i < s.size(); ++i) {
        const char c = s[i];
        if (c >= '0' && c <= '9') { any = true; if (seenDot) { v += (c - '0') * frac; frac /= 10; } else v = v * 10 + (c - '0'); }
        else if ((c == ',' || c == '.') && !seenDot) seenDot = true;
        else break;
    }
    if (!any) return 0;
    while (i < s.size() && s[i] == ' ') ++i;
    const char u = i < s.size() ? s[i] : 0;
    double mult = 0;
    if (u == 'G' || u == 'g') mult = 1073741824.0;
    else if (u == 'M' || u == 'm') mult = 1048576.0;
    else if (u == 'K' || u == 'k') mult = 1024.0;
    return mult > 0 ? (uint64_t)(v * mult) : 0;
}

std::string Ui::fmtDate(const std::string& iso) const {
    if (iso.size() < 10 || iso[4] != '-' || iso[7] != '-') return "";
    const std::string y = iso.substr(0, 4), m = iso.substr(5, 2), d = iso.substr(8, 2);
    return i18n::index() == 1 ? m + "/" + d + "/" + y : d + "/" + m + "/" + y;
}

void Ui::drawHeartIcon(float x, float y, float w, SDL_Color c, float alpha) {
    const int N = std::max(8, (int)std::lround(w));
    const int key = 900000 + N;
    SDL_Texture* t = nullptr;
    auto it = iconTextures_.find(key);
    if (it != iconTextures_.end()) t = it->second;
    else {
        const int SS = 4;
        std::vector<unsigned char> px((size_t)N * N * 4, 255);
        for (int py = 0; py < N; ++py)
            for (int pxl = 0; pxl < N; ++pxl) {
                int hit = 0;
                for (int sy = 0; sy < SS; ++sy)
                    for (int sx = 0; sx < SS; ++sx) {
                        const float u = ((pxl + (sx + 0.5f) / SS) / N) * 2.4f - 1.2f;
                        const float v = 1.3f - ((py + (sy + 0.5f) / SS) / N) * 2.4f;
                        const float q = u * u + v * v - 1.f;
                        if (q * q * q - u * u * v * v * v <= 0.f) ++hit;
                    }
                px[((size_t)py * N + pxl) * 4 + 3] = (unsigned char)(255 * hit / (SS * SS));
            }
        t = gfx::makeTexture(r_, px.data(), N, N);
        if (t) SDL_SetTextureBlendMode(t, SDL_BLENDMODE_BLEND);
        iconTextures_[key] = t;
    }
    if (!t) return;
    SDL_SetTextureColorMod(t, c.r, c.g, c.b);
    SDL_SetTextureAlphaMod(t, (Uint8)(anim::clamp01(alpha) * 255));
    SDL_Rect d{(int)std::lround(x), (int)std::lround(y), N, N};
    SDL_RenderCopy(r_, t, nullptr, &d);
}

void Ui::drawDownIcon(float x, float y, float w, SDL_Color c, float alpha) {
    SDL_SetRenderDrawBlendMode(r_, SDL_BLENDMODE_BLEND);
    SDL_SetRenderDrawColor(r_, c.r, c.g, c.b, (Uint8)(anim::clamp01(alpha) * 255));
    const int stemW = std::max(2, (int)(w * 0.22f)), stemH = (int)(w * 0.5f);
    SDL_Rect stem{(int)std::lround(x + (w - stemW) / 2.f), (int)std::lround(y), stemW, stemH};
    SDL_RenderFillRect(r_, &stem);
    const int rows = (int)(w * 0.5f);
    for (int i = 0; i < rows; ++i) {
        const float hw = (w * 0.5f) * (1.f - (float)i / (float)rows);
        SDL_Rect row{(int)std::lround(x + w / 2.f - hw), (int)std::lround(y + stemH + i), std::max(1, (int)std::lround(hw * 2.f)), 1};
        SDL_RenderFillRect(r_, &row);
    }
    SDL_Rect base{(int)std::lround(x), (int)std::lround(y + w), (int)std::lround(w), std::max(2, (int)(w * 0.14f))};
    SDL_RenderFillRect(r_, &base);
}

void Ui::startReport(const Game& g) {
    if (reportState_ != 0) return;
    if (reportTh_.joinable()) reportTh_.join();
    reportState_ = 1;
    notify(true, i18n::tr("ps4.report.sending"), 3.f);
    const std::string url = catalog_.server() + "/api/games/" + g.id + "/report-link";
    const std::string token = remote_.bearer();
    reportTh_ = std::thread([this, url, token] {
        try {
            std::string body, err;
            const long code = http::request("POST", url, token, "{\"reason\":\"dead\"}", body, err, 15);
            std::lock_guard<std::mutex> l(reportM_);
            if (code == 200 || code == 201) { reportMsg_ = i18n::tr("ps4.report.sent"); reportState_ = 2; }
            else if (code == 409) { reportMsg_ = i18n::tr("ps4.report.dup"); reportState_ = 3; }
            else if (code == 401) { reportMsg_ = i18n::tr("ps4.report.need_link"); reportState_ = 4; }
            else { reportMsg_ = i18n::tr("ps4.report.fail", {{"err", code ? "HTTP " + std::to_string(code) : (err.empty() ? std::string("réseau") : err)}}); reportState_ = 4; }
        } catch (...) {
            platform::logCaught("report-link");
            std::lock_guard<std::mutex> l(reportM_);
            reportMsg_ = i18n::tr("ps4.report.fail", {{"err", "interne"}});
            reportState_ = 4;
        }
    });
}

void Ui::pollReport() {
    const int st = reportState_.load();
    if (st < 2) return;
    std::string msg;
    { std::lock_guard<std::mutex> l(reportM_); msg = reportMsg_; }
    if (reportTh_.joinable()) reportTh_.join();
    reportState_ = 0;
    alerts_.push_back(msg);
}

int Ui::installedCount() const {
    int n = 0;
    for (const auto& g : games_)
        if ((g.resource_type == "pkg" || g.resource_type == "plugin") && stateOf(g) != installed::State::NotInstalled) ++n;
    return n;
}

std::string Ui::fmtGb(uint64_t bytes) const {
    char b[32];
    std::snprintf(b, sizeof b, "%.1f", (double)bytes / 1073741824.0);
    std::string out = b;
    if (i18n::index() != 1) for (char& c : out) if (c == '.') c = ',';
    return out;
}

void Ui::drawSettings() {
    if (!settings_) return;
    SDL_SetRenderDrawBlendMode(r_, SDL_BLENDMODE_BLEND);
    SDL_SetRenderDrawColor(r_, kBar.r, kBar.g, kBar.b, 247);
    SDL_Rect bg{0, 176, W, 844};
    SDL_RenderFillRect(r_, &bg);

    const float x0 = 300.f, x1 = W - 300.f, cw = x1 - x0;
    text_.draw(i18n::tr("ps4.settings.title"), 40, x0, 196.f, kText);

    auto section = [&](const std::string& label, float y) {
        text_.draw(label, 18, x0, y, kCyan);
        fillRound(x0, y + 30.f, cw, 1.f, 0.5f, kBorder, 0.55f);
    };
    auto row = [&](int i, float y, const std::string& label) {
        const bool on = i == setRow_;
        if (on) fillRound(x0 - 24.f, y + 4.f, 5.f, 40.f, 2.5f, kAccent, 1.f);
        text_.draw(label, 27, x0, y + 8.f, on ? kWhite : kBody);
        fillRound(x0, y + 56.f, cw, 1.f, 0.5f, kBorder, 0.2f);
    };
    auto segs = [&](float y, const std::vector<std::string>& names, int active, bool focus, const std::vector<SDL_Color>* dots) {
        float x = x1;
        for (int k = (int)names.size() - 1; k >= 0; --k) {
            const float w = (float)text_.width(names[k], 24) + 44.f + (dots ? 22.f : 0.f);
            x -= w;
            const bool act = k == active;
            if (act) fillRound(x, y, w, 46.f, 23.f, focus ? kAccent : kBorder, focus ? 1.f : 0.55f);
            float tx = x + 22.f;
            if (dots) { fillRound(tx, y + 16.f, 14.f, 14.f, 7.f, (*dots)[k], 1.f); tx += 22.f; }
            text_.draw(names[k], 24, tx, y + 8.f, act ? kWhite : kMuted);
            x -= 6.f;
        }
    };

    section(i18n::tr("ps4.set.sec.prefs"), 250.f);
    row(0, 296.f, i18n::tr("ps4.language"));
    std::vector<std::string> langs;
    for (int i = 0; i < i18n::COUNT; ++i) langs.push_back(i18n::kNames[i]);
    segs(298.f, langs, i18n::index(), setRow_ == 0, nullptr);
    row(1, 352.f, i18n::tr("ps4.theme"));
    std::vector<std::string> themes;
    std::vector<SDL_Color> dots;
    for (int t = 0; t < settings::THEMES; ++t) { themes.push_back(i18n::tr(std::string("theme.") + settings::palette(t).id)); dots.push_back(settings::palette(t).accent); }
    segs(354.f, themes, cfg_.theme, setRow_ == 1, &dots);
    row(2, 408.f, i18n::tr("ps4.sort"));
    const std::vector<std::string> sorts = {i18n::tr("ps4.sort.default"), i18n::tr("ps4.sort.az"), i18n::tr("ps4.sort.recent"), i18n::tr("ps4.sort.likes")};
    segs(410.f, sorts, cfg_.sort, setRow_ == 2, nullptr);

    SDL_Color sc = kMuted;
    std::string st;
    switch (upd_.state()) {
        case SelfUpdater::State::Ready: st = i18n::tr("ps4.set.update_avail", {{"v", upd_.info().version}}); sc = kOrange; break;
        case SelfUpdater::State::UpToDate: st = i18n::tr("ps4.set.uptodate"); sc = kGreen; break;
        case SelfUpdater::State::Checking: st = i18n::tr("ps4.set.checking"); break;
        case SelfUpdater::State::Downloading: st = i18n::tr("ps4.upd.downloading", {{"pct", std::to_string((int)std::lround(std::max(0.f, upd_.progress()) * 100.f))}}); sc = kOrange; break;
        case SelfUpdater::State::Failed: st = i18n::tr("ps4.set.check_failed"); if (!upd_.error().empty()) st += " : " + upd_.error(); break;
        default: break;
    }
    section(i18n::tr("ps4.set.sec.actions"), 480.f);
    row(3, 522.f, upd_.state() == SelfUpdater::State::Ready ? i18n::tr("ps4.upd.apply", {{"v", upd_.info().version}}) : i18n::tr("ps4.set.check_now"));
    text_.draw(st, 24, x1, 530.f, sc, 1.f, TextRenderer::Right, 700);
    row(4, 578.f, i18n::tr("ps4.set.clear_cache"));
    row(5, 634.f, i18n::tr(remote_.paired() ? "ps4.set.unlink" : "ps4.set.link"));
    if (remote_.paired()) text_.draw(i18n::tr("ps4.set.linked_as", {{"name", cfg_.paired_username}}), 24, x1, 642.f, kGreen, 1.f, TextRenderer::Right, 700);
    else text_.draw(i18n::tr("ps4.set.not_linked"), 24, x1, 642.f, kMuted, 1.f, TextRenderer::Right, 700);

    section(i18n::tr("ps4.set.sec.info"), 706.f);
    const float ca = x0, cb = x0 + cw / 2.f + 40.f, cwid = cw / 2.f - 40.f;
    auto item = [&](float x, float y, const std::string& label) { text_.draw(label, 19, x, y, kMuted); };

    item(ca, 752.f, i18n::tr("ps4.set.app_version"));
    text_.draw("v" APP_VERSION, 26, ca, 779.f, kText);
    item(ca, 832.f, i18n::tr("ps4.set.storage"));
    text_.draw(diskValid_ ? i18n::tr("ps4.storage_detail", {{"free", fmtGb(diskFree_)}, {"total", fmtGb(diskTotal_)}}) : i18n::tr("ps4.set.storage_managed"), 26, ca, 859.f, kText, 1.f, TextRenderer::Left, (int)cwid);
    {
        const float gw = std::min(cwid, 560.f), gy = 906.f;
        fillRound(ca, gy, gw, 12.f, 6.f, kBorder, 0.35f);
        if (diskValid_ && diskTotal_ > 0) {
            const float used = anim::clamp01((float)((double)(diskTotal_ - std::min(diskTotal_, diskFree_)) / (double)diskTotal_));
            if (used > 0.f) fillRound(ca, gy, std::max(12.f, gw * used), 12.f, 6.f, used > 0.9f ? kOrange : kAccent, 1.f);
        }
    }

    item(cb, 752.f, i18n::tr("ps4.set.server"));
    {
        const bool connected = catalog_.state() == Catalog::State::Ready && !catalog_.fromCache();
        const bool connecting = catalog_.state() == Catalog::State::Loading;
        const std::string addr = catalog_.server();
        const int aw = std::min((int)cwid - 200, text_.width(addr, 26));
        text_.draw(addr, 26, cb, 779.f, kText, 1.f, TextRenderer::Left, aw);
        text_.draw(i18n::tr(connected ? "ps4.set.connected" : connecting ? "ps4.set.connecting" : "ps4.set.offline"), 22, cb + aw + 24.f, 783.f,
                   connected ? kGreen : connecting ? kMuted : kOrange);
    }
    item(cb, 832.f, i18n::tr("ps4.set.installed_count"));
    text_.draw(std::to_string(installedCount()), 26, cb, 859.f, kText);
}

void Ui::drawHistory() {
    if (!historyOpen_) return;
    SDL_SetRenderDrawBlendMode(r_, SDL_BLENDMODE_BLEND);
    SDL_SetRenderDrawColor(r_, kBar.r, kBar.g, kBar.b, 252);
    SDL_Rect bg{0, 176, W, 844};
    SDL_RenderFillRect(r_, &bg);
    const float x0 = 300.f, x1 = W - 300.f, cw = x1 - x0;
    text_.draw(i18n::tr("ps4.history"), 40, x0, 196.f, kText);
    const std::vector<SelfUpdater::Entry> h = upd_.history();
    if (h.empty()) {
        text_.draw(i18n::tr("ps4.history.empty"), 26, x0, 290.f, kMuted, 1.f, TextRenderer::Left, (int)cw);
        return;
    }
    const int vis = 5;
    const int first = std::max(0, std::min(histSel_ - vis / 2, (int)h.size() - vis));
    for (int k = 0; k < vis && first + k < (int)h.size(); ++k) {
        const int idx = first + k;
        const SelfUpdater::Entry& e = h[idx];
        const float y = 262.f + k * 148.f;
        const bool on = idx == histSel_;
        if (on) fillRound(x0 - 24.f, y + 4.f, 5.f, 110.f, 2.5f, kAccent, 1.f);
        text_.draw("v" + e.version, 32, x0, y, on ? kWhite : kText);
        if (e.version == APP_VERSION) text_.draw(i18n::tr("ps4.history.current"), 20, x0 + 190.f, y + 10.f, kGreen);
        text_.draw(e.date, 22, x1, y + 6.f, kMuted, 1.f, TextRenderer::Right);
        const std::string note = e.notes.empty() ? "-" : e.notes;
        const auto lines = wrap(note, 23, (int)cw - 20, 2);
        float ly = y + 52.f;
        for (const auto& l : lines) { text_.draw(l, 23, x0, ly, on ? kBody : kMuted); ly += 32.f; }
        fillRound(x0, y + 126.f, cw, 1.f, 0.5f, kBorder, 0.25f);
    }
    text_.draw(std::to_string(histSel_ + 1) + " / " + std::to_string(h.size()), 20, x1, 196.f + 14.f, kMuted, 1.f, TextRenderer::Right);
}

void Ui::drawPair() {
    if (!pairOpen_) return;
    const float pw = 1000.f, ph = 700.f;
    const float x = (W - pw) / 2.f, y = 176.f + (1020.f - 176.f - ph) / 2.f;
    glassPanel(x, y, pw, ph, 30.f, true);
    const float pad = 56.f;
    text_.draw(i18n::tr("ps4.pair.title"), 36, x + pad, y + 32.f, kText, 1.f, TextRenderer::Left, (int)(pw - 2 * pad));
    const auto lines = wrap(i18n::tr("ps4.pair.sub"), 22, (int)(pw - 2 * pad), 2);
    float ly = y + 88.f;
    for (const auto& l : lines) { text_.draw(l, 22, x + pad, ly, kMuted); ly += 30.f; }

    const float sw = 92.f, sg = 14.f, sx0 = x + (pw - (6 * sw + 5 * sg)) / 2.f, sy = y + 170.f;
    for (int i = 0; i < 6; ++i) {
        const float sx = sx0 + i * (sw + sg);
        const bool cur = i == (int)pairCode_.size();
        fillRound(sx, sy, sw, 100.f, 18.f, cur ? kAccent : kBorder, cur ? 0.9f : 0.5f);
        fillRound(sx + 2.f, sy + 2.f, sw - 4.f, 96.f, 16.f, kSurface, 0.97f);
        if (i < (int)pairCode_.size()) text_.draw(std::string(1, pairCode_[i]), 56, sx + sw / 2.f, sy + 18.f, kText, 1.f, TextRenderer::Center);
        else if (cur) fillRound(sx + sw / 2.f - 14.f, sy + 78.f, 28.f, 4.f, 2.f, kAccent, 0.5f + 0.5f * std::sin(time_ * 5.f));
    }

    const float cw = 84.f, cg = 8.f, gx = x + (pw - (8 * cw + 7 * cg)) / 2.f, gy = y + 300.f;
    for (int i = 0; i < 32; ++i) {
        const float cx = gx + (i % 8) * (cw + cg), cy = gy + (i / 8) * (cw + cg - 14.f);
        const bool on = i == pairCursor_;
        fillRound(cx, cy, cw, cw - 14.f, 16.f, on ? kAccent : kBorder, on ? 1.f : 0.28f);
        text_.draw(std::string(1, kPairAlphabet[i]), 32, cx + cw / 2.f, cy + 10.f, on ? kWhite : kText, 1.f, TextRenderer::Center);
    }
    const bool working = remote_.pairState() == RemoteSync::PairState::Working;
    if (working) text_.draw(i18n::tr("ps4.pair.working"), 24, x + pw / 2.f, y + ph - 70.f, kText, 0.6f + 0.4f * std::sin(time_ * 5.f), TextRenderer::Center);
    else if (!pairError_.empty()) text_.draw(pairError_, 22, x + pw / 2.f, y + ph - 70.f, kOrange, 1.f, TextRenderer::Center, (int)(pw - 2 * pad));
    else text_.draw(i18n::tr("ps4.pair.keys"), 20, x + pw / 2.f, y + ph - 66.f, kMuted, 1.f, TextRenderer::Center, (int)(pw - 2 * pad));
}

namespace {
std::u16string utf8to16(const std::string& s) {
    std::u16string o;
    for (size_t i = 0; i < s.size();) {
        const unsigned char c = (unsigned char)s[i];
        uint32_t cp = c;
        int n = 1;
        if (c >= 0xF0 && i + 3 < s.size()) { cp = ((c & 7u) << 18) | (((unsigned char)s[i + 1] & 63u) << 12) | (((unsigned char)s[i + 2] & 63u) << 6) | ((unsigned char)s[i + 3] & 63u); n = 4; }
        else if (c >= 0xE0 && i + 2 < s.size()) { cp = ((c & 15u) << 12) | (((unsigned char)s[i + 1] & 63u) << 6) | ((unsigned char)s[i + 2] & 63u); n = 3; }
        else if (c >= 0xC0 && i + 1 < s.size()) { cp = ((c & 31u) << 6) | ((unsigned char)s[i + 1] & 63u); n = 2; }
        if (cp >= 0x10000) { cp -= 0x10000; o += (char16_t)(0xD800 + (cp >> 10)); o += (char16_t)(0xDC00 + (cp & 0x3FF)); }
        else o += (char16_t)cp;
        i += n;
    }
    return o;
}
std::string utf16to8(const char16_t* p, size_t max) {
    std::string o;
    for (size_t i = 0; i < max && p[i]; ++i) {
        uint32_t cp = p[i];
        if (cp >= 0xD800 && cp < 0xDC00 && i + 1 < max && p[i + 1] >= 0xDC00 && p[i + 1] < 0xE000) { cp = 0x10000 + ((cp - 0xD800) << 10) + (p[i + 1] - 0xDC00); ++i; }
        if (cp < 0x80) o += (char)cp;
        else if (cp < 0x800) { o += (char)(0xC0 | (cp >> 6)); o += (char)(0x80 | (cp & 63)); }
        else if (cp < 0x10000) { o += (char)(0xE0 | (cp >> 12)); o += (char)(0x80 | ((cp >> 6) & 63)); o += (char)(0x80 | (cp & 63)); }
        else { o += (char)(0xF0 | (cp >> 18)); o += (char)(0x80 | ((cp >> 12) & 63)); o += (char)(0x80 | ((cp >> 6) & 63)); o += (char)(0x80 | (cp & 63)); }
    }
    return o;
}
}

bool Ui::startIme(int mode) {
    if (!imeTried_) { imeTried_ = true; imeReady_ = platform::initImeDialog(); }
    if (!imeReady_) return false;
    std::memset(imeBuf_, 0, sizeof imeBuf_);
    imeMode_ = mode;
    const std::u16string cur = utf8to16(mode == 1 ? pairCode_ : query_);
    const size_t cap = mode == 1 ? 6 : 40;
    for (size_t i = 0; i < cur.size() && i < cap; ++i) imeBuf_[i] = cur[i];
    imeTitle_ = utf8to16(i18n::tr(mode == 1 ? "ps4.pair.title" : "ps4.search"));
    imePlace_ = utf8to16(i18n::tr(mode == 1 ? "ps4.pair.ph" : "ps4.search.ph"));
    OrbisImeDialogSetting p;
    std::memset(&p, 0, sizeof p);
    p.userId = (uint32_t)in_.userId();
    p.type = mode == 1 ? ORBIS_TYPE_BASIC_LATIN : ORBIS_TYPE_DEFAULT;
    p.supportedLanguages = 0;
    p.enterLabel = mode == 1 ? ORBIS_BUTTON_LABEL_GO : ORBIS_BUTTON_LABEL_SEARCH;
    p.inputMethod = ORBIS__DEFAULT;
    p.filter = nullptr;
    p.option = 0;
    p.maxTextLength = (uint32_t)cap;
    p.inputTextBuffer = reinterpret_cast<wchar_t*>(imeBuf_);
    p.posx = W / 2.f;
    p.posy = H / 2.f;
    p.horizontalAlignment = ORBIS_H_CENTER;
    p.verticalAlignment = ORBIS_V_CENTER;
    p.placeholder = reinterpret_cast<const wchar_t*>(imePlace_.c_str());
    p.title = reinterpret_cast<const wchar_t*>(imeTitle_.c_str());
    const int rc = (int)sceImeDialogInit(&p, nullptr);
    platform::bootLogf("ime: sceImeDialogInit rc=0x%08X", (unsigned)rc);
    if (rc < 0) return false;
    imeActive_ = true;
    return true;
}

void Ui::pollIme() {
    if (!imeActive_) return;
    if (sceImeDialogGetStatus() != ORBIS_DIALOG_STATUS_STOPPED) return;
    OrbisDialogResult res;
    std::memset(&res, 0, sizeof res);
    sceImeDialogGetResult(&res);
    if (res.endstatus == ORBIS_DIALOG_OK && imeMode_ == 1) {
        const std::string raw = utf16to8(imeBuf_, 6);
        std::string code;
        for (char ch : raw) {
            const char u = (ch >= 'a' && ch <= 'z') ? (char)(ch - 32) : ch;
            if (u && std::strchr(kPairAlphabet, u)) code += u;
        }
        pairCode_ = code;
        pairError_.clear();
        if (pairCode_.size() == 6) {
            if (offline()) pairError_ = i18n::tr("ps4.offline_blocked");
            else { pairWaiting_ = true; remote_.pair(pairCode_, "PS4"); }
        } else if (!pairCode_.empty()) pairError_ = i18n::tr("ps4.pair.incomplete");
    } else if (res.endstatus == ORBIS_DIALOG_OK) {
        query_ = utf16to8(imeBuf_, 40);
        while (!query_.empty() && query_.back() == ' ') query_.pop_back();
        sel_ = 0;
        rebuildFilter();
    }
    sceImeDialogTerm();
    imeActive_ = false;
}

void Ui::drawSearch() {
    if (!searchOpen_) return;
    const float pw = 1160.f, ph = 700.f;
    const float x = (W - pw) / 2.f, y = 176.f + (1020.f - 176.f - ph) / 2.f;
    glassPanel(x, y, pw, ph, 30.f, true);
    const float pad = 56.f;
    text_.draw(i18n::tr("ps4.search"), 36, x + pad, y + 30.f, kText);
    text_.draw(std::to_string(filtered_.size()) + " " + i18n::tr(filtered_.size() > 1 ? "ps4.title_other" : "ps4.title_one"), 22, x + pw - pad, y + 42.f, kMuted, 1.f, TextRenderer::Right);

    const float fx = x + pad, fy = y + 96.f, fw = pw - 2 * pad, fh = 84.f;
    fillRound(fx, fy, fw, fh, 22.f, kAccent, 0.9f);
    fillRound(fx + 2.f, fy + 2.f, fw - 4.f, fh - 4.f, 20.f, kSurface, 0.97f);
    if (query_.empty()) text_.draw(i18n::tr("ps4.search.ph"), 30, fx + 28.f, fy + 22.f, kMuted, 0.7f, TextRenderer::Left, (int)(fw - 60.f));
    else {
        text_.draw(query_, 38, fx + 28.f, fy + 16.f, kText, 1.f, TextRenderer::Left, (int)(fw - 80.f));
        const float cw = (float)text_.width(query_, 38);
        if (std::fmod(time_, 1.f) < 0.55f && cw < fw - 90.f) fillRound(fx + 32.f + cw, fy + 18.f, 4.f, 48.f, 2.f, kCyan, 1.f);
    }

    const float kw = 92.f, kg = 10.f, gx = x + (pw - (10 * kw + 9 * kg)) / 2.f, gy = y + 216.f, kh = 86.f;
    for (int i = 0; i < 40; ++i) {
        const float cx = gx + (i % 10) * (kw + kg), cy = gy + (i / 10) * (kh + kg);
        const bool on = i == kbCursor_;
        fillRound(cx, cy, kw, kh, 18.f, on ? kAccent : kBorder, on ? 1.f : 0.26f);
        text_.draw(std::string(1, (char)std::toupper((unsigned char)kbChar(i))), 36, cx + kw / 2.f, cy + 20.f, on ? kWhite : kText, 1.f, TextRenderer::Center);
    }
    text_.draw(i18n::tr("ps4.search.keys"), 20, x + pw / 2.f, y + ph - 56.f, kMuted, 1.f, TextRenderer::Center, (int)(pw - 2 * pad));
}

void Ui::drawRelated() {
    if (!relatedOpen_ || related_.empty()) return;
    const int n = (int)related_.size(), vis = std::min(n, 6);
    const float rowH = 76.f, pw = 1180.f, ph = 190.f + vis * rowH;
    const float x = (W - pw) / 2.f, y = 176.f + (1020.f - 176.f - ph) / 2.f;
    glassPanel(x, y, pw, ph, 30.f, true);
    const float pad = 48.f;
    text_.draw(i18n::tr("ps4.related"), 34, x + pad, y + 34.f, kText);
    if (const Game* g = selectedGame()) text_.draw(g->titre, 22, x + pad, y + 82.f, kMuted, 1.f, TextRenderer::Left, (int)(pw - 2 * pad));
    int first = std::max(0, std::min(relSel_ - vis / 2, n - vis));
    for (int k = 0; k < vis; ++k) {
        const int idx = first + k;
        const Game& rg = games_[related_[idx]];
        const float ry = y + 126.f + k * rowH;
        const bool on = idx == relSel_;
        fillRound(x + pad - 12.f, ry, pw - 2 * pad + 24.f, rowH - 8.f, 20.f, on ? kAccent : kBorder, on ? 0.95f : 0.18f);
        text_.draw(rg.titre, 26, x + pad + 8.f, ry + 14.f, on ? kWhite : kText, 1.f, TextRenderer::Left, 560);
        text_.draw(typeLabel(rg) + "  ·  v" + rg.version + "  ·  " + rg.size, 20, x + pad + 600.f, ry + 20.f, on ? kWhite : kMuted, 1.f, TextRenderer::Left, 360);
        std::string iv;
        const installed::State st = stateOf(rg, &iv);
        const std::string tag = st == installed::State::UpToDate ? i18n::tr("ps4.badge.installed")
                              : st == installed::State::UpdateAvailable ? i18n::tr("ps4.badge.update") : std::string();
        if (!tag.empty()) text_.draw(tag, 20, x + pw - pad - 4.f, ry + 20.f, on ? kWhite : (st == installed::State::UpToDate ? kGreen : kOrange), 1.f, TextRenderer::Right);
    }
}

void Ui::drawPreparing() {
    float a = dlA_.value;
    if (a <= 0.02f) return;

    const float pw = 820.f, ph = 280.f;
    const float x = (W - pw) / 2.f;
    const float y = 176.f + (1020.f - 176.f - ph) / 2.f + (1.f - a) * 90.f;
    panelOpaque(x, y, pw, ph, 30.f);

    const float pad = 56.f;
    text_.draw(dl_.game().titre, 34, x + pad, y + 46.f, kText, 1.f, TextRenderer::Left, (int)(pw - 2 * pad));
    const bool self = dl_.isSelfUpdate();
    const float frac = self ? dl_.downloadFraction() : -1.f;
    text_.draw(i18n::tr(self ? "ps4.self.downloading" : "ps4.sending"), 22, x + pad, y + 96.f, kMuted);

    const float bx = x + pad, by = y + 156.f, bw = pw - 2 * pad, bh = 12.f;
    fillRound(bx, by, bw, bh, bh / 2, kBorder, 0.35f);
    if (frac >= 0.f) {
        fillRound(bx, by, std::max(bh, bw * frac), bh, bh / 2, kAccent, 1.f);
        char pct[16];
        std::snprintf(pct, sizeof pct, "%d %%", (int)std::lround(frac * 100.f));
        text_.draw(pct, 22, x + pw - pad, y + 96.f, kText, 1.f, TextRenderer::Right);
    } else {
        const float seg = bw * 0.26f;
        const float pos = (std::sin(time_ * 2.6f) * 0.5f + 0.5f) * (bw - seg);
        fillRound(bx + pos, by, seg, bh, bh / 2, kAccent, 1.f);
    }

    {
        const float iw = psIconWidth(PsBtn::Circle, 30), tw = (float)text_.width(i18n::tr("ps4.cancel"), 20);
        const float sx = x + pw - pad - (iw + 10.f + tw);
        drawPsButtonIcon(PsBtn::Circle, sx, y + ph - 62.f, 30);
        text_.draw(i18n::tr("ps4.cancel"), 20, sx + iw + 10.f, y + ph - 56.f, kMuted);
    }
}

void Ui::drawToast() {
    float a = toastA_.value;
    if (a <= 0.001f || toastMsg_.empty()) return;

    const int maxW = 1180;
    auto lines = wrap(toastMsg_, 22, maxW, 2);
    float w = 0.f;
    for (const auto& l : lines) w = std::max(w, (float)text_.width(l, 22));
    float h = 36.f + lines.size() * 32.f;
    w += 96.f;
    float x = (W - w) / 2.f;
    float y = 950.f - h + (1.f - a) * 36.f;

    panel(x, y, w, h, h / 2.f > 40.f ? 30.f : h / 2.f, a);
    SDL_Color dot = toastOk_ ? SDL_Color{48, 209, 88, 255} : SDL_Color{255, 69, 58, 255};
    fillRound(x + 30.f, y + h / 2.f - 5.f, 10.f, 10.f, 5.f, dot, a);
    float ty = y + 18.f;
    for (const auto& l : lines) { text_.draw(l, 22, x + 56.f, ty, kText, a); ty += 32.f; }
}

void Ui::drawAlert() {
    if (alerts_.empty()) return;
    const float pw = 940.f;
    const int maxW = (int)(pw - 2 * 56.f);
    const auto lines = wrap(alerts_.front(), 26, maxW, 6);
    const float ph = 210.f + lines.size() * 38.f + 76.f;
    const float x = (W - pw) / 2.f, y = (H - ph) / 2.f;
    SDL_SetRenderDrawBlendMode(r_, SDL_BLENDMODE_BLEND);
    SDL_SetRenderDrawColor(r_, 0, 0, 0, 140);
    SDL_Rect veil{0, 0, W, H};
    SDL_RenderFillRect(r_, &veil);
    glassPanel(x, y, pw, ph, 30.f, true);
    const float pad = 56.f;
    fillRound(x + pad, y + 54.f, 14.f, 14.f, 7.f, kOrange, 1.f);
    text_.draw(i18n::tr("ps4.alert.title"), 36, x + pad + 30.f, y + 36.f, kText);
    float ly = y + 112.f;
    for (const auto& l : lines) { text_.draw(l, 26, x + pad, ly, kBody); ly += 38.f; }
    const float bw = 220.f;
    drawButton(x + (pw - bw) / 2.f, y + ph - pad - 52.f + 12.f, bw, 52.f, PsBtn::Cross, i18n::tr("ps4.ok"), true);
}
