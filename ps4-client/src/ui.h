#pragma once
#include <SDL2/SDL.h>

#include <atomic>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "anim.h"
#include "catalog.h"
#include "dns_block.h"
#include "downloader.h"
#include "image_cache.h"
#include "input.h"
#include "background.h"
#include "installed.h"
#include "payload_sender.h"
#include "plugin_installer.h"
#include "remote_sync.h"
#include "settings.h"
#include "text.h"
#include "self_updater.h"
#include "updater.h"

enum class PsBtn { Cross, Circle, Triangle, Square, L1, R1, Options, Touchpad };

class Ui {
public:
    static constexpr int W = 1920;
    static constexpr int H = 1080;
    static constexpr int TABS = 6;
    enum TabKind { K_ALL, K_NEW, K_FEATURED, K_INSTALLED, K_LIBRARY, K_SETTINGS };
    TabKind tabKind(int i) const {
        static const TabKind t[TABS] = {K_FEATURED, K_NEW, K_ALL, K_INSTALLED, K_LIBRARY, K_SETTINGS};
        if (!remote_.paired() && i >= 4) return K_SETTINGS;
        return t[std::max(0, std::min(TABS - 1, i))];
    }

    Ui(SDL_Renderer* r, TextRenderer& text, ImageCache& images, Catalog& catalog, Downloader& dl, Input& input,
       const dns_block::Guard& dns, installed::Manager& inst, SelfUpdater& upd, plugin::Manager& plugins, payload::Sender& payloads, RemoteSync& remote);
    ~Ui();

    void initSettings(const settings::Values& v);

    bool applyRequested() const { return applyRequested_; }
    void update(float dt);
    void render();

    void onSuspend();
    void onResume();

    void warn(const std::string& msg) { if (!msg.empty()) alerts_.push_back(msg); }
    void announce(bool ok, const std::string& msg) { notify(ok, msg, 8.f); }

private:
    SDL_Texture* roundTex(int r);
    void fillRound(float x, float y, float w, float h, float r, SDL_Color c, float alpha);
    void panel(float x, float y, float w, float h, float r, float alpha);
    void panelOpaque(float x, float y, float w, float h, float r);
    void glassPanel(float x, float y, float w, float h, float r, bool opaque = false);
    void ringRound(float x, float y, float w, float h, float r, SDL_Color c, float alpha);
    SDL_Texture* ringTex(int r);
    SDL_Texture* iconTex(PsBtn b, int size);
    float drawPsButtonIcon(PsBtn b, float x, float y, int size, float alpha = 1.f);
    float psIconWidth(PsBtn b, int size);
    void drawButton(float x, float y, float w, float h, PsBtn icon, const std::string& label, bool primary);
    void drawBadge(const std::string& label, float x, float y, SDL_Color c, float alpha);
    void drawGloss(float x, float y, float size, float alpha);
    std::vector<std::string> wrap(const std::string& s, int px, int maxW, int maxLines);

    enum class Modal { None, Region, Force };
    void drawRegionModal();
    void drawSettings();
    void drawPair();
    void drawSearch();
    bool startIme(int mode = 0);
    void drawHistory();
    void pollIme();
    void ensureLogo();
    bool matchesQuery(const Game& g) const;
    std::string buildHeartbeat() const;
    void handleCommand(const RemoteSync::Command& c);
    void startRemote(const RemoteSync::Request& rq);
    int tabCount() const { return remote_.paired() ? TABS : TABS - 1; }
    void refreshDisk();
    static uint64_t parseSizeBytes(const std::string& s);
    std::string fmtDate(const std::string& iso) const;
    void drawHeartIcon(float x, float y, float w, SDL_Color c, float alpha);
    void drawDownIcon(float x, float y, float w, SDL_Color c, float alpha);
    void startReport(const Game& g);
    void pollReport();
    int installedCount() const;
    std::string fmtGb(uint64_t bytes) const;
    void drawRelated();
    void applyTheme();
    void applyLanguage();
    void saveSettings();
    void notify(bool ok, const std::string& msg, float seconds = 5.5f);
    std::string tabLabel(int i) const;
    std::string typeLabel(const Game& g) const;
    void activate(const Game& g, installed::State st);
    void beginPlugin(const Game& g);
    bool baseInstalled(const Game& g) const;
    bool canUninstall(const Game& g, installed::State st) const;
    std::string primaryLabel(const Game& g, installed::State st) const;
    void rebuildRelated();
    bool offline() const { return catalog_.fromCache(); }

    void rebuildFilter(const std::string& keepId = std::string());
    void rescan();
    installed::State stateOf(const Game& g, std::string* installedVersion = nullptr) const;
    void setTab(int t);
    void ensureVisible();
    const Game* selectedGame() const;

    void drawHeader();
    void drawGrid();
    void drawCover(const Game& g, float x, float y, float size, float alpha);
    void drawDetail();
    void drawPreparing();
    void drawToast();
    void drawAlert();
    void drawConfirm();
    void drawPill(const std::string& label, float x, float y, int px, SDL_Color c, bool solid, float alpha);
    void drawStatus();
    void drawHints();

    SDL_Renderer* r_;
    TextRenderer& text_;
    ImageCache& images_;
    Catalog& catalog_;
    Downloader& dl_;
    Input& in_;
    const dns_block::Guard& dns_;
    installed::Manager& inst_;
    SelfUpdater& upd_;
    plugin::Manager& plugins_;
    payload::Sender& payloads_;
    RemoteSync& remote_;
    settings::Values cfg_;
    std::set<std::string> pluginPresent_;
    unsigned pluginVersion_ = 0, pluginSerial_ = 0, payloadSerial_ = 0;
    Modal modal_ = Modal::None;
    int regionSel_ = 0;
    Game pending_;
    std::vector<std::string> alerts_;
    bool offlineWarned_ = false;
    bool settings_ = false;
    bool manualCheck_ = false;
    uint64_t diskFree_ = 0, diskTotal_ = 0;
    bool diskValid_ = false;
    float diskTimer_ = 0.f;
    std::thread reportTh_;
    std::atomic<int> reportState_{0};
    std::mutex reportM_;
    std::string reportMsg_;
    std::set<std::string> libraryIds_, likedIds_;
    std::string remoteUser_;
    unsigned remoteVersion_ = 0;
    bool pairOpen_ = false, pairWaiting_ = false;
    std::string pairCode_, pairError_;
    int pairCursor_ = 0;
    bool searchOpen_ = false;
    int updCount_ = 0;
    int imeMode_ = 0;
    bool historyOpen_ = false;
    int histSel_ = 0;
    float updPoll_ = 0.f;
    float updAt_ = -10.f;
    bool imeTried_ = false, imeReady_ = false, imeActive_ = false;
    char16_t imeBuf_[64] = {};
    std::u16string imeTitle_, imePlace_;
    SDL_Texture* logoTex_ = nullptr;
    std::string query_;
    int kbCursor_ = 0;
    float heartbeatTimer_ = 0.f;
    bool applyRequested_ = false;
    bool cmdUninstallActive_ = false;
    unsigned cmdSerial_ = 0;
    std::string cmdId_, cmdName_;
    bool remoteActive_ = false;
    int remoteKind_ = 0;
    unsigned remoteSerial_ = 0;
    std::string remoteQueue_, remoteName_;
    int setRow_ = 0;
    bool relatedOpen_ = false;
    int relSel_ = 0;
    std::vector<int> related_;
    bool confirmSelfUpdate_ = false;
    bool updAnnounced_ = false;

    std::map<int, SDL_Texture*> roundTextures_;

    std::vector<Game> games_;
    std::map<std::string, installed::Entry> instMap_;
    unsigned instVersion_ = 0;
    unsigned instSerial_ = 0;
    float rescanTimer_ = 0.f;
    float lastTaskSeen_ = -1000.f;
    bool confirmUninstall_ = false;
    unsigned catalogVersion_ = 0;
    bool requested_ = false;
    std::vector<int> filtered_;
    std::vector<anim::Smooth> cardScale_;

    int tab_ = 2;
    int sel_ = 0;
    int lastSel_ = -1;
    float selIdle_ = 0.f;
    bool largeAsked_ = false;
    bool detail_ = false;
    float time_ = 0.f;

    anim::Smooth scrollY_{0.f, 38.f};
    anim::Smooth pillX_{0.f, 34.f};
    anim::Smooth pillW_{0.f, 34.f};
    anim::Smooth gridAlpha_{1.f, 26.f};
    anim::Smooth detailA_{0.f, 30.f};
    anim::Smooth dlA_{0.f, 30.f};
    anim::Smooth toastA_{0.f, 11.f};
    anim::Smooth sysBar_{0.f, 8.f};
    unsigned toastSerial_ = 0;
    float toastTimer_ = 0.f;
    bool toastOk_ = true;
    std::string toastMsg_;
    float tabX_[TABS] = {}, tabW_[TABS] = {};
    bool tabsMeasured_ = false;
    float scrollTarget_ = 0.f;

    Background bg_;
    int quality_ = 2, qualityMax_ = 3, qFrames_ = 0, qGood_ = 0;
    float avgDt_ = 0.016f;
    std::map<int, SDL_Texture*> iconTextures_, ringTextures_;
    SDL_Texture* gloss_ = nullptr;
};
