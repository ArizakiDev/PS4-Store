#include "payload_sender.h"

#include <cstdint>
#include <cstring>

#include "http.h"
#include "i18n.h"
#include "platform.h"

extern "C" {
int sceNetSocket(const char* name, int family, int type, int protocol);
int sceNetConnect(int s, const void* addr, unsigned addrlen);
int sceNetSend(int s, const void* buf, size_t len, int flags);
int sceNetSocketClose(int s);
}

namespace payload {

namespace {
struct SockAddrIn {
    uint8_t len, family;
    uint16_t port;
    uint32_t addr;
    uint8_t zero[8];
};
constexpr int AF_INET_ = 2, SOCK_STREAM_ = 1;
constexpr uint32_t LOOPBACK = 0x0100007Fu;

std::string sendAll(const std::string& data) {
    int s = sceNetSocket("ps4store_payload", AF_INET_, SOCK_STREAM_, 0);
    if (s < 0) return "socket 0x" + std::to_string((unsigned)s);
    SockAddrIn a;
    std::memset(&a, 0, sizeof a);
    a.len = sizeof a;
    a.family = AF_INET_;
    a.port = (uint16_t)(((BINLOADER_PORT & 0xFF) << 8) | (BINLOADER_PORT >> 8));
    a.addr = LOOPBACK;
    if (sceNetConnect(s, &a, sizeof a) < 0) { sceNetSocketClose(s); return "BinLoader 127.0.0.1:" + std::to_string(BINLOADER_PORT) + " injoignable (GoldHEN actif ?)"; }
    size_t off = 0;
    while (off < data.size()) {
        int n = sceNetSend(s, data.data() + off, data.size() - off, 0);
        if (n <= 0) { sceNetSocketClose(s); return "envoi interrompu"; }
        off += (size_t)n;
    }
    sceNetSocketClose(s);
    return "";
}
}

Sender::~Sender() { if (th_.joinable()) th_.join(); }

Sender::Event Sender::lastEvent() const { std::lock_guard<std::mutex> l(m_); return event_; }

void Sender::post(bool ok, const std::string& msg) {
    std::lock_guard<std::mutex> l(m_);
    event_.ok = ok;
    event_.message = msg;
    ++event_.serial;
}

void Sender::send(const Game& g) {
    if (busy_.exchange(true)) return;
    if (th_.joinable()) th_.join();
    th_ = std::thread([this, g] {
        try { run(g); }
        catch (...) { platform::logCaught("payload_sender"); post(false, i18n::tr("ps4.payload.fail", {{"err", "exception"}})); }
        busy_ = false;
    });
}

void Sender::run(Game g) {
    std::string body, err;
    long code = http::get(g.pkg_url, body, err, 60);
    if (code != 200 || body.empty()) {
        post(false, i18n::tr("ps4.payload.fail", {{"err", err.empty() ? "HTTP " + std::to_string(code) : err}}));
        return;
    }
    const std::string why = sendAll(body);
    platform::bootLogf("payload: %s %u octets -> %s", g.titre.c_str(), (unsigned)body.size(), why.empty() ? "envoye" : why.c_str());
    if (why.empty()) post(true, i18n::tr("ps4.payload.sent"));
    else post(false, i18n::tr("ps4.payload.fail", {{"err", why}}));
}

}
