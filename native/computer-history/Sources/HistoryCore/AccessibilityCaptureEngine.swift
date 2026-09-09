import AppKit
import ApplicationServices
import Foundation

/// Same-process capture. The native host owns persistence and enablement; this
/// engine never writes files and never requests permission on application launch.
@MainActor
public final class AccessibilityCaptureEngine {
  public enum State: Equatable { case stopped, running, paused }
  public private(set) var state: State = .stopped
  public var onEvent: ((HistoryEvent) -> Void)?
  public var config = NativeHistoryConfig()
  public private(set) var coverage = ""
  private var previous = ""
  private var locked = false
  private var observers: [NSObjectProtocol] = []
  private var inputMonitor: Any?
  private var pendingKind: HistoryEventKind?
  private var inputCount = 0
  private var pendingShortcut: String?
  private var previousApp = ""
  public init() {
    let center = NSWorkspace.shared.notificationCenter
    for name in [NSWorkspace.sessionDidResignActiveNotification, NSWorkspace.willSleepNotification] {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.locked = true; self?.previous = "" }
      })
    }
    for name in [NSWorkspace.sessionDidBecomeActiveNotification, NSWorkspace.didWakeNotification] {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.locked = false; self?.previous = "" }
      })
    }
    DistributedNotificationCenter.default().addObserver(self, selector: #selector(screenLocked), name: .init("com.apple.screenIsLocked"), object: nil)
    DistributedNotificationCenter.default().addObserver(self, selector: #selector(screenUnlocked), name: .init("com.apple.screenIsUnlocked"), object: nil)
  }
  @objc private func screenLocked() { locked = true; previous = "" }
  @objc private func screenUnlocked() { locked = false; previous = "" }
  public static var hasAccessibilityPermission: Bool { AXIsProcessTrusted() }
  public static func requestAccessibilityPermission() {
    _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
  }
  public func start() {
    state = .running
    guard inputMonitor == nil, Self.hasAccessibilityPermission else { return }
    inputMonitor = NSEvent.addGlobalMonitorForEvents(matching:[.leftMouseDown,.rightMouseDown,.keyDown]) { [weak self] event in
      MainActor.assumeIsolated {
        guard let self, self.state == .running, !self.locked else { return }
        if event.type == .keyDown {
          if event.modifierFlags.contains(.command) || event.modifierFlags.contains(.control) {
            self.pendingKind = .shortcut
            // Store only named navigation/edit actions, never characters or
            // arbitrary key codes that could reconstruct typed credentials.
            let names:[UInt16:String] = [0:"SelectAll",6:"Undo",7:"Cut",8:"Copy",9:"Paste",12:"Quit",13:"Close",17:"NewTab",36:"Return",48:"Switch",53:"Escape"]
            self.pendingShortcut = names[event.keyCode] ?? "Shortcut"
          } else { self.pendingKind = .inputActivity; self.inputCount += 1 }
        } else { self.pendingKind = .click }
      }
    }
  }
  private func clearInput() { pendingKind = nil; inputCount = 0; pendingShortcut = nil }
  private func stopInput() { if let monitor = inputMonitor { NSEvent.removeMonitor(monitor) }; inputMonitor = nil; clearInput() }
  public func pause() { state = .paused; previous = ""; stopInput() }
  public func stop() { state = .stopped; previous = ""; stopInput() }
  public func resume() { start() }

  public func sample() {
    defer { clearInput() }
    coverage = ""
    guard state == .running, !locked else { coverage = locked ? "locked" : ""; return }
    guard Self.hasAccessibilityPermission else { coverage = "permission_required"; return }
    guard let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return }
    let bundle = app.bundleIdentifier ?? ""
    let name = app.localizedName ?? bundle
    guard config.allowsApplication(name, bundle) else { previous = ""; return }
    let element = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(element, 0.15)
    guard let candidate = ax(element, kAXFocusedWindowAttribute), CFGetTypeID(candidate)==AXUIElementGetTypeID() else { coverage = "window_unavailable"; return }
    let window = candidate as! AXUIElement
    let title = ax(window, kAXTitleAttribute) as? String ?? ""
    let browser = NativeHistoryConfig.isBrowser(bundle)
    var url = ax(window, kAXDocumentAttribute) as? String
    var privacyState = "normal"
    if browser {
      // Chromium's scripting dictionary exposes window mode. Do not infer
      // 'normal' merely from absence of a private keyword in a localized title.
      let chromium = ["com.google.Chrome", "com.microsoft.edgemac", "com.brave.Browser", "com.vivaldi.Vivaldi"]
      if chromium.contains(bundle) {
        var error: NSDictionary?
        let script = NSAppleScript(source: "tell application id \"\(bundle)\"\nif (count of windows) is 0 then return {}\nreturn {mode of front window, URL of active tab of front window}\nend tell")
        let result = script?.executeAndReturnError(&error)
        guard error == nil, let result, result.numberOfItems == 2,
              let mode = result.atIndex(1)?.stringValue, let address = result.atIndex(2)?.stringValue else {
          coverage = "browser_permission_required"; return
        }
        guard mode == "normal" else { previous = ""; coverage = "private_excluded"; return }
        url = address
      } else {
        // Safari does not publish a reliable private-window flag in its
        // scripting dictionary. A browser adapter must prove that flag before
        // content capture; until then show the gap, never guess from its title.
        if let flag = ax(window, "AXPrivateBrowsing" as CFString) as? Bool {
          guard !flag else { previous = ""; coverage = "private_excluded"; return }
        } else { coverage = "browser_privacy_unavailable"; privacyState = "unknown"; return }
      }
      guard let address = url, let parsed = URL(string: address), let host = parsed.host,
            config.allowsSite(host) else { previous = ""; return }
    }
    // Check frontmost identity again after any cross-process query.
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { return }
    var lines: [String] = []; var visited = Set<CFHashCode>(); var count = 0
    let deadline = Date().addingTimeInterval(0.18)
    func walk(_ node: AXUIElement, _ depth: Int) {
      guard depth < 18, count < 600, Date() < deadline, lines.joined().count < 22000 else { return }
      let identity = CFHash(node); guard visited.insert(identity).inserted else { return }; count += 1
      let role = ax(node, kAXRoleAttribute) as? String ?? ""
      let subrole = ax(node, kAXSubroleAttribute) as? String ?? ""
      if NativeHistoryConfig.isSensitive(role + " " + subrole) || (ax(node, "AXHidden" as CFString) as? Bool) == true { return }
      var writable: DarwinBoolean = false
      if ["AXTextField", "AXTextArea", "AXComboBox"].contains(role) {
        let result = AXUIElementIsAttributeSettable(node, kAXValueAttribute as CFString, &writable)
        if result != .success || writable.boolValue { return }
      }
      if ["AXStaticText", "AXTextArea", "AXHeading", "AXLink"].contains(role) {
        let value = (ax(node,kAXValueAttribute) as? String) ?? (ax(node,kAXTitleAttribute) as? String) ?? ""
        if !value.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty { lines.append(String(value.prefix(6000))) }
      }
      let children = (ax(node, "AXVisibleChildren" as CFString) as? [AXUIElement]) ?? (ax(node,kAXChildrenAttribute) as? [AXUIElement]) ?? []
      for child in children { walk(child, depth + 1) }
    }
    walk(window, 0)
    let body = lines.joined(separator:"\n")
    coverage = body.isEmpty ? "navigation_only" : "partial"
    let signature = "\(bundle)|\(title)|\(url ?? "")|\(body)"
    let kind:HistoryEventKind = bundle != previousApp ? .appActivated : pendingKind ?? .accessibilityTextChanged
    guard signature != previous || pendingKind != nil else { return }; previous = signature; previousApp = bundle
    onEvent?(HistoryEvent(kind: kind, source: pendingKind == nil ? .accessibility : .inputEvent,
      applicationName: name, bundleIdentifier: bundle, processIdentifier: app.processIdentifier,
      windowTitle: title, url: url, visibleText: body,
      inputCharacterCount:inputCount>0 ? inputCount:nil, shortcut:pendingShortcut,
      metadata: ["browser":browser ? "true":"false", "privacyState":privacyState,"coverage":coverage]))
  }
}
private func ax(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
  return value
}
private func ax(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? { ax(element, attribute as String) }
