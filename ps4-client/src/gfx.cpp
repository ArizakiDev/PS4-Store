#include "gfx.h"

#include <cstring>
#include <vector>

#include "platform.h"

namespace gfx {
namespace {

Uint32 g_format = SDL_PIXELFORMAT_ABGR8888;

Uint32 withAlpha(Uint32 f) {
    switch (f) {
        case SDL_PIXELFORMAT_RGB888:  return SDL_PIXELFORMAT_ARGB8888;
        case SDL_PIXELFORMAT_BGR888:  return SDL_PIXELFORMAT_ABGR8888;
        case SDL_PIXELFORMAT_RGBX8888: return SDL_PIXELFORMAT_RGBA8888;
        case SDL_PIXELFORMAT_BGRX8888: return SDL_PIXELFORMAT_BGRA8888;
        default: return f;
    }
}

}

Uint32 format() { return g_format; }

void init(SDL_Renderer* renderer, SDL_Window* window) {
    Uint32 surfFmt = SDL_PIXELFORMAT_UNKNOWN;
    if (SDL_Surface* s = SDL_GetWindowSurface(window)) surfFmt = s->format->format;
    platform::bootLogf("gfx: surface de la fenetre = %s (%d octets/pixel)", SDL_GetPixelFormatName(surfFmt),
                       surfFmt == SDL_PIXELFORMAT_UNKNOWN ? 0 : (int)SDL_BYTESPERPIXEL(surfFmt));

    SDL_RendererInfo info;
    std::memset(&info, 0, sizeof info);
    bool haveInfo = SDL_GetRendererInfo(renderer, &info) == 0;
    if (haveInfo) {
        platform::bootLogf("gfx: moteur de rendu = %s, flags=0x%X, %u format(s) de texture", info.name ? info.name : "?",
                           (unsigned)info.flags, (unsigned)info.num_texture_formats);
        for (Uint32 i = 0; i < info.num_texture_formats && i < 16; ++i)
            platform::bootLogf("gfx:   format de texture #%u = %s", (unsigned)i, SDL_GetPixelFormatName(info.texture_formats[i]));
    }

    Uint32 wanted = surfFmt != SDL_PIXELFORMAT_UNKNOWN && SDL_BYTESPERPIXEL(surfFmt) == 4 ? withAlpha(surfFmt) : g_format;
    bool supported = !haveInfo;
    for (Uint32 i = 0; haveInfo && i < info.num_texture_formats; ++i)
        if (info.texture_formats[i] == wanted) supported = true;
    g_format = (SDL_ISPIXELFORMAT_ALPHA(wanted) && supported) ? wanted : SDL_PIXELFORMAT_ABGR8888;
    platform::bootLogf("gfx: format des textures retenu = %s%s", SDL_GetPixelFormatName(g_format),
                       g_format == surfFmt ? " (identique a la surface : blits rapides)" : " (converti par SDL a chaque blit)");
}

SDL_Texture* makeTexture(SDL_Renderer* renderer, const unsigned char* rgba, int w, int h) {
    if (w <= 0 || h <= 0 || !rgba) return nullptr;
    Uint32 fmt = g_format;
    SDL_Texture* t = SDL_CreateTexture(renderer, fmt, SDL_TEXTUREACCESS_STATIC, w, h);
    if (!t && fmt != SDL_PIXELFORMAT_ABGR8888) {
        fmt = SDL_PIXELFORMAT_ABGR8888;
        t = SDL_CreateTexture(renderer, fmt, SDL_TEXTUREACCESS_STATIC, w, h);
    }
    if (!t) return nullptr;

    if (fmt == SDL_PIXELFORMAT_ABGR8888) {
        SDL_UpdateTexture(t, nullptr, rgba, w * 4);
    } else {
        std::vector<unsigned char> conv((size_t)w * h * 4);
        if (SDL_ConvertPixels(w, h, SDL_PIXELFORMAT_ABGR8888, rgba, w * 4, fmt, conv.data(), w * 4) != 0) {
            SDL_DestroyTexture(t);
            return nullptr;
        }
        SDL_UpdateTexture(t, nullptr, conv.data(), w * 4);
    }
    SDL_SetTextureBlendMode(t, SDL_BLENDMODE_BLEND);
    return t;
}

}
