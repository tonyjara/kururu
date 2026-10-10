// The talk key, heard in every application.
//
// The window's own key handler sees a key only while the window is focused,
// and talking to Kuru from wherever you happen to be is the whole point of a
// voice. So this small program sits beside the app, opens a session-level
// event tap and tells the app, one JSON line at a time, when the talk key
// goes down and comes up. It decides nothing else: whether a press was a
// tap or a hold, what Escape means, when a clip is sent — all of that is
// `web/src/voice.ts`, written once, and this feeds it.
//
// Listen-only, on purpose. A tap that may swallow or change events needs
// Accessibility; one that only listens needs Input Monitoring, and that is
// the only thing this asks for. The cost is that Escape, pressed to drop a
// clip, also reaches the application in front — which is what Escape does.
//
// A process rather than a native module in the app, for the reason Kokoro
// is: it can be started and stopped without the app noticing anything but a
// closed pipe, and a crash in here costs a key, not a window. It reads
// nothing from stdin except its end, which is how it learns the app has
// gone and leaves with it.
//
//   talkkey ControlRight          hook the right Control key
//   talkkey ControlRight --check  say which keycode that is and exit
//
// Lines out: {"ev":"ready"} once the tap is up; {"ev":"denied"} when Input
// Monitoring is refused (and it keeps asking every few seconds, and says
// ready when it is granted); {"ev":"unsupported"} for a key with no
// keycode here; then {"ev":"down"}, {"ev":"up"}, {"ev":"escape"} and
// {"ev":"chord"} — another key pressed while the talk key is held, which is
// a shortcut for the application in front and not a word for Kuru.

import Foundation
import CoreGraphics

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ ev: String, _ extra: [String: Any] = [:]) {
    var line: [String: Any] = ["ev": ev]
    for (key, value) in extra { line[key] = value }
    if let data = try? JSONSerialization.data(withJSONObject: line),
       let text = String(data: data, encoding: .utf8) {
        print(text)
    }
}

/// A `KeyboardEvent.code`, as `shared/voice.ts` stores the talk key, to a
/// macOS virtual keycode — and, for a modifier, the device-specific bit in
/// the event flags that says whether *that* one of the pair is down, since
/// the left and right keys share the plain mask and the whole point is one
/// of them. The bits are `NX_DEVICE*KEYMASK` from IOKit's event headers.
struct Key {
    let code: Int64
    let deviceMask: UInt64?
}

let modifiers: [String: Key] = [
    "ControlLeft": Key(code: 0x3B, deviceMask: 0x0001),
    "ShiftLeft": Key(code: 0x38, deviceMask: 0x0002),
    "ShiftRight": Key(code: 0x3C, deviceMask: 0x0004),
    "MetaLeft": Key(code: 0x37, deviceMask: 0x0008),
    "MetaRight": Key(code: 0x36, deviceMask: 0x0010),
    "AltLeft": Key(code: 0x3A, deviceMask: 0x0020),
    "AltRight": Key(code: 0x3D, deviceMask: 0x0040),
    "ControlRight": Key(code: 0x3E, deviceMask: 0x2000),
]

let plain: [String: Int64] = [
    "Space": 0x31, "Backquote": 0x32,
    "F1": 0x7A, "F2": 0x78, "F3": 0x63, "F4": 0x76, "F5": 0x60, "F6": 0x61,
    "F7": 0x62, "F8": 0x64, "F9": 0x65, "F10": 0x6D, "F11": 0x67, "F12": 0x6F,
    "F13": 0x69, "F14": 0x6B, "F15": 0x71, "F16": 0x6A, "F17": 0x40, "F18": 0x4F, "F19": 0x50,
    "KeyA": 0x00, "KeyS": 0x01, "KeyD": 0x02, "KeyF": 0x03, "KeyH": 0x04, "KeyG": 0x05,
    "KeyZ": 0x06, "KeyX": 0x07, "KeyC": 0x08, "KeyV": 0x09, "KeyB": 0x0B, "KeyQ": 0x0C,
    "KeyW": 0x0D, "KeyE": 0x0E, "KeyR": 0x0F, "KeyY": 0x10, "KeyT": 0x11,
    "Digit1": 0x12, "Digit2": 0x13, "Digit3": 0x14, "Digit4": 0x15, "Digit6": 0x16,
    "Digit5": 0x17, "Digit9": 0x19, "Digit7": 0x1A, "Digit8": 0x1C, "Digit0": 0x1D,
    "KeyO": 0x1F, "KeyU": 0x20, "KeyI": 0x22, "KeyP": 0x23, "KeyL": 0x25, "KeyJ": 0x26,
    "KeyK": 0x28, "KeyN": 0x2D, "KeyM": 0x2E,
]

let escapeCode: Int64 = 0x35

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    emit("unsupported", ["why": "no key named"])
    exit(2)
}
let name = arguments[1]
let checkOnly = arguments.contains("--check")

let target: Key
if let modifier = modifiers[name] {
    target = modifier
} else if let code = plain[name] {
    target = Key(code: code, deviceMask: nil)
} else {
    // Caps Lock toggles a state rather than reporting a press, and a key not
    // in the tables above is one nobody has mapped. Either way the window's
    // own handler is the one that works, and the app is told to keep it.
    emit("unsupported", ["key": name])
    exit(0)
}

if checkOnly {
    emit("mapped", ["key": name, "code": target.code, "modifier": target.deviceMask != nil])
    exit(0)
}

// The app's end of the pipe closing is the app having gone. Nothing else is
// ever read; a parent that dies without closing it (SIGKILL) still closes it,
// because the kernel does.
Thread.detachNewThread {
    while readLine(strippingNewline: false) != nil {}
    exit(0)
}

var held = false
var chorded = false
var tap: CFMachPort?

let callback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        // macOS switches a tap off when its callback is slow or the user is
        // typing fast through a stall; this one is never slow, and it is
        // switched back on rather than left dead with no sign of it.
        if let tap = tap { CGEvent.tapEnable(tap: tap, enable: true) }
        return Unmanaged.passUnretained(event)
    }
    let code = event.getIntegerValueField(.keyboardEventKeycode)
    let repeating = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
    switch type {
    case .flagsChanged:
        if let mask = target.deviceMask, code == target.code {
            let down = (event.flags.rawValue & mask) != 0
            if down && !held {
                held = true
                chorded = false
                emit("down")
            } else if !down && held {
                held = false
                emit("up")
            }
        }
    case .keyDown:
        if target.deviceMask == nil && code == target.code {
            if !repeating && !held {
                held = true
                chorded = false
                emit("down")
            }
        } else if code == escapeCode {
            if !repeating { emit("escape") }
        } else if held && !chorded && !repeating {
            chorded = true
            emit("chord")
        }
    case .keyUp:
        if target.deviceMask == nil && code == target.code && held {
            held = false
            emit("up")
        }
    default:
        break
    }
    return Unmanaged.passUnretained(event)
}

let mask: CGEventMask =
    (1 << CGEventType.keyDown.rawValue) |
    (1 << CGEventType.keyUp.rawValue) |
    (1 << CGEventType.flagsChanged.rawValue)

/// Try to open the tap. Nil is Input Monitoring refused — or not yet granted,
/// since the first attempt is what makes macOS put the app on the list.
func openTap() -> CFMachPort? {
    guard let port = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .listenOnly,
        eventsOfInterest: mask,
        callback: callback,
        userInfo: nil
    ) else { return nil }
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
    CGEvent.tapEnable(tap: port, enable: true)
    return port
}

// Asked first, which is what raises the system prompt the first time and
// adds the app to the Input Monitoring list; the tap itself would also do
// that, but silently. Then the tap, and if refused, again every few seconds
// until the switch in System Settings is flipped — no restart needed.
if !CGPreflightListenEventAccess() {
    _ = CGRequestListenEventAccess()
}
tap = openTap()
if tap != nil {
    emit("ready")
} else {
    emit("denied")
    let retry = Timer(timeInterval: 3, repeats: true) { timer in
        if CGPreflightListenEventAccess(), let opened = openTap() {
            tap = opened
            emit("ready")
            timer.invalidate()
        }
    }
    RunLoop.current.add(retry, forMode: .common)
}
CFRunLoopRun()
