#include <SDL2/SDL.h>

#include <orbis/libkernel.h>

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

#include "catalog.h"
#include "config.h"
#include "dns_block.h"
#include "background.h"
#include "downloader.h"
#include "gfx.h"
#include "http.h"
#include "i18n.h"
#include "image_cache.h"
#include "input.h"
#include "installed.h"
#include "payload_sender.h"
#include "platform.h"
#include "plugin_installer.h"
#include "remote_sync.h"
#include "settings.h"
#include "text.h"
#include "ui.h"
#include "self_updater.h"

extern "C" {
uint64_t sceLibcHeapSize = 256ULL * 1024 * 1024;
uint32_t sce_libc_heap_extended_alloc = 1;
uint32_t sceLibcHeapExtendedAlloc = 1;
}

namespace {
constexpr const char* FONT_PATH = "/app0/assets/fonts/font.ttf";
constexpr double FRAME = 1.0 / 60.0;
bool gLaunchUpdater = false;

bool initVideo(SDL_Window*& window, SDL_Renderer*& renderer, bool& surfaceMode) {
    platform::bootLogf("video: memoire directe totale = %llu Mo, tas libc plafonne a %llu Mo",
                       (unsigned long long)(sceKernelGetDirectMemorySize() >> 20),
                       (unsigned long long)(sceLibcHeapSize >> 20));
    int drivers = SDL_GetNumVideoDrivers();
    for (int i = 0; i < drivers; ++i) platform::bootLogf("video: pilote SDL #%d = %s", i, SDL_GetVideoDriver(i));

    bool inited = false;
    for (int attempt = 1; attempt <= 3 && !inited; ++attempt) {
        platform::bootLogf("etape: SDL_Init (essai %d/3)", attempt);
        if (SDL_Init(SDL_INIT_VIDEO) == 0) { inited = true; break; }
        platform::bootLogf("SDL_Init ECHEC (essai %d/3) : %s", attempt, SDL_GetError());
        SDL_Quit();
        SDL_Delay(300);
    }
    if (!inited) return false;
    platform::bootLog("SDL_Init OK");
    SDL_SetHint(SDL_HINT_RENDER_SCALE_QUALITY, "1");

    struct Mode { int w, h; Uint32 flags; const char* name; };
    static const Mode m1080{1920, 1080, 0, "1920x1080"};
    static const Mode m720{1280, 720, 0, "1280x720"};
    static const Mode mFull{1920, 1080, SDL_WINDOW_FULLSCREEN, "1920x1080 plein ecran (dernier recours)"};
    const bool want720 = config::videoMode() == "720p";
    platform::bootLogf("video: video_mode = %s", want720 ? "720p" : "1080p");
    const Mode modes[] = {want720 ? m720 : m1080, want720 ? m1080 : m720, mFull};
    window = nullptr;
    for (const Mode& m : modes) {
        platform::bootLogf("etape: SDL_CreateWindow %s", m.name);
        window = SDL_CreateWindow("PS4Store", SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED, m.w, m.h, m.flags);
        if (window) { platform::bootLogf("fenetre OK (%s)", m.name); break; }
        platform::bootLogf("SDL_CreateWindow ECHEC (%s) : %s", m.name, SDL_GetError());
    }
    if (!window) { SDL_Quit(); return false; }

    surfaceMode = false;
    renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_SOFTWARE | SDL_RENDERER_PRESENTVSYNC);
    if (!renderer) renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_SOFTWARE);
    if (!renderer) {
        platform::bootLogf("rendu logiciel SDL_CreateRenderer: %s ; essai surface", SDL_GetError());
        if (SDL_Surface* surf = SDL_GetWindowSurface(window)) {
            renderer = SDL_CreateSoftwareRenderer(surf);
            surfaceMode = renderer != nullptr;
        }
    }
    if (!renderer) {
        platform::bootLog("dernier recours: SDL_CreateRenderer(flags=0)");
        renderer = SDL_CreateRenderer(window, -1, 0);
    }
    if (!renderer) {
        platform::bootLogf("rendu ECHEC : %s", SDL_GetError());
        SDL_DestroyWindow(window);
        window = nullptr;
        SDL_Quit();
        return false;
    }
    platform::bootLogf("rendu OK (mode %s)", surfaceMode ? "surface" : "renderer");
    SDL_RenderSetLogicalSize(renderer, Ui::W, Ui::H);
    gfx::init(renderer, window);
    return true;
}
}

int main(int, char**) {
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    std::setvbuf(stderr, nullptr, _IONBF, 0);

    platform::bootLog("=== PS4Store: main() demarre ===");
    platform::installCrashHandlers();
    std::string startupWarning;

    SDL_Window* window = nullptr;
    SDL_Renderer* renderer = nullptr;
    bool surfaceMode = false;
    if (!initVideo(window, renderer, surfaceMode)) {
        platform::bootLog("video: initialisation impossible, arret (voir lignes ci-dessus)");
        return 1;
    }

    std::vector<unsigned char> updaterElf;
    TextRenderer::readFile("/app0/assets/misc/updater.elf", updaterElf);
    platform::bootLogf("updater.elf embarque: %u octets", (unsigned)updaterElf.size());
    SDL_DisableScreenSaver();
    platform::bootLog("etape: lecture de la police (avant jailbreak)");
    std::vector<unsigned char> fontBytes;
    std::string fontSource;
    for (const char* p : {FONT_PATH, "assets/fonts/font.ttf"}) {
        if (TextRenderer::readFile(p, fontBytes)) { fontSource = p; break; }
    }
    platform::bootLogf("police pre-chargee: %s", fontSource.empty() ? "ECHEC" : fontSource.c_str());
    platform::bootLog("etape: lecture des traductions (avant jailbreak)");
    i18n::readAll();

    platform::bootLog("etape: jailbreak");
    bool jailbroken = platform::jailbreak();
    platform::bootLogf("jailbreak: %s", jailbroken ? "OK" : "ECHEC (mode degrade)");
    if (!jailbroken) startupWarning = platform::lastError();

    platform::bootLog("etape: sysmodules");
    int modFailed = platform::loadSystemModules();
    platform::bootLogf("sysmodules: %d echec(s)", modFailed);

    platform::bootLog("etape: reseau");
    bool netOk = platform::initNetwork();
    platform::bootLogf("reseau: %s %s", netOk ? "OK" : "ECHEC", netOk ? "" : platform::lastError().c_str());
    if (!netOk && startupWarning.empty()) startupWarning = "Reseau indisponible : " + platform::lastError();
    http::globalInit();
    platform::bootLog("etape: config");
    std::string serverUrl = config::loadServerUrl();
    platform::bootLogf("config: serveur = %s", serverUrl.c_str());

    if (!updaterElf.empty()) platform::bootLogf("updater.elf -> /data/PS4Store : %s", SelfUpdater::installUpdaterElf(std::string(updaterElf.begin(), updaterElf.end())) ? "OK" : "ECHEC");

    platform::bootLog("etape: reglages et langue");
    i18n::init();
    settings::Values cfg = settings::load();
    if (cfg.lang.empty()) {
        cfg.lang = platform::systemLanguage();
        if (cfg.lang.empty()) cfg.lang = "en";
        settings::save(cfg);
    }
    i18n::setIndex(i18n::indexOf(cfg.lang) < 0 ? 0 : i18n::indexOf(cfg.lang));
    platform::bootLogf("reglages: langue=%s theme=%s", cfg.lang.c_str(), settings::palette(cfg.theme).id);

    platform::bootLog("etape: dns_block");
    dns_block::Guard dnsGuard;
    bool dnsFailed = false;
    if (jailbroken && netOk) {
        bool ok = dnsGuard.start();
        dnsFailed = !ok;
        platform::bootLogf("dns_block: %s", ok ? "ACTIF" : "inactif (echec propre)");
        if (ok) platform::setCrashHook([] { dns_block::restoreNow(); });
    } else {
        platform::bootLog("dns_block: ignore (jailbreak ou reseau absent) -> Protection DNS inactive");
    }

    {
        platform::bootLog("etape: font");
        TextRenderer text(renderer);
        bool fontOk = !fontBytes.empty() && text.loadBytes(std::move(fontBytes), fontSource);
        if (!fontOk) fontOk = text.load(FONT_PATH);
        platform::bootLogf("font: %s", fontOk ? "OK" : "ECHEC (texte invisible)");
        if (!fontOk) startupWarning = "Police introuvable (assets/fonts/font.ttf) : texte indisponible";

        platform::bootLog("etape: input");
        Input input;
        if (!input.init()) platform::bootLog("input: manette indisponible");

        {
            Background splashBg(renderer);
            const settings::Palette& pal = settings::palette(cfg.theme);
            splashBg.setGradient(pal.grad[0], pal.grad[1], pal.grad[2], pal.grad[3], pal.grad[4], pal.grad[5], pal.grad[6], pal.grad[7], pal.grad[8]);
            const std::string creator = i18n::tr("ps4.splash.creator");
            constexpr float TOTAL = 2.5f, FADE_IN = 0.3f, FADE_OUT = 0.3f;
            const auto begin = std::chrono::steady_clock::now();
            auto prev = begin;
            for (;;) {
                const auto now = std::chrono::steady_clock::now();
                const float t = std::chrono::duration<float>(now - begin).count();
                const float dt = std::chrono::duration<float>(now - prev).count();
                prev = now;
                if (t >= TOTAL) break;
                SDL_Event ev;
                while (SDL_PollEvent(&ev)) {}
                input.update(dt);
                if (input.pressed(B_CROSS)) { platform::bootLog("splash: passe par Croix"); break; }
                splashBg.update(dt);
                splashBg.draw(1, Ui::W, Ui::H);
                const float a = t < FADE_IN ? t / FADE_IN : (t > TOTAL - FADE_OUT ? (TOTAL - t) / FADE_OUT : 1.f);
                text.draw("PS4Store", 120, Ui::W / 2.f, 400.f, pal.text, a, TextRenderer::Center);
                text.draw(creator, 38, Ui::W / 2.f, 560.f, pal.muted, a, TextRenderer::Center);
                text.endFrame();
                SDL_RenderPresent(renderer);
                if (surfaceMode) SDL_UpdateWindowSurface(window);
                SDL_Delay(8);
            }
        }

        Catalog catalog(serverUrl);
        ImageCache images(renderer);
        Downloader downloader;
        SelfUpdater updater(serverUrl);
        installed::Manager installedMgr;
        plugin::Manager pluginMgr;
        payload::Sender payloadSender;
        RemoteSync remoteSync(serverUrl);
        remoteSync.setToken(cfg.device_token, cfg.paired_username);
        remoteSync.start();
        Ui ui(renderer, text, images, catalog, downloader, input, dnsGuard, installedMgr, updater, pluginMgr, payloadSender, remoteSync);
        ui.initSettings(cfg);
        installedMgr.setLaunchedHook([&](const std::string& titleId, const std::string& name) { remoteSync.reportLaunch(titleId, name); });
        installedMgr.setLaunchHooks([&] { dnsGuard.stop(); },
                                    [&] { if (jailbroken && netOk) dnsGuard.start(); });
        if (!startupWarning.empty()) ui.warn(startupWarning);
        if (dnsFailed) ui.warn(i18n::tr("ps4.alert.dns"));

        platform::bootLog("etape: catalog");
        catalog.refresh();
        updater.check(true);
        platform::bootLog("catalog: refresh lance ; entree dans la boucle de rendu");

        using Clock = std::chrono::steady_clock;
        auto last = Clock::now();
        bool running = true, firstFrameLogged = false;
        int loopErrors = 0;
        double accUpdate = 0.0, accRender = 0.0, worst = 0.0;
        int frames = 0, perfReports = 0;
        auto statStart = Clock::now();

        bool paused = false, pausedByStatus = false;
        int bgPolls = 0;
        double statusTimer = 0.0;
        auto enterPause = [&](const char* why, bool byStatus) {
            if (paused) return;
            paused = true;
            pausedByStatus = byStatus;
            platform::bootLogf("cycle de vie: PAUSE (%s)", why);
            dnsGuard.stop();
            http::setSuspended(true);
            ui.onSuspend();
        };
        auto leavePause = [&](const char* why) {
            platform::bootLogf("cycle de vie: REPRISE (%s)%s", why, paused ? "" : " [sans pause observee]");
            paused = false;
            pausedByStatus = false;
            bgPolls = 0;
            http::setSuspended(false);
            if (jailbroken && netOk && !dnsGuard.active()) dnsGuard.start();
            ui.onResume();
            remoteSync.kick();
            last = Clock::now();
        };

        while (running) {
            SDL_Event e;
            while (SDL_PollEvent(&e)) if (e.type == SDL_QUIT) { std::string perr; if (updater.state() == SelfUpdater::State::Ready && updater.canApply(perr)) gLaunchUpdater = true; running = false; }

            for (int i = 0; i < 16; ++i) {
                platform::SystemEvent ev = platform::pollSystemEvent();
                if (ev == platform::SystemEvent::None) break;
                if (ev == platform::SystemEvent::Pause) enterPause("ON_PAUSE", false);
                else if (ev == platform::SystemEvent::Resume) leavePause("ON_RESUME");
            }

            auto now = Clock::now();
            double dt = std::chrono::duration<double>(now - last).count();

            statusTimer += dt;
            if (statusTimer >= (paused ? 0.25 : 0.5)) {
                statusTimer = 0.0;
#ifdef PS4STORE_STATUS_POLL
                bool bg = platform::inBackground();
#else
                bool bg = false;
#endif
                if (!paused) {
                    bgPolls = bg ? bgPolls + 1 : 0;
                    if (bgPolls >= 2) enterPause("statut arriere-plan", true);
                } else if (pausedByStatus && !bg) {
                    leavePause("statut premier plan");
                    now = Clock::now();
                    dt = 0.0;
                }
            }

            if (paused) {
                last = Clock::now();
                SDL_Delay(200);
                continue;
            }

            if (dt > 3.0) {
                platform::bootLogf("cycle de vie: saut d'horloge de %.1f s", dt);
                leavePause("saut d'horloge");
                now = Clock::now();
                dt = 0.0;
            }
            last = now;
            if (dt > 0.25) dt = 0.25;

            try {
                auto t0 = Clock::now();
                input.update((float)dt);
                ui.update((float)dt);
                if (ui.applyRequested()) { gLaunchUpdater = true; running = false; }
                auto t1 = Clock::now();
                ui.render();
                if (surfaceMode) SDL_UpdateWindowSurface(window);
                auto t2 = Clock::now();
                accUpdate += std::chrono::duration<double>(t1 - t0).count();
                accRender += std::chrono::duration<double>(t2 - t1).count();
                worst = std::max(worst, std::chrono::duration<double>(t2 - t0).count());
                ++frames;
            } catch (...) {
                platform::logCaught("boucle principale (ui)");
                if (++loopErrors >= 20) { platform::bootLog("trop d'exceptions dans la boucle principale : arret"); running = false; }
            }
            if (!firstFrameLogged) { firstFrameLogged = true; platform::bootLog("premiere image rendue"); }

            if (frames > 0 && perfReports < 8 && std::chrono::duration<double>(Clock::now() - statStart).count() >= 5.0) {
                double secs = std::chrono::duration<double>(Clock::now() - statStart).count();
                platform::bootLogf("perf: %.1f img/s | calcul %.1f ms | rendu+affichage %.1f ms | pire image %.0f ms",
                                   frames / secs, accUpdate / frames * 1000.0, accRender / frames * 1000.0, worst * 1000.0);
                ++perfReports; frames = 0; accUpdate = accRender = worst = 0.0; statStart = Clock::now();
            }

            double spent = std::chrono::duration<double>(Clock::now() - now).count();
            if (spent < FRAME) SDL_Delay((Uint32)((FRAME - spent) * 1000.0));
        }

        downloader.cancel();
    }

    platform::bootLog("arret propre demande");
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    http::globalCleanup();
    dnsGuard.stop();
    if (gLaunchUpdater) SelfUpdater::launchUpdaterAndExit();
    return 0;
}
