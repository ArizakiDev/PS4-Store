#pragma once
#include <atomic>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "catalog.h"

class RemoteSync {
public:
    struct Request { std::string queueId; Game game; };
    struct Command { std::string id, action, titleId, name; };
    enum class PairState { Idle, Working, Ok, Failed };

    explicit RemoteSync(std::string serverUrl) : server_(std::move(serverUrl)) {}
    ~RemoteSync();

    void start();
    void kick() { kick_ = true; }

    void setToken(const std::string& token, const std::string& username);
    bool paired() const;
    std::string bearer() const { return token(); }

    bool snapshot(std::set<std::string>& library, std::set<std::string>& likes, std::string& username, unsigned& lastVersion) const;
    bool popRequest(Request& out);
    void ack(const std::string& queueId);
    bool takeRevoked();

    void pair(const std::string& code, const std::string& consoleName);
    PairState pairState() const { return pairState_.load(); }
    std::string pairError() const;
    bool takePairResult(std::string& token, std::string& username);

    void setHeartbeat(const std::string& json);
    void reportLaunch(const std::string& titleId, const std::string& name);

    bool popCommand(Command& out);
    bool ackCommandNow(const std::string& id);
    void ackCommand(const std::string& id);

    void unlink();

private:
    struct Job { int kind = 0; std::string a, b; int tries = 0; };
    void loop();
    void doSync();
    void runJob(Job& j, bool& finished);
    std::string token() const;

    std::string server_;
    std::thread th_;
    std::atomic<bool> quit_{false}, kick_{true}, revoked_{false};
    std::atomic<PairState> pairState_{PairState::Idle};
    mutable std::mutex m_;
    std::string token_, username_, pairError_, pairToken_, pairUser_;
    std::set<std::string> library_, likes_, handed_;
    std::vector<Request> pending_;
    std::vector<Command> commands_;
    std::set<std::string> handedCmds_;
    std::string heartbeat_;
    std::atomic<bool> hbNow_{true};
    std::vector<Job> jobs_;
    unsigned version_ = 0;
};
