// A glance at the screen, for the pen (docs/plans/screen-annotate.md).
//
// The screen pen takes one still of a display at the moment ink first goes
// down on it, and says which application's window was under the ink. Neither
// is something Electron can do: it has no "this display, without these
// windows" — `desktopCapturer` is a thumbnail API that cannot leave kururu's
// own overlay out, so every still would be a picture of the ink over a
// picture of the ink — and no "the window at this point". Both are a page of
// Swift each, so this is `talkkey`'s pattern again: a bare program beside the
// app, a process of its own so a crash costs the pen and not a window, and
// JSON lines on stdin and stdout. It reads requests until stdin closes, which
// is how it learns the app has gone.
//
// The still is kept in memory under the id main gives it, and only when the
// burst of ink is over is it inked and written: the strokes are drawn onto it
// here, with Core Graphics, as a crop at the display's own pixels and the
// whole display shrunk. Doing it here rather than in a page means a 5K still
// never crosses a process boundary, and nothing of the screen is on the disk
// until there is ink to go with it.
//
// Every request carries a `seq`, echoed on its answer.
//
//   {"seq":1,"op":"access"}                         → {"seq":1,"screen":"granted"|"denied"}
//   {"seq":2,"op":"ask"}                            → the system prompt, once per app; then as access
//   {"seq":3,"op":"shot","id":"b1","display":1,"bounds":{…},"exclude":[123]}
//                                                   → {"seq":3,"ok":true,"width":…,"height":…,"scale":2}
//   {"seq":4,"op":"ink","id":"b1","strokes":[[[x,y],…]],"crop":{"path":…,"rect":{…}},"frame":{"path":…,"long":1568}}
//                                                   → {"seq":4,"ok":true,"crop":{…},"frame":{…}}
//   {"seq":5,"op":"drop","id":"b1"}                 → {"seq":5,"ok":true}
//   {"seq":6,"op":"under","x":…,"y":…,"exclude":[…]} → {"seq":6,"app":…,"bundle":…,"window":…,"bounds":{…},"front":{…}}
//   {"seq":7,"op":"secure"}                         → {"seq":7,"secure":false}
//   {"seq":8,"op":"load","id":"b1","path":…,"scale":2} → a picture from the disk kept as if it were a still;
//                                                   for the tests, which cannot be granted Screen Recording
//
// Points are global, top-left, as Electron's `screen` gives them; a stroke's
// points are relative to its display's top-left corner.

import AppKit
import Carbon
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit

setvbuf(stdout, nil, _IOLBF, 0)

let out = DispatchQueue(label: "glance.out")

func emit(_ line: [String: Any]) {
    out.sync {
        if let data = try? JSONSerialization.data(withJSONObject: line),
           let text = String(data: data, encoding: .utf8) {
            print(text)
        }
    }
}

/// The ink's colour: a red that reads on a light page and a dark one, a
/// little transparent so the words under a stroke can still be made out.
let inkColor = CGColor(red: 1.0, green: 0.18, blue: 0.33, alpha: 0.85)

struct Kept {
    let image: CGImage
    /// Pixels per point of the display it was taken of.
    let scale: CGFloat
}

/// The stills waiting for their burst to end. An actor, since requests are
/// answered on whatever thread their task lands on.
actor Stills {
    private var kept: [String: Kept] = [:]
    func put(_ id: String, _ still: Kept) {
        // A session never holds more than a few; one that was never inked or
        // dropped is let go rather than kept for the life of the app.
        if kept.count >= 24, let oldest = kept.keys.first { kept.removeValue(forKey: oldest) }
        kept[id] = still
    }
    func take(_ id: String) -> Kept? { kept.removeValue(forKey: id) }
}

let stills = Stills()

func number(_ value: Any?) -> Double? {
    if let n = value as? NSNumber { let d = n.doubleValue; return d.isFinite ? d : nil }
    return nil
}

func rect(_ value: Any?) -> CGRect? {
    guard let r = value as? [String: Any],
          let x = number(r["x"]), let y = number(r["y"]),
          let w = number(r["width"]), let h = number(r["height"]), w > 0, h > 0 else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
}

func box(_ r: CGRect) -> [String: Any] {
    ["x": r.origin.x, "y": r.origin.y, "width": r.size.width, "height": r.size.height]
}

func windowNumbers(_ value: Any?) -> Set<CGWindowID> {
    guard let list = value as? [Any] else { return [] }
    return Set(list.compactMap { number($0) }.filter { $0 >= 0 && $0 < 4_294_967_295 }.map { CGWindowID($0) })
}

/// The display a request names: by its id, which is what Electron's
/// `display.id` is taken to be (the CGDirectDisplayID) — unverified on every
/// Mac, so by its bounds when the id matches nothing.
func display(in content: SCShareableContent, id: Double?, bounds: CGRect?) -> SCDisplay? {
    if let id = id, let found = content.displays.first(where: { Double($0.displayID) == id }) { return found }
    guard let bounds = bounds else { return nil }
    return content.displays.min(by: { a, b in
        abs(a.frame.minX - bounds.minX) + abs(a.frame.minY - bounds.minY) + abs(a.frame.width - bounds.width)
            < abs(b.frame.minX - bounds.minX) + abs(b.frame.minY - bounds.minY) + abs(b.frame.width - bounds.width)
    })
}

func shot(_ req: [String: Any]) async -> [String: Any] {
    guard let id = req["id"] as? String, !id.isEmpty else { return ["ok": false, "error": "no id"] }
    guard CGPreflightScreenCaptureAccess() else { return ["ok": false, "error": "denied"] }
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let target = display(in: content, id: number(req["display"]), bounds: rect(req["bounds"])) else {
            return ["ok": false, "error": "no such display"]
        }
        let exclude = windowNumbers(req["exclude"])
        let windows = content.windows.filter { exclude.contains($0.windowID) }
        let filter = SCContentFilter(display: target, excludingWindows: windows)
        let scale = CGFloat(filter.pointPixelScale)
        let config = SCStreamConfiguration()
        config.width = Int((target.frame.width * scale).rounded())
        config.height = Int((target.frame.height * scale).rounded())
        config.showsCursor = false
        config.captureResolution = .best
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        await stills.put(id, Kept(image: image, scale: scale))
        return ["ok": true, "width": image.width, "height": image.height, "scale": scale, "display": target.displayID]
    } catch {
        return ["ok": false, "error": error.localizedDescription]
    }
}

/// Strokes as points relative to the display, from `[[[x, y], …], …]`.
func strokes(_ value: Any?) -> [[CGPoint]] {
    guard let list = value as? [Any] else { return [] }
    return list.prefix(500).compactMap { stroke -> [CGPoint]? in
        guard let points = stroke as? [Any] else { return nil }
        let out = points.prefix(20_000).compactMap { p -> CGPoint? in
            guard let pair = p as? [Any], pair.count >= 2, let x = number(pair[0]), let y = number(pair[1]) else { return nil }
            return CGPoint(x: x, y: y)
        }
        return out.isEmpty ? nil : out
    }
}

/// Part of a still, at `k` output pixels per still pixel, with the strokes on
/// it `width` output pixels wide. `source` is in the still's pixels,
/// top-left; the strokes are in points and `scale` turns them into pixels.
func render(_ still: Kept, source: CGRect, k: CGFloat, strokes: [[CGPoint]], width: CGFloat) -> CGImage? {
    let outW = max(1, Int((source.width * k).rounded()))
    let outH = max(1, Int((source.height * k).rounded()))
    guard let ctx = CGContext(data: nil, width: outW, height: outH, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.interpolationQuality = .high
    let imgW = CGFloat(still.image.width)
    let imgH = CGFloat(still.image.height)
    // Core Graphics draws from the bottom left; the source rect is from the top.
    ctx.draw(still.image, in: CGRect(x: -source.minX * k, y: -(imgH - source.maxY) * k, width: imgW * k, height: imgH * k))
    ctx.translateBy(x: 0, y: CGFloat(outH))
    ctx.scaleBy(x: 1, y: -1)
    ctx.setStrokeColor(inkColor)
    ctx.setLineWidth(width)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    for stroke in strokes {
        let pts = stroke.map { CGPoint(x: ($0.x * still.scale - source.minX) * k, y: ($0.y * still.scale - source.minY) * k) }
        guard let first = pts.first else { continue }
        ctx.beginPath()
        ctx.move(to: first)
        if pts.count == 1 {
            ctx.addLine(to: CGPoint(x: first.x + 0.1, y: first.y))
        } else {
            for p in pts.dropFirst() { ctx.addLine(to: p) }
        }
        ctx.strokePath()
    }
    return ctx.makeImage()
}

func write(_ image: CGImage, to path: String, jpeg: Bool) -> Bool {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let dest = CGImageDestinationCreateWithURL(url, (jpeg ? "public.jpeg" : "public.png") as CFString, 1, nil) else { return false }
    let props: [CFString: Any] = jpeg ? [kCGImageDestinationLossyCompressionQuality: 0.8] : [:]
    CGImageDestinationAddImage(dest, image, props as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { return false }
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    return true
}

func ink(_ req: [String: Any]) async -> [String: Any] {
    guard let id = req["id"] as? String, let still = await stills.take(id) else { return ["ok": false, "error": "no such still"] }
    let lines = strokes(req["strokes"])
    var answer: [String: Any] = ["ok": true]
    let imgW = CGFloat(still.image.width)
    let imgH = CGFloat(still.image.height)
    if let crop = req["crop"] as? [String: Any], let path = crop["path"] as? String, let r = rect(crop["rect"]) {
        // The rect is in points; held inside the still, at its own pixels.
        let px = CGRect(x: r.minX * still.scale, y: r.minY * still.scale, width: r.width * still.scale, height: r.height * still.scale)
            .intersection(CGRect(x: 0, y: 0, width: imgW, height: imgH)).integral
        if !px.isEmpty, let image = render(still, source: px, k: 1, strokes: lines, width: 3 * still.scale), write(image, to: path, jpeg: false) {
            answer["crop"] = ["width": image.width, "height": image.height]
        } else {
            answer["ok"] = false
            answer["error"] = "the crop could not be written"
        }
    }
    if let frame = req["frame"] as? [String: Any], let path = frame["path"] as? String {
        let long = CGFloat(number(frame["long"]) ?? 1568)
        let k = min(1, long / max(imgW, imgH))
        // Three pixels at the frame's size, whatever it was shrunk by.
        if let image = render(still, source: CGRect(x: 0, y: 0, width: imgW, height: imgH), k: k, strokes: lines, width: 3), write(image, to: path, jpeg: true) {
            answer["frame"] = ["width": image.width, "height": image.height]
        } else {
            answer["ok"] = false
            answer["error"] = "the frame could not be written"
        }
    }
    return answer
}

func appInfo(pid: pid_t) -> (name: String, bundle: String) {
    let app = NSRunningApplication(processIdentifier: pid)
    return (app?.localizedName ?? "", app?.bundleIdentifier ?? "")
}

/// The topmost window at a point that is not one of ours, with its title —
/// which macOS gives only to a process allowed to record the screen. Normal
/// windows (layer 0) first, since a menu bar or a floating palette is rarely
/// what was pointed at; any layer when no normal window is there.
func under(_ req: [String: Any]) -> [String: Any] {
    guard let x = number(req["x"]), let y = number(req["y"]) else { return ["error": "no point"] }
    let point = CGPoint(x: x, y: y)
    let exclude = windowNumbers(req["exclude"])
    let info = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    let candidates = info.filter { w in
        guard let n = number(w[kCGWindowNumber as String]), !exclude.contains(CGWindowID(n)),
              let b = w[kCGWindowBounds as String] as? [String: Any],
              let r = CGRect(dictionaryRepresentation: b as CFDictionary) else { return false }
        if let alpha = number(w[kCGWindowAlpha as String]), alpha <= 0.01 { return false }
        return r.contains(point)
    }
    let hit = candidates.first(where: { (number($0[kCGWindowLayer as String]) ?? 0) == 0 }) ?? candidates.first
    var answer: [String: Any] = [:]
    if let hit = hit {
        let pid = pid_t(number(hit[kCGWindowOwnerPID as String]) ?? 0)
        let app = appInfo(pid: pid)
        answer["app"] = app.name.isEmpty ? (hit[kCGWindowOwnerName as String] as? String ?? "") : app.name
        answer["bundle"] = app.bundle
        answer["pid"] = Int(pid)
        answer["window"] = hit[kCGWindowName as String] as? String ?? ""
        answer["layer"] = number(hit[kCGWindowLayer as String]) ?? 0
        if let b = hit[kCGWindowBounds as String] as? [String: Any], let r = CGRect(dictionaryRepresentation: b as CFDictionary) {
            answer["bounds"] = box(r)
        }
    }
    if let front = NSWorkspace.shared.frontmostApplication {
        answer["front"] = ["app": front.localizedName ?? "", "bundle": front.bundleIdentifier ?? ""]
    }
    return answer
}

func handle(_ req: [String: Any]) async -> [String: Any] {
    switch req["op"] as? String ?? "" {
    case "access":
        return ["screen": CGPreflightScreenCaptureAccess() ? "granted" : "denied"]
    case "ask":
        let granted = CGRequestScreenCaptureAccess()
        return ["screen": granted ? "granted" : "denied"]
    case "shot":
        return await shot(req)
    case "ink":
        return await ink(req)
    case "load":
        guard let id = req["id"] as? String, let path = req["path"] as? String,
              let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return ["ok": false, "error": "could not load"] }
        await stills.put(id, Kept(image: image, scale: CGFloat(number(req["scale"]) ?? 1)))
        return ["ok": true, "width": image.width, "height": image.height]
    case "drop":
        if let id = req["id"] as? String { _ = await stills.take(id) }
        return ["ok": true]
    case "under":
        return under(req)
    case "secure":
        return ["secure": IsSecureEventInputEnabled()]
    default:
        return ["error": "unknown op"]
    }
}

// Requests are read on a thread of their own and answered one at a time, in
// the order sent: an `ink` must find the still its `shot` kept, and a still
// takes tens of milliseconds, which is nothing next to a burst of ink. The
// main run loop stays free for AppKit's notifications, which
// `frontmostApplication` is kept current by.
let (requests, feed) = AsyncStream.makeStream(of: [String: Any].self)

Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        feed.yield(req)
    }
    exit(0)
}

Task {
    for await req in requests {
        var answer = await handle(req)
        answer["seq"] = req["seq"] ?? NSNull()
        emit(answer)
    }
}

emit(["ready": true, "screen": CGPreflightScreenCaptureAccess() ? "granted" : "denied"])
RunLoop.main.run()
