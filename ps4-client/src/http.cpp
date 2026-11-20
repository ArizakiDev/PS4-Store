#include "http.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <strings.h>
#include <cstdint>
#include <atomic>
#include <mutex>
#include <set>
#include <vector>
#include <orbis/Http.h>

#include "platform.h"

namespace http {
namespace {

const char* kUserAgent = "PS4Store/1.0";
const int kMaxRedirects = 10;

int32_t skipSslCallback(int32_t, uint32_t, void* const[], int32_t, void*) { return 1; }

std::atomic<bool> g_suspended{false};
std::mutex g_regMutex;
std::set<int> g_activeReqs;

void registerReq(int id) { std::lock_guard<std::mutex> l(g_regMutex); g_activeReqs.insert(id); }
void unregisterReq(int id) { std::lock_guard<std::mutex> l(g_regMutex); g_activeReqs.erase(id); }

struct Session {
    int tpl = -1, conn = -1, req = -1;
    ~Session() { close(); }
    void close() {
        if (req >= 0)  { unregisterReq(req); sceHttpDeleteRequest(req); req = -1; }
        if (conn >= 0) { sceHttpDeleteConnection(conn);   conn = -1; }
        if (tpl >= 0)  { sceHttpDeleteTemplate(tpl);      tpl = -1; }
    }
};

std::string hex(int v) { char b[16]; std::snprintf(b, sizeof b, "0x%08X", (unsigned)v); return b; }

std::string findLocation(const char* hdr, size_t len) {
    std::string h(hdr, len);
    size_t pos = 0;
    while (pos < h.size()) {
        size_t eol = h.find('\n', pos);
        if (eol == std::string::npos) eol = h.size();
        std::string line = h.substr(pos, eol - pos);
        pos = eol + 1;
        if (line.size() > 9 && strncasecmp(line.c_str(), "location:", 9) == 0) {
            size_t a = line.find_first_not_of(" \t", 9);
            size_t b = line.find_last_not_of(" \t\r\n");
            if (a != std::string::npos && b >= a) return line.substr(a, b - a + 1);
        }
    }
    return "";
}

std::string resolveUrl(const std::string& base, const std::string& loc) {
    if (loc.compare(0, 7, "http://") == 0 || loc.compare(0, 8, "https://") == 0) return loc;
    size_t schemeEnd = base.find("://");
    if (schemeEnd == std::string::npos) return loc;
    size_t hostEnd = base.find('/', schemeEnd + 3);
    std::string origin = hostEnd == std::string::npos ? base : base.substr(0, hostEnd);
    if (!loc.empty() && loc[0] == '/') return origin + loc;
    size_t lastSlash = base.rfind('/');
    std::string dir = lastSlash > schemeEnd + 2 ? base.substr(0, lastSlash + 1) : origin + "/";
    return dir + loc;
}

struct ReqOpts {
    int method = ORBIS_METHOD_GET;
    const std::string* bearer = nullptr;
    const std::string* body = nullptr;
};

long openRequest(Session& s, const std::string& startUrl, const char* range, long timeoutSec, std::string& err, const ReqOpts* opts = nullptr) {
    int ctx = platform::httpContextId();
    if (ctx < 0) { err = "libSceHttp non initialisée"; return 0; }

    std::string url = startUrl;
    for (int hop = 0; hop <= kMaxRedirects; ++hop) {
        if (g_suspended.load()) { err = "Application en arrière-plan"; return 0; }
        s.close();
        s.tpl = sceHttpCreateTemplate(ctx, kUserAgent, ORBIS_HTTP_VERSION_1_1, 1);
        if (s.tpl < 0) { err = "sceHttpCreateTemplate " + hex(s.tpl); s.tpl = -1; return 0; }
        sceHttpsSetSslCallback(s.tpl, skipSslCallback, nullptr);
        uint32_t t = (uint32_t)(timeoutSec * 1000000L);
        sceHttpSetResolveTimeOut(s.tpl, 15u * 1000000u);
        sceHttpSetConnectTimeOut(s.tpl, 15u * 1000000u);
        sceHttpSetSendTimeOut(s.tpl, t);

        s.conn = sceHttpCreateConnectionWithURL(s.tpl, url.c_str(), true);
        if (s.conn < 0) { err = "sceHttpCreateConnectionWithURL " + hex(s.conn); s.conn = -1; return 0; }
        s.req = sceHttpCreateRequestWithURL(s.conn, opts ? opts->method : ORBIS_METHOD_GET, url.c_str(), opts && opts->body ? (uint64_t)opts->body->size() : 0);
        if (s.req < 0) { err = "sceHttpCreateRequestWithURL " + hex(s.req); s.req = -1; return 0; }
        registerReq(s.req);
        if (g_suspended.load()) { err = "Application en arrière-plan"; return 0; }
        if (range) sceHttpAddRequestHeader(s.req, "Range", range, 0);
        if (opts && opts->bearer && !opts->bearer->empty()) sceHttpAddRequestHeader(s.req, "Authorization", ("Bearer " + *opts->bearer).c_str(), 0);
        if (opts && opts->body) sceHttpAddRequestHeader(s.req, "Content-Type", "application/json", 0);

        int rc = opts && opts->body ? sceHttpSendRequest(s.req, opts->body->data(), opts->body->size()) : sceHttpSendRequest(s.req, nullptr, 0);
        if (rc < 0) { err = "sceHttpSendRequest " + hex(rc); return 0; }
        int32_t status = 0;
        rc = sceHttpGetStatusCode(s.req, &status);
        if (rc < 0) { err = "sceHttpGetStatusCode " + hex(rc); return 0; }

        if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
            char* hdr = nullptr; size_t hlen = 0;
            std::string loc;
            if (sceHttpGetAllResponseHeaders(s.req, &hdr, &hlen) >= 0 && hdr) loc = findLocation(hdr, hlen);
            if (loc.empty()) return status;
            url = resolveUrl(url, loc);
            continue;
        }
        return status;
    }
    err = "Trop de redirections";
    return 0;
}

}

void globalInit() {}
void globalCleanup() {}

void abortAll() {
    std::lock_guard<std::mutex> l(g_regMutex);
    for (int id : g_activeReqs) sceHttpAbortRequest(id);
}

void setSuspended(bool on) {
    g_suspended = on;
    if (on) abortAll();
}

bool suspended() { return g_suspended.load(); }

long get(const std::string& url, std::string& body, std::string& err, long timeoutSec) {
    body.clear();
    Session s;
    long code = openRequest(s, url, nullptr, timeoutSec, err);
    if (code == 0) return 0;
    if (code >= 400) { err = "HTTP " + std::to_string(code); return code; }

    std::vector<char> bufStore(16 * 1024);
    char* buf = bufStore.data();
    const size_t bufSize = bufStore.size();
    for (;;) {
        if (g_suspended.load()) { err = "Application en arrière-plan"; return 0; }
        int n = sceHttpReadData(s.req, buf, (uint32_t)bufSize);
        if (n < 0) { err = "sceHttpReadData " + hex(n); return 0; }
        if (n == 0) break;
        body.append(buf, (size_t)n);
    }
    return code;
}

long request(const std::string& method, const std::string& url, const std::string& bearer, const std::string& body,
             std::string& respBody, std::string& err, long timeoutSec) {
    respBody.clear();
    ReqOpts o;
    o.method = method == "POST" ? ORBIS_METHOD_POST : ORBIS_METHOD_GET;
    o.bearer = &bearer;
    if (o.method == ORBIS_METHOD_POST) o.body = &body;
    Session s;
    long code = openRequest(s, url, nullptr, timeoutSec, err, &o);
    if (code == 0) return 0;
    std::vector<char> bufStore(8 * 1024);
    for (;;) {
        if (g_suspended.load()) { err = "Application en arrière-plan"; return 0; }
        int n = sceHttpReadData(s.req, bufStore.data(), (uint32_t)bufStore.size());
        if (n < 0) { err = "sceHttpReadData " + hex(n); return 0; }
        if (n == 0) break;
        respBody.append(bufStore.data(), (size_t)n);
        if (respBody.size() > (1u << 20)) break;
    }
    return code;
}

long downloadToFile(const std::string& url, const std::string& path, uint64_t& total,
                    const std::function<void(uint64_t, uint64_t)>& progress, const std::atomic<bool>* cancel, std::string& err) {
    total = 0;
    Session s;
    long code = openRequest(s, url, nullptr, 60, err);
    if (code == 0) return 0;
    if (code >= 400) { err = "HTTP " + std::to_string(code); return code; }
    int32_t clRes = 0;
    size_t clLen = 0;
    if (sceHttpGetResponseContentLength(s.req, &clRes, &clLen) >= 0 && clRes == 0) total = (uint64_t)clLen;

    const std::string part = path + ".part";
    FILE* f = std::fopen(part.c_str(), "wb");
    if (!f) { err = "Ecriture impossible : " + part; return 0; }
    std::vector<char> bufStore(64 * 1024);
    uint64_t done = 0;
    bool ok = true;
    for (;;) {
        if (g_suspended.load()) { err = "Application en arrière-plan"; ok = false; break; }
        if (cancel && cancel->load()) { err = "Annulé"; ok = false; break; }
        int n = sceHttpReadData(s.req, bufStore.data(), (uint32_t)bufStore.size());
        if (n < 0) { err = "sceHttpReadData " + hex(n); ok = false; break; }
        if (n == 0) break;
        if (std::fwrite(bufStore.data(), 1, (size_t)n, f) != (size_t)n) { err = "Disque plein ou ecriture impossible"; ok = false; break; }
        done += (uint64_t)n;
        if (progress) progress(done, total);
    }
    if (std::fclose(f) != 0) ok = false;
    if (!ok) { std::remove(part.c_str()); return 0; }
    std::remove(path.c_str());
    if (std::rename(part.c_str(), path.c_str()) != 0) { err = "Renommage impossible"; std::remove(part.c_str()); return 0; }
    if (progress) progress(done, total ? total : done);
    return code;
}

bool getHead(const std::string& url, int count, std::string& body, bool& partial, std::string& err) {
    partial = false;
    body.clear();
    char range[48];
    std::snprintf(range, sizeof range, "bytes=0-%d", count - 1);

    Session s;
    long code = openRequest(s, url, range, 30, err);
    if (code == 0) return false;
    partial = code == 206;
    if (code >= 400) { err = "HTTP " + std::to_string(code); return false; }

    std::vector<char> bufStore(8 * 1024);
    char* buf = bufStore.data();
    const size_t bufSize = bufStore.size();
    while (body.size() < (size_t)count) {
        if (g_suspended.load()) { err = "Application en arrière-plan"; return false; }
        size_t want = (size_t)count - body.size();
        if (want > bufSize) want = bufSize;
        int n = sceHttpReadData(s.req, buf, (uint32_t)want);
        if (n < 0) { err = "sceHttpReadData " + hex(n); return false; }
        if (n == 0) break;
        body.append(buf, (size_t)n);
    }
    if (body.size() >= (size_t)count) return true;
    err = "Fichier trop court";
    return false;
}

}
