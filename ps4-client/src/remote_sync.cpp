#include "remote_sync.h"

#include <chrono>

#include "http.h"
#include "json.h"
#include "platform.h"

namespace {
constexpr int kSyncEverySlices = 50;
}

RemoteSync::~RemoteSync() {
    quit_ = true;
    http::abortAll();
    if (th_.joinable()) th_.join();
}

void RemoteSync::start() {
    if (th_.joinable()) return;
    th_ = std::thread([this] {
        try { loop(); }
        catch (...) { platform::logCaught("remote_sync"); }
    });
}

void RemoteSync::setToken(const std::string& token, const std::string& username) {
    std::lock_guard<std::mutex> l(m_);
    token_ = token;
    username_ = username;
    pending_.clear();
    handed_.clear();
    library_.clear();
    likes_.clear();
    ++version_;
    revoked_ = false;
    if (!token.empty()) kick_ = true;
}

bool RemoteSync::paired() const { std::lock_guard<std::mutex> l(m_); return !token_.empty(); }
std::string RemoteSync::token() const { std::lock_guard<std::mutex> l(m_); return token_; }
std::string RemoteSync::pairError() const { std::lock_guard<std::mutex> l(m_); return pairError_; }

bool RemoteSync::snapshot(std::set<std::string>& library, std::set<std::string>& likes, std::string& username, unsigned& lastVersion) const {
    std::lock_guard<std::mutex> l(m_);
    if (lastVersion == version_) return false;
    library = library_;
    likes = likes_;
    username = username_;
    lastVersion = version_;
    return true;
}

bool RemoteSync::popRequest(Request& out) {
    std::lock_guard<std::mutex> l(m_);
    for (const auto& r : pending_) {
        if (handed_.count(r.queueId)) continue;
        handed_.insert(r.queueId);
        out = r;
        return true;
    }
    return false;
}

bool RemoteSync::takeRevoked() { return revoked_.exchange(false); }

void RemoteSync::ack(const std::string& queueId) {
    std::lock_guard<std::mutex> l(m_);
    jobs_.push_back(Job{1, queueId, "", 0});
}

void RemoteSync::setHeartbeat(const std::string& json) {
    std::lock_guard<std::mutex> l(m_);
    heartbeat_ = json;
}

void RemoteSync::reportLaunch(const std::string& titleId, const std::string& name) {
    const std::string tok = token();
    if (tok.empty()) return;
    const std::string body = "{\"state\":\"launch\",\"playing\":{\"title_id\":\"" + json::escape(titleId) + "\",\"name\":\"" + json::escape(name) + "\"}}";
    std::string resp, err;
    long code = http::request("POST", server_ + "/api/me/heartbeat", tok, body, resp, err, 4);
    platform::bootLogf("remote: jeu lance %s -> %ld", titleId.c_str(), code);
}

bool RemoteSync::popCommand(Command& out) {
    std::lock_guard<std::mutex> l(m_);
    for (const auto& c : commands_) {
        if (handedCmds_.count(c.id)) continue;
        handedCmds_.insert(c.id);
        out = c;
        return true;
    }
    return false;
}

bool RemoteSync::ackCommandNow(const std::string& id) {
    std::string resp, err;
    long code = http::request("POST", server_ + "/api/me/commands/" + id + "/ack", token(), "{}", resp, err, 5);
    platform::bootLogf("remote: ack commande %s -> %ld", id.c_str(), code);
    return code == 200;
}

void RemoteSync::ackCommand(const std::string& id) {
    std::lock_guard<std::mutex> l(m_);
    jobs_.push_back(Job{4, id, "", 0});
}

void RemoteSync::pair(const std::string& code, const std::string& consoleName) {
    if (pairState_.load() == PairState::Working) return;
    pairState_ = PairState::Working;
    std::lock_guard<std::mutex> l(m_);
    pairError_.clear();
    jobs_.push_back(Job{2, code, consoleName, 0});
}

bool RemoteSync::takePairResult(std::string& token, std::string& username) {
    if (pairState_.load() != PairState::Ok) return false;
    std::lock_guard<std::mutex> l(m_);
    token = pairToken_;
    username = pairUser_;
    pairToken_.clear();
    pairState_ = PairState::Idle;
    return !token.empty();
}

void RemoteSync::unlink() {
    std::string t = token();
    if (!t.empty()) { std::lock_guard<std::mutex> l(m_); jobs_.push_back(Job{3, t, "", 0}); }
    setToken("", "");
}

void RemoteSync::loop() {
    int slices = kSyncEverySlices, hb = 150;
    while (!quit_) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        if (quit_) break;
        if (http::suspended()) continue;

        std::vector<Job> jobs;
        { std::lock_guard<std::mutex> l(m_); jobs.swap(jobs_); }
        for (auto& j : jobs) {
            bool finished = true;
            runJob(j, finished);
            if (!finished) { std::lock_guard<std::mutex> l(m_); jobs_.push_back(j); }
        }

        if (kick_.exchange(false)) { slices = kSyncEverySlices; hb = 150; }

        if (++hb >= 150) {
            hb = 0;
            std::string json, tok;
            { std::lock_guard<std::mutex> l(m_); json = heartbeat_; tok = token_; }
            if (json.size() > 2 && json[0] == '{') {
                std::string active;
                if (platform::getForegroundTitleId(active)) json.insert(1, "\"active_title_id\":\"" + active + "\",");
            }
            if (!tok.empty() && !json.empty()) {
                std::string resp, herr;
                http::request("POST", server_ + "/api/me/heartbeat", tok, json, resp, herr, 10);
            }
        }
        if (++slices >= kSyncEverySlices) {
            slices = 0;
            if (!token().empty()) doSync();
        }
    }
}

void RemoteSync::doSync() {
    const std::string tok = token();
    std::string body, err;
    long code = http::request("GET", server_ + "/api/me/sync", tok, "", body, err, 12);
    if (code == 401) {
        platform::bootLog("remote: jeton refuse (401) : console dissociee");
        setToken("", "");
        revoked_ = true;
        return;
    }
    if (code != 200) return;

    json::Object top;
    if (!json::parseObject(body, top)) return;
    std::vector<std::string> lib = json::stringArrayField(body, "library"), lk = json::stringArrayField(body, "likes");
    std::vector<json::Object> objs, cmdObjs;
    json::objectArrayField(body, "pending", objs);
    json::objectArrayField(body, "commands", cmdObjs);
    std::vector<Command> cmds;
    for (auto& o : cmdObjs) {
        Command c;
        c.id = o["command_id"]; c.action = o["action"]; c.titleId = o["title_id"]; c.name = o["name"];
        if (!c.id.empty() && (c.action == "launch" || c.action == "uninstall") && !c.titleId.empty()) cmds.push_back(std::move(c));
    }

    std::vector<Request> pend;
    for (const auto& o : objs) {
        Request r;
        auto it = o.find("queue_id");
        if (it == o.end() || it->second.empty() || !gameFromObject(o, r.game)) continue;
        r.queueId = it->second;
        pend.push_back(std::move(r));
    }

    std::lock_guard<std::mutex> l(m_);
    if (token_ != tok) return;
    std::set<std::string> libSet(lib.begin(), lib.end()), lkSet(lk.begin(), lk.end());
    if (libSet != library_ || lkSet != likes_ || top["username"] != username_) {
        library_ = libSet;
        likes_ = lkSet;
        if (!top["username"].empty()) username_ = top["username"];
        ++version_;
    }
    std::set<std::string> still;
    for (const auto& r : pend) if (handed_.count(r.queueId)) still.insert(r.queueId);
    handed_ = still;
    pending_ = std::move(pend);
    std::set<std::string> stillCmds;
    for (const auto& c : cmds) if (handedCmds_.count(c.id)) stillCmds.insert(c.id);
    handedCmds_ = stillCmds;
    commands_ = std::move(cmds);
}

void RemoteSync::runJob(Job& j, bool& finished) {
    std::string body, err;
    if (j.kind == 1) {
        long code = http::request("POST", server_ + "/api/me/remote-queue/" + j.a + "/ack", token(), "{}", body, err, 12);
        platform::bootLogf("remote: ack %s -> %ld", j.a.c_str(), code);
        finished = code == 200 || code == 404 || code == 401 || ++j.tries >= 6;
    } else if (j.kind == 2) {
        const std::string payload = "{\"code\":\"" + json::escape(j.a) + "\",\"console_name\":\"" + json::escape(j.b) + "\"}";
        long code = http::request("POST", server_ + "/api/pair/verify", "", payload, body, err, 15);
        json::Object o;
        const bool parsed = !body.empty() && json::parseObject(body, o);
        platform::bootLogf("remote: appairage -> %ld", code);
        if (code == 200 && parsed && o["ok"] == "true" && !o["device_token"].empty()) {
            { std::lock_guard<std::mutex> l(m_); pairToken_ = o["device_token"]; pairUser_ = o["username"]; }
            pairState_ = PairState::Ok;
        } else {
            std::string why = parsed && !o["erreur"].empty() ? o["erreur"] : (!err.empty() ? err : "HTTP " + std::to_string(code));
            { std::lock_guard<std::mutex> l(m_); pairError_ = why; }
            pairState_ = PairState::Failed;
        }
    } else if (j.kind == 4) {
        long code = http::request("POST", server_ + "/api/me/commands/" + j.a + "/ack", token(), "{}", body, err, 12);
        finished = code == 200 || code == 404 || code == 401 || ++j.tries >= 6;
    } else if (j.kind == 3) {
        http::request("POST", server_ + "/api/me/unlink", j.a, "{}", body, err, 10);
    }
}
