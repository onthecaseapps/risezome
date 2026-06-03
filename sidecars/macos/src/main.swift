/*
 * risezome-sidecar-macos
 *
 * Captures 16 kHz mono Int16LE PCM from a local CoreAudio input device and
 * emits framed audio to stdout per the U3 wire protocol (identical to the
 * Linux sidecar):
 *
 *   stdout per 20 ms frame (640 bytes of PCM): [role tag u8][len u32 BE][PCM bytes]
 *   stderr: newline-delimited JSON control messages
 *   stdin:  first line is `{"type":"nonce","nonce":"<hex>"}`; subsequent lines
 *           are tolerated but ignored — the daemon kills via SIGTERM.
 *
 * macOS has no built-in system-audio monitor source (unlike PulseAudio on
 * Linux), so `--role=system` captures a loopback INPUT device. Install one
 * once with `brew install blackhole-2ch` and route system output to it (see
 * ../README.md). The sidecar auto-selects a device whose name contains
 * "BlackHole" for the system role; `--role=mic` uses the default input.
 * Pass `--device="<name substring>"` to override.
 *
 * Build: see ../Makefile (swiftc against system frameworks; no deps).
 */

import Foundation
import AVFoundation
import CoreAudio
import AudioToolbox

// ── Constants (must match the U3 wire protocol / the Linux sidecar) ──────────
let kVersion = "0.1.0-macos"
let kSampleRate: Double = 16000
let kFrameSamples = 320            // 20 ms @ 16 kHz
let kRoleSystem: UInt8 = 0x00
let kRoleMic: UInt8 = 0x01

// ── Control-message emission (NDJSON on stderr) ──────────────────────────────
let stderrHandle = FileHandle.standardError
func emitControl(_ json: String) {
    if let data = (json + "\n").data(using: .utf8) {
        try? stderrHandle.write(contentsOf: data)
    }
}
func jsonEscape(_ s: String) -> String {
    var out = ""
    for c in s {
        switch c {
        case "\\": out += "\\\\"
        case "\"": out += "\\\""
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default: out.append(c)
        }
    }
    return out
}
func emitHello(_ nonceEcho: String) {
    emitControl("{\"type\":\"hello\",\"sidecarVersion\":\"\(kVersion)\",\"nonceEcho\":\"\(jsonEscape(nonceEcho))\"}")
}
func emitStarted(_ device: String) {
    emitControl("{\"type\":\"started\",\"device\":\"\(jsonEscape(device))\",\"sampleRate\":\(Int(kSampleRate))}")
}
func emitPermissionDenied(_ reason: String) {
    emitControl("{\"type\":\"permission-denied\",\"reason\":\"\(jsonEscape(reason))\"}")
}
func emitError(_ code: String, _ message: String) {
    emitControl("{\"type\":\"error\",\"code\":\"\(jsonEscape(code))\",\"message\":\"\(jsonEscape(message))\"}")
}
func emitStopped() {
    emitControl("{\"type\":\"stopped\"}")
}

// ── Framed PCM writer (stdout) ───────────────────────────────────────────────
let stdoutHandle = FileHandle.standardOutput
var stdoutBroken = false

/// Write one 20 ms frame: [role u8][len u32 BE][PCM int16 LE bytes].
func writeFrame(role: UInt8, samples: ArraySlice<Int16>) {
    if stdoutBroken { return }
    let payloadBytes = UInt32(samples.count * MemoryLayout<Int16>.size)
    var header = Data(capacity: 5)
    header.append(role)
    header.append(UInt8((payloadBytes >> 24) & 0xff))
    header.append(UInt8((payloadBytes >> 16) & 0xff))
    header.append(UInt8((payloadBytes >> 8) & 0xff))
    header.append(UInt8(payloadBytes & 0xff))
    // Int16 is little-endian on all Apple platforms, so the in-memory bytes are
    // already Int16LE.
    let pcm = Array(samples).withUnsafeBytes { Data($0) }
    do {
        try stdoutHandle.write(contentsOf: header)
        try stdoutHandle.write(contentsOf: pcm)
    } catch {
        // Parent closed stdout — stop quietly (mirrors the Linux SIGPIPE path).
        stdoutBroken = true
        requestStop()
    }
}

// ── CoreAudio device lookup ──────────────────────────────────────────────────
func defaultInputDeviceID() -> AudioDeviceID? {
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
    return status == noErr && id != 0 ? id : nil
}

func deviceName(_ id: AudioDeviceID) -> String {
    var name: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioObjectPropertyName,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    let status = AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &name)
    return status == noErr ? (name as String) : ""
}

/// True when the device exposes at least one input stream.
func deviceHasInput(_ id: AudioDeviceID) -> Bool {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreams,
        mScope: kAudioDevicePropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    let status = AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size)
    return status == noErr && size > 0
}

func allDevices() -> [AudioDeviceID] {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else {
        return []
    }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else {
        return []
    }
    return ids
}

/// First input-capable device whose name contains `substr` (case-insensitive).
func findInputDevice(nameContains substr: String) -> AudioDeviceID? {
    let needle = substr.lowercased()
    for id in allDevices() where deviceHasInput(id) {
        if deviceName(id).lowercased().contains(needle) { return id }
    }
    return nil
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
let stopSemaphore = DispatchSemaphore(value: 0)
var stopRequested = false
let stopLock = NSLock()
func requestStop() {
    stopLock.lock()
    let first = !stopRequested
    stopRequested = true
    stopLock.unlock()
    if first { stopSemaphore.signal() }
}

// ── Argument parsing ─────────────────────────────────────────────────────────
var roleArg = "system"
var deviceArg: String? = nil
do {
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let a = it.next() {
        if a == "--role", let v = it.next() { roleArg = v }
        else if a.hasPrefix("--role=") { roleArg = String(a.dropFirst("--role=".count)) }
        else if a == "--device", let v = it.next() { deviceArg = v }
        else if a.hasPrefix("--device=") { deviceArg = String(a.dropFirst("--device=".count)) }
        else if a == "--help" || a == "-h" {
            FileHandle.standardOutput.write(Data("""
            Usage: risezome-sidecar-macos [--role=system|mic] [--device="NAME substring"]

            Reads {"type":"nonce","nonce":"<hex>"} from stdin, echoes a hello on
            stderr, then streams 16 kHz mono Int16LE PCM frames on stdout per the
            U3 wire protocol. system role captures a loopback input (BlackHole);
            mic role captures the default input.

            """.utf8))
            exit(0)
        }
    }
}

let roleTag: UInt8
switch roleArg {
case "system": roleTag = kRoleSystem
case "mic": roleTag = kRoleMic
default:
    FileHandle.standardError.write(Data("Unknown role: \(roleArg)\n".utf8))
    exit(2)
}

// ── Step 1: read the launch nonce, echo hello (fast — before audio init). ────
func readNonce() -> String? {
    guard let line = readLine(strippingNewline: true), let data = line.data(using: .utf8) else { return nil }
    guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return obj["nonce"] as? String
}
guard let nonce = readNonce() else {
    emitError("bad-nonce", "could not parse nonce from stdin")
    exit(1)
}
emitHello(nonce)

// ── Step 2: microphone/input authorization (TCC). ────────────────────────────
// A loopback device (BlackHole) is still an input device, so the audio-capture
// permission applies to both roles. For a spawned CLI helper the prompt may not
// surface; the user grants the parent process (Terminal/node) input access in
// System Settings → Privacy & Security → Microphone. See ../README.md.
do {
    let sem = DispatchSemaphore(value: 0)
    var granted = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
        AVCaptureDevice.requestAccess(for: .audio) { ok in granted = ok; sem.signal() }
        sem.wait()
    }
    if !granted {
        emitPermissionDenied("microphone/input access not granted (System Settings → Privacy & Security → Microphone)")
        exit(1)
    }
}

// ── Step 3: resolve the capture device. ──────────────────────────────────────
var targetDevice: AudioDeviceID? = nil
var resolvedName = "default"
if let want = deviceArg, !want.isEmpty {
    targetDevice = findInputDevice(nameContains: want)
    if targetDevice == nil {
        emitError("device-not-found", "no input device matching \"\(want)\"")
        exit(1)
    }
    resolvedName = deviceName(targetDevice!)
} else if roleTag == kRoleSystem {
    // Default the system role to a BlackHole loopback input.
    if let bh = findInputDevice(nameContains: "BlackHole") {
        targetDevice = bh
        resolvedName = deviceName(bh)
    } else {
        emitError("no-loopback",
                  "no loopback input found for --role=system. Install one (brew install blackhole-2ch) and route output to it, or pass --device. See README.")
        exit(1)
    }
} else {
    // mic role → default input.
    targetDevice = defaultInputDeviceID()
    resolvedName = targetDevice.map(deviceName) ?? "default"
}

// ── Step 4: AVAudioEngine capture → 16 kHz mono Int16 → framed stdout. ────────
let engine = AVAudioEngine()
let input = engine.inputNode

// Point the engine's input AudioUnit at the chosen device.
if let dev = targetDevice, let au = input.audioUnit {
    var devID = dev
    let st = AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice,
                                  kAudioUnitScope_Global, 0, &devID,
                                  UInt32(MemoryLayout<AudioDeviceID>.size))
    if st != noErr {
        emitError("device-select-failed", "AudioUnitSetProperty CurrentDevice returned \(st)")
        exit(1)
    }
}

let inputFormat = input.inputFormat(forBus: 0)
guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
    emitError("no-input-format", "input device reported an invalid format (sampleRate=\(inputFormat.sampleRate))")
    exit(1)
}
guard let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                       sampleRate: kSampleRate, channels: 1, interleaved: true),
      let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
    emitError("converter-init-failed", "could not build a 16 kHz mono Int16 converter from the input format")
    exit(1)
}

// 320-sample framing accumulator. The tap runs on a single AVAudioEngine audio
// thread, so no locking is needed around the buffer.
var pending: [Int16] = []
pending.reserveCapacity(kFrameSamples * 8)

input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { (buf, _) in
    let ratio = kSampleRate / inputFormat.sampleRate
    let capacity = AVAudioFrameCount(Double(buf.frameLength) * ratio) + 64
    guard capacity > 0,
          let outBuf = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
    var fed = false
    var convErr: NSError?
    let status = converter.convert(to: outBuf, error: &convErr) { _, inStatus in
        if fed { inStatus.pointee = .noDataNow; return nil }
        fed = true
        inStatus.pointee = .haveData
        return buf
    }
    if status == .error || outBuf.frameLength == 0 { return }
    guard let ch = outBuf.int16ChannelData else { return }
    let n = Int(outBuf.frameLength)
    pending.append(contentsOf: UnsafeBufferPointer(start: ch[0], count: n))
    var offset = 0
    while pending.count - offset >= kFrameSamples {
        writeFrame(role: roleTag, samples: pending[offset ..< offset + kFrameSamples])
        offset += kFrameSamples
    }
    if offset > 0 { pending.removeFirst(offset) }
}

do {
    engine.prepare()
    try engine.start()
} catch {
    emitError("engine-start-failed", error.localizedDescription)
    exit(1)
}
emitStarted(resolvedName)

// ── Step 5: wait for a stop signal, then shut down cleanly. ──────────────────
var signalSources: [DispatchSourceSignal] = []
func installSignal(_ sig: Int32) {
    signal(sig, SIG_IGN) // let the DispatchSource own delivery, not the default handler
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .global())
    src.setEventHandler { requestStop() }
    src.resume()
    signalSources.append(src)
}
installSignal(SIGTERM)
installSignal(SIGINT)

stopSemaphore.wait()
input.removeTap(onBus: 0)
engine.stop()
emitStopped()
exit(0)
