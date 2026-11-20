#include "dns_block.h"

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>

#include "config.h"
#include "platform.h"

extern "C" {
int sceNetSocket(const char* name, int family, int type, int protocol);
int sceNetBind(int s, const void* addr, unsigned addrlen);
int sceNetRecvfrom(int s, void* buf, size_t len, int flags, void* from, unsigned* fromlen);
int sceNetSendto(int s, const void* buf, size_t len, int flags, const void* to, unsigned tolen);
int sceNetSetsockopt(int s, int level, int optname, const void* optval, unsigned optlen);
int sceNetSocketClose(int s);
int sceNetSocketAbort(int s, int flags);
int sceNetGetDnsInfo(void* info, int flags);
int sceNetSetDnsInfoToKernel(void* info, int flags);
}

namespace dns_block {
namespace {

struct DnsInfo { uint32_t primary, secondary; };

struct alignas(16) DnsBuffer { uint8_t raw[256]; };

int getDns(DnsInfo& out) {
    DnsBuffer b; std::memset(&b, 0, sizeof b);
    int rc = sceNetGetDnsInfo(&b, 0);
    std::memcpy(&out, b.raw, sizeof out);
    return rc;
}
int setDns(const DnsInfo& in) {
    DnsBuffer b; std::memset(&b, 0, sizeof b);
    std::memcpy(b.raw, &in, sizeof in);
    return sceNetSetDnsInfoToKernel(&b, 0);
}

struct SockAddrIn {
    uint8_t len, family;
    uint16_t port;
    uint32_t addr;
    uint8_t zero[8];
};

constexpr int AF_INET_ = 2, SOCK_DGRAM_ = 2;
constexpr int SOL_SOCKET_ = 0xFFFF, SO_RCVTIMEO_ = 0x1006;
constexpr uint32_t LOOPBACK = 0x0100007Fu;
constexpr uint16_t PORT53 = 0x3500u;

std::mutex g_mutex;
bool g_saved = false;
DnsInfo g_original{0, 0};
int g_listen = -1;
std::atomic<bool> g_stop{false};
std::thread g_worker;
bool g_atexit = false;

std::string backupPath() { return std::string(config::DATA_DIR) + "/dns_backup.txt"; }

void writeBackup(const DnsInfo& d) {
    if (FILE* f = std::fopen(backupPath().c_str(), "w")) {
        std::fprintf(f, "%08x %08x\n", (unsigned)d.primary, (unsigned)d.secondary);
        std::fclose(f);
    }
}
bool readBackup(DnsInfo& d) {
    FILE* f = std::fopen(backupPath().c_str(), "r");
    if (!f) return false;
    unsigned a = 0, b = 0;
    bool ok = std::fscanf(f, "%x %x", &a, &b) == 2 && a != 0 && a != LOOPBACK;
    std::fclose(f);
    d.primary = a; d.secondary = b;
    return ok;
}

SockAddrIn makeAddr(uint32_t addr, uint16_t port) {
    SockAddrIn s;
    std::memset(&s, 0, sizeof s);
    s.len = sizeof s;
    s.family = AF_INET_;
    s.port = port;
    s.addr = addr;
    return s;
}

size_t parseQuestion(const uint8_t* q, size_t n, char* out, size_t outSize) {
    size_t i = 12, o = 0;
    while (i < n && q[i] != 0) {
        size_t lbl = q[i++];
        if (lbl > 63 || i + lbl > n) return 0;
        for (size_t k = 0; k < lbl && o + 1 < outSize; ++k) {
            char c = (char)q[i + k];
            out[o++] = (c >= 'A' && c <= 'Z') ? (char)(c + 32) : c;
        }
        if (o + 1 < outSize) out[o++] = '.';
        i += lbl;
    }
    out[o < outSize ? o : outSize - 1] = 0;
    if (i + 5 > n || q[i] != 0) return 0;
    return i + 1 + 4;
}

bool isBlocked(const char* name) {
    return std::strstr(name, "playstation") || std::strstr(name, ".sony") ||
           std::strstr(name, "sonyentertainmentnetwork");
}

size_t buildBlockedReply(uint8_t* buf, size_t qlen) {
    uint16_t qtype = (uint16_t)((buf[qlen - 4] << 8) | buf[qlen - 3]);
    buf[2] = 0x81; buf[3] = 0x80;
    buf[8] = buf[9] = buf[10] = buf[11] = 0;
    if (qtype != 1) { buf[6] = 0; buf[7] = 0; return qlen; }
    buf[6] = 0; buf[7] = 1;
    static const uint8_t answer[] = {0xC0, 0x0C, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 0, 0, 0, 0};
    std::memcpy(buf + qlen, answer, sizeof answer);
    return qlen + sizeof answer;
}

void worker(uint32_t upstream) {
    int up = sceNetSocket("ps4store_dns_up", AF_INET_, SOCK_DGRAM_, 0);
    if (up >= 0) {
        int timeoutUs = 3000000;
        sceNetSetsockopt(up, SOL_SOCKET_, SO_RCVTIMEO_, &timeoutUs, sizeof timeoutUs);
    }
    SockAddrIn upAddr = makeAddr(upstream, PORT53);
    uint8_t buf[2048];

    while (!g_stop.load()) {
        SockAddrIn from;
        std::memset(&from, 0, sizeof from);
        unsigned fromLen = sizeof from;
        int n = sceNetRecvfrom(g_listen, buf, sizeof buf - 32, 0, &from, &fromLen);
        if (n < 12) continue;

        char name[256];
        size_t qlen = parseQuestion(buf, (size_t)n, name, sizeof name);
        if (qlen && isBlocked(name)) {
            size_t rlen = buildBlockedReply(buf, qlen);
            sceNetSendto(g_listen, buf, rlen, 0, &from, sizeof from);
            continue;
        }
        if (up < 0) continue;
        sceNetSendto(up, buf, (size_t)n, 0, &upAddr, sizeof upAddr);
        SockAddrIn ru;
        std::memset(&ru, 0, sizeof ru);
        unsigned rl = sizeof ru;
        int m = sceNetRecvfrom(up, buf, sizeof buf, 0, &ru, &rl);
        if (m > 0) sceNetSendto(g_listen, buf, (size_t)m, 0, &from, sizeof from);
    }
    if (up >= 0) sceNetSocketClose(up);
}

void restoreLocked() {
    if (!g_saved) return;
    setDns(g_original);
    g_saved = false;
    std::remove(backupPath().c_str());
}

}

void restoreNow() {
    std::unique_lock<std::mutex> l(g_mutex, std::try_to_lock);
    restoreLocked();
}

bool Guard::start() {
    std::lock_guard<std::mutex> l(g_mutex);
    if (active_) return true;

    DnsInfo cur{0, 0};
    int rc = getDns(cur);
    platform::bootLogf("dns: sceNetGetDnsInfo rc=0x%08X primary=%08x", (unsigned)rc, (unsigned)cur.primary);
    if (rc < 0) return false;

    if (cur.primary == LOOPBACK) {
        DnsInfo saved;
        if (!readBackup(saved)) return false;
        setDns(saved);
        cur = saved;
    }
    if (cur.primary == 0) return false;

    g_original = cur;
    g_listen = sceNetSocket("ps4store_dns", AF_INET_, SOCK_DGRAM_, 0);
    platform::bootLogf("dns: sceNetSocket=%d", g_listen);
    if (g_listen < 0) return false;
    SockAddrIn local = makeAddr(LOOPBACK, PORT53);
    int brc = sceNetBind(g_listen, &local, sizeof local);
    platform::bootLogf("dns: bind 127.0.0.1:53 rc=0x%08X", (unsigned)brc);
    if (brc < 0) {
        sceNetSocketClose(g_listen);
        g_listen = -1;
        return false;
    }

    writeBackup(cur);
    DnsInfo loop{LOOPBACK, 0};
    rc = setDns(loop);
    platform::bootLogf("dns: sceNetSetDnsInfoToKernel rc=0x%08X", (unsigned)rc);
    if (rc < 0) {
        sceNetSocketClose(g_listen);
        g_listen = -1;
        std::remove(backupPath().c_str());
        return false;
    }
    g_stop = false;
    try {
        const uint32_t upstream = cur.primary;
        g_worker = std::thread([upstream] {
            try { worker(upstream); }
            catch (...) { platform::logCaught("dns_worker"); }
        });
    } catch (...) {
        setDns(g_original);
        sceNetSocketClose(g_listen);
        g_listen = -1;
        std::remove(backupPath().c_str());
        return false;
    }
    g_saved = true;
    active_ = true;
    if (!g_atexit) { g_atexit = true; std::atexit([] { dns_block::restoreNow(); }); }
    return true;
}

void Guard::stop() {
    std::lock_guard<std::mutex> l(g_mutex);
    if (!active_) return;
    restoreLocked();
    g_stop = true;
    if (g_listen >= 0) sceNetSocketAbort(g_listen, 0);
    if (g_worker.joinable()) g_worker.join();
    if (g_listen >= 0) sceNetSocketClose(g_listen);
    g_listen = -1;
    active_ = false;
}

}
