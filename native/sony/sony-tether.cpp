// sony-tether: a small helper that talks to a Sony camera over USB using
// Sony's Camera Remote SDK, and saves each frame shot into a folder on this
// computer. The Wrangle app starts it, reads one JSON object per line
// from its output, and sends it plain-text commands on its input.
//
//   sony-tether --save-dir <folder>    run until "quit" or the input closes
//   sony-tether --probe                load the SDK, list cameras, exit
//
// Output events:
//   {"event":"ready"}
//   {"event":"searching"}
//   {"event":"connecting","model":"ILCE-7M4","id":"..."}
//   {"event":"connected","model":"ILCE-7M4","id":"..."}
//   {"event":"file","path":"/.../DSC00012.ARW"}
//   {"event":"props","props":[{"code":256,"type":2,"value":560,"writable":true,"values":[...]}]}
//       camera settings (aperture, shutter, ...), sent when they change
//   {"event":"disconnected","model":"ILCE-7M4"}
//   {"event":"warning","message":"..."}
//   {"event":"error","message":"..."}
// Input commands:
//   shoot [holdMs] [count] [gapMs]   press the shutter (held for holdMs,
//                                    count times, gapMs apart)
//   set <code> <value>               change a camera setting
//   refresh                          send all camera settings again
//   quit

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>

#include "CameraRemote_SDK.h"
#include "CrDeviceProperty.h"
#include "IDeviceCallback.h"

namespace SDK = SCRSDK;
using namespace std::chrono_literals;

// ---------------------------------------------------------------- output

static std::mutex g_outMutex;

static std::string jsonEscape(const std::string& s)
{
    std::string out;
    for (unsigned char c : s) {
        switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (c < 0x20) {
                char buf[8];
                std::snprintf(buf, sizeof buf, "\\u%04x", c);
                out += buf;
            } else {
                out += static_cast<char>(c);
            }
        }
    }
    return out;
}

static void emit(const std::string& event, const std::string& fields = "")
{
    std::lock_guard<std::mutex> lock(g_outMutex);
    std::cout << "{\"event\":\"" << event << "\"" << fields << "}" << std::endl;
}

static std::string field(const char* name, const std::string& value)
{
    return std::string(",\"") + name + "\":\"" + jsonEscape(value) + "\"";
}

static std::string hexError(SDK::CrError err)
{
    char buf[16];
    std::snprintf(buf, sizeof buf, "0x%04x", static_cast<unsigned>(err));
    return buf;
}

// ---------------------------------------------------------------- camera state

enum class Link { Idle, Connecting, Connected, Failed, Lost };

static std::mutex g_stateMutex;
static std::condition_variable g_stateChanged;
static Link g_link = Link::Idle;
static std::atomic<bool> g_quit{false};
static std::atomic<bool> g_propsDirty{false};

// Commands from the app, run on the camera thread one at a time.
struct Command {
    enum Kind { Shoot, Set, Refresh } kind;
    long a = 0, b = 0, c = 0;
};
static std::mutex g_cmdMutex;
static std::deque<Command> g_commands;
static std::string g_saveDir;
static std::string g_model;

static void setLink(Link next)
{
    {
        std::lock_guard<std::mutex> lock(g_stateMutex);
        g_link = next;
    }
    g_stateChanged.notify_all();
}

class Callback : public SDK::IDeviceCallback
{
public:
    void OnConnected(SDK::DeviceConnectionVersioin) override { setLink(Link::Connected); }

    void OnDisconnected(CrInt32u) override { setLink(Link::Lost); }

    // Called on Sony's thread: just note it, the camera thread re-reads.
    void OnPropertyChanged() override { markDirty(); }
    void OnPropertyChangedCodes(CrInt32u, CrInt32u*) override { markDirty(); }

    static void markDirty()
    {
        g_propsDirty = true;
        g_stateChanged.notify_all();
    }

    void OnError(CrInt32u error) override
    {
        emit("error", field("message", "Camera connection error " + hexError(error)));
        setLink(Link::Failed);
    }

    void OnWarning(CrInt32u warning) override
    {
        if (warning == SDK::CrWarning_Connect_Reconnecting) {
            emit("warning", field("message", "Reconnecting to the camera"));
        }
    }

    void OnCompleteDownload(CrChar* filename, CrInt32u) override
    {
        std::string path = filename ? std::string(filename) : std::string();
        if (!path.empty() && path[0] != '/') path = g_saveDir + "/" + path;
        emit("file", field("path", path));
    }
};

// ---------------------------------------------------------------- helpers

static bool setProperty(SDK::CrDeviceHandle handle, CrInt32u code, std::uint64_t value, SDK::CrDataType type)
{
    SDK::CrDeviceProperty prop;
    prop.SetCode(code);
    prop.SetCurrentValue(value);
    prop.SetValueType(type);
    return SDK::SetDeviceProperty(handle, &prop) == SDK::CrError_None;
}

static std::string objModel(const SDK::ICrCameraObjectInfo* info)
{
    return info->GetModel() ? std::string(info->GetModel()) : std::string("Sony camera");
}

static std::string objId(const SDK::ICrCameraObjectInfo* info)
{
    const CrInt8u* id = info->GetId();
    if (!id) return "";
    return std::string(reinterpret_cast<const char*>(id), strnlen(reinterpret_cast<const char*>(id), info->GetIdSize()));
}

static bool isUsb(const SDK::ICrCameraObjectInfo* info)
{
    const CrChar* type = info->GetConnectionTypeName();
    return type && std::string(type) == "USB";
}

// Half-press to focus, then release. If the camera can't focus (manual
// focus, or nothing to lock on) it still fires after a short wait. A
// bracket shot holds the button down, or presses it once per frame.
static void shoot(SDK::CrDeviceHandle handle, long holdMs, long count, long gapMs)
{
    if (holdMs < 35) holdMs = 35;
    if (holdMs > 60000) holdMs = 60000;
    if (count < 1) count = 1;
    if (count > 9) count = 9;
    if (gapMs < 0) gapMs = 0;
    if (gapMs > 60000) gapMs = 60000;
    for (long i = 0; i < count && !g_quit.load(); ++i) {
        if (i > 0) std::this_thread::sleep_for(std::chrono::milliseconds(gapMs));
        setProperty(handle, SDK::CrDeviceProperty_S1, SDK::CrLockIndicator_Locked, SDK::CrDataType_UInt16);
        std::this_thread::sleep_for(i == 0 ? 500ms : 150ms);
        SDK::SendCommand(handle, SDK::CrCommandId_Release, SDK::CrCommandParam_Down);
        std::this_thread::sleep_for(std::chrono::milliseconds(holdMs));
        SDK::SendCommand(handle, SDK::CrCommandId_Release, SDK::CrCommandParam_Up);
        setProperty(handle, SDK::CrDeviceProperty_S1, SDK::CrLockIndicator_Unlocked, SDK::CrDataType_UInt16);
    }
}

// ---------------------------------------------------------------- settings

// The settings shown in the app. The camera reports which of them it has.
static CrInt32u kControlCodes[] = {
    SDK::CrDeviceProperty_ExposureProgramMode,
    SDK::CrDeviceProperty_FNumber,
    SDK::CrDeviceProperty_ShutterSpeed,
    SDK::CrDeviceProperty_IsoSensitivity,
    SDK::CrDeviceProperty_ExposureBiasCompensation,
    SDK::CrDeviceProperty_WhiteBalance,
    SDK::CrDeviceProperty_Colortemp,
    SDK::CrDeviceProperty_FocusMode,
    SDK::CrDeviceProperty_DriveMode,
    SDK::CrDeviceProperty_BracketOrder,
    SDK::CrDeviceProperty_BatteryRemain,
    SDK::CrDeviceProperty_MediaSLOT1_RemainingNumber,
};

static std::map<CrInt32u, std::string> g_sentProps;   // last JSON sent per code
static std::map<CrInt32u, SDK::CrDataType> g_propTypes;

static int valueBytes(SDK::CrDataType type)
{
    switch (type & 0x0F) {
    case 1: return 1;
    case 2: return 2;
    case 3: return 4;
    case 4: return 8;
    default: return 0;
    }
}

static long long readValue(const CrInt8u* p, int bytes, bool isSigned)
{
    std::uint64_t u = 0;
    std::memcpy(&u, p, bytes);  // the SDK and both Mac CPUs are little-endian
    if (isSigned && bytes < 8) {
        std::uint64_t sign = 1ULL << (bytes * 8 - 1);
        if (u & sign) u |= ~((sign << 1) - 1);
    }
    return static_cast<long long>(u);
}

static long long signExtend(std::uint64_t u, SDK::CrDataType type)
{
    int bytes = valueBytes(type);
    if (!bytes) return static_cast<long long>(u);
    if (bytes < 8) u &= (1ULL << (bytes * 8)) - 1;
    if ((type & SDK::CrDataType_SignBit) && bytes < 8) {
        std::uint64_t sign = 1ULL << (bytes * 8 - 1);
        if (u & sign) u |= ~((sign << 1) - 1);
    }
    return static_cast<long long>(u);
}

static std::string propJson(const SDK::CrDeviceProperty& p)
{
    SDK::CrDataType type = p.GetValueType();
    int bytes = valueBytes(type);
    bool isSigned = (type & SDK::CrDataType_SignBit) != 0;
    std::ostringstream o;
    o << "{\"code\":" << p.GetCode() << ",\"type\":" << static_cast<unsigned>(type)
      << ",\"value\":" << signExtend(p.GetCurrentValue(), type)
      << ",\"writable\":" << (p.IsSetEnableCurrentValue() ? "true" : "false")
      << ",\"values\":[";
    // Prefer the list of values that can be set, when the camera gives one.
    const CrInt8u* data = p.GetSetValueSize() ? p.GetSetValues() : p.GetValues();
    CrInt32u size = p.GetSetValueSize() ? p.GetSetValueSize() : p.GetValueSize();
    if (bytes && data) {
        for (CrInt32u i = 0; i + bytes <= size; i += bytes) {
            o << (i ? "," : "") << readValue(data + i, bytes, isSigned);
        }
    }
    o << "]}";
    return o.str();
}

// Reads the settings and sends the ones that changed (or all of them).
static void sendProps(SDK::CrDeviceHandle handle, bool all)
{
    SDK::CrDeviceProperty* props = nullptr;
    CrInt32 count = 0;
    CrInt32u n = sizeof kControlCodes / sizeof kControlCodes[0];
    SDK::CrError err = SDK::GetSelectDeviceProperties(handle, n, kControlCodes, &props, &count);
    if (err != SDK::CrError_None || !props) return;
    std::string changed;
    for (CrInt32 i = 0; i < count; ++i) {
        const SDK::CrDeviceProperty& p = props[i];
        if (p.GetPropertyEnableFlag() == SDK::CrEnableValue_NotSupported) continue;
        std::string json = propJson(p);
        g_propTypes[p.GetCode()] = p.GetValueType();
        if (!all && g_sentProps[p.GetCode()] == json) continue;
        g_sentProps[p.GetCode()] = json;
        changed += (changed.empty() ? "" : ",") + json;
    }
    SDK::ReleaseDeviceProperties(handle, props);
    if (!changed.empty()) emit("props", ",\"props\":[" + changed + "]");
}

static void setControl(SDK::CrDeviceHandle handle, CrInt32u code, long long value)
{
    bool known = false;
    for (CrInt32u c : kControlCodes) known = known || c == code;
    auto type = g_propTypes.find(code);
    if (!known || type == g_propTypes.end()) return;
    // Negative values (exposure comp) go over as the type's own width.
    std::uint64_t raw = static_cast<std::uint64_t>(value);
    int bytes = valueBytes(type->second);
    if (bytes && bytes < 8) raw &= (1ULL << (bytes * 8)) - 1;
    if (!setProperty(handle, code, raw, type->second)) {
        emit("warning", field("message", "The camera didn't accept that setting. It may be locked by the mode dial, or need changing on the camera."));
        sendProps(handle, true);  // put the app back in step with the camera
    }
}

// ---------------------------------------------------------------- session

// Connects to the first USB camera found and stays with it until it's
// unplugged or the app quits. Returns when the link is gone.
static void runConnection(SDK::ICrCameraObjectInfo* info)
{
    Callback callback;
    SDK::CrDeviceHandle handle = 0;
    g_model = objModel(info);
    const std::string id = objId(info);

    emit("connecting", field("model", g_model) + field("id", id));
    setLink(Link::Connecting);
    SDK::CrError err = SDK::Connect(info, &callback, &handle, SDK::CrSdkControlMode_Remote, SDK::CrReconnecting_ON);
    if (err != SDK::CrError_None) {
        emit("error", field("message", "Could not connect to " + g_model + " (" + hexError(err) + "). Check the camera is set to PC Remote and no other program (Capture One, Imaging Edge) is using it."));
        return;
    }

    {
        std::unique_lock<std::mutex> lock(g_stateMutex);
        g_stateChanged.wait_for(lock, 15s, [] { return g_link != Link::Connecting || g_quit.load(); });
        if (g_link != Link::Connected) {
            lock.unlock();
            if (g_link == Link::Connecting) emit("error", field("message", "The camera didn't answer. Turn it off and on, and check it is set to PC Remote."));
            SDK::Disconnect(handle);
            SDK::ReleaseDevice(handle);
            return;
        }
    }

    // Frames go to this computer and to the camera's card, so the card is a
    // second copy if anything goes wrong on the way over.
    std::string dir = g_saveDir;
    err = SDK::SetSaveInfo(handle, const_cast<CrChar*>(dir.c_str()), const_cast<CrChar*>("DSC"), -1);
    if (err != SDK::CrError_None) emit("warning", field("message", "Could not set the save folder (" + hexError(err) + ")"));
    if (!setProperty(handle, SDK::CrDeviceProperty_StillImageStoreDestination, SDK::CrStillImageStoreDestination_HostPCAndMemoryCard, SDK::CrDataType_UInt16)) {
        emit("warning", field("message", "Could not set the camera to save to both computer and card. Check Still Img. Save Dest. on the camera."));
    }
    // Full-size files, and only the RAW when the camera shoots RAW+JPEG.
    setProperty(handle, SDK::CrDeviceProperty_Still_Image_Trans_Size, SDK::CrPropertyStillImageTransSize_Original, SDK::CrDataType_UInt16);
    setProperty(handle, SDK::CrDeviceProperty_RAW_J_PC_Save_Image, SDK::CrPropertyRAWJPCSaveImage_RAWOnly, SDK::CrDataType_UInt16);
    // Let this computer change exposure settings, not just the camera's dials.
    setProperty(handle, SDK::CrDeviceProperty_PriorityKeySettings, SDK::CrPriorityKey_PCRemote, SDK::CrDataType_UInt16);

    emit("connected", field("model", g_model) + field("id", id));
    {
        // Don't fire a shot someone asked for before the camera was ready.
        std::lock_guard<std::mutex> lock(g_cmdMutex);
        g_commands.clear();
    }
    g_sentProps.clear();
    g_propTypes.clear();
    std::this_thread::sleep_for(300ms);
    sendProps(handle, true);
    auto lastPoll = std::chrono::steady_clock::now();

    while (!g_quit.load()) {
        {
            std::unique_lock<std::mutex> lock(g_stateMutex);
            g_stateChanged.wait_for(lock, 200ms);
            if (g_link == Link::Lost || g_link == Link::Failed) break;
        }
        std::deque<Command> todo;
        {
            std::lock_guard<std::mutex> lock(g_cmdMutex);
            todo.swap(g_commands);
        }
        for (const Command& cmd : todo) {
            if (cmd.kind == Command::Shoot) shoot(handle, cmd.a, cmd.b, cmd.c);
            else if (cmd.kind == Command::Set) setControl(handle, static_cast<CrInt32u>(cmd.a), cmd.b);
            else if (cmd.kind == Command::Refresh) sendProps(handle, true);
        }
        // Settings changed on the camera (or by us), plus a slow check for
        // things the camera doesn't announce, like battery and shots left.
        auto now = std::chrono::steady_clock::now();
        if (g_propsDirty.exchange(false) || now - lastPoll > 3s) {
            lastPoll = now;
            sendProps(handle, false);
        }
    }

    emit("disconnected", field("model", g_model));
    SDK::Disconnect(handle);
    std::this_thread::sleep_for(300ms);
    SDK::ReleaseDevice(handle);
    setLink(Link::Idle);
}

static void readCommands()
{
    std::string line;
    while (std::getline(std::cin, line)) {
        std::istringstream in(line);
        std::string word;
        in >> word;
        if (word == "quit") break;
        Command cmd{Command::Refresh};
        if (word == "shoot") {
            cmd.kind = Command::Shoot;
            cmd.a = 35;
            cmd.b = 1;
            in >> cmd.a >> cmd.b >> cmd.c;  // all optional
        } else if (word == "set") {
            cmd.kind = Command::Set;
            long long code = 0, value = 0;
            if (!(in >> code >> value)) continue;
            cmd.a = static_cast<long>(code);
            cmd.b = static_cast<long>(value);
        } else if (word != "refresh") {
            continue;
        }
        {
            std::lock_guard<std::mutex> lock(g_cmdMutex);
            g_commands.push_back(cmd);
        }
        g_stateChanged.notify_all();
    }
    g_quit = true;
    g_stateChanged.notify_all();
}

static int probe()
{
    SDK::ICrEnumCameraObjectInfo* list = nullptr;
    SDK::CrError err = SDK::EnumCameraObjects(&list, 1);
    std::ostringstream cams;
    int n = 0;
    if (err == SDK::CrError_None && list) {
        for (CrInt32u i = 0; i < list->GetCount(); ++i) {
            const auto* info = list->GetCameraObjectInfo(i);
            cams << (n++ ? "," : "") << "\"" << jsonEscape(objModel(info)) << "\"";
        }
        list->Release();
    }
    emit("probe", ",\"cameras\":[" + cams.str() + "]");
    return 0;
}

int main(int argc, char** argv)
{
    bool probeOnly = false;
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--probe") probeOnly = true;
        else if (arg == "--save-dir" && i + 1 < argc) g_saveDir = argv[++i];
    }
    if (!probeOnly && g_saveDir.empty()) {
        std::cerr << "usage: sony-tether --save-dir <folder> | --probe\n";
        return 2;
    }

    if (!SDK::Init()) {
        emit("error", field("message", "Sony's camera software could not start"));
        return 1;
    }
    if (probeOnly) {
        int rc = probe();
        SDK::Release();
        return rc;
    }

    emit("ready");
    std::thread input(readCommands);

    bool announced = false;
    while (!g_quit.load()) {
        if (!announced) {
            emit("searching");
            announced = true;
        }
        SDK::ICrEnumCameraObjectInfo* list = nullptr;
        SDK::CrError err = SDK::EnumCameraObjects(&list, 1);
        SDK::ICrCameraObjectInfo* chosen = nullptr;
        if (err == SDK::CrError_None && list) {
            for (CrInt32u i = 0; i < list->GetCount() && !chosen; ++i) {
                auto* info = const_cast<SDK::ICrCameraObjectInfo*>(list->GetCameraObjectInfo(i));
                if (isUsb(info)) chosen = info;
            }
        }
        if (chosen) {
            runConnection(chosen);
            announced = false;
        }
        if (list) list->Release();
        // Give the camera a moment between attempts.
        for (int i = 0; i < 10 && !g_quit.load(); ++i) std::this_thread::sleep_for(200ms);
    }

    SDK::Release();
    if (input.joinable()) input.detach();
    return 0;
}
