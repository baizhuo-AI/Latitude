import Foundation
public struct NativeHistoryConfig: Codable {
  public var enabled = false
  public var paused = false
  public var nativeEnabled = true
  public var externalEnabled = false
  public var modelProcessing = false
  public var appMode = "exclude"
  public var apps: [String] = []
  public var siteMode = "exclude"
  public var sites: [String] = []
  public init() {}
  public func allowsApplication(_ name: String, _ bundle: String) -> Bool {
    let matched = apps.contains { $0.caseInsensitiveCompare(name) == .orderedSame || $0.caseInsensitiveCompare(bundle) == .orderedSame }
    return appMode == "include" ? matched : !matched
  }
  public func allowsSite(_ host: String) -> Bool {
    let host = host.lowercased()
    let matched = sites.contains { host == $0.lowercased() || host.hasSuffix("." + $0.lowercased()) }
    return siteMode == "include" ? matched : !matched
  }
  public static func isSensitive(_ role: String) -> Bool {
    ["secure", "password", "payment", "creditcard"].contains { role.lowercased().contains($0) }
  }
  public static func isBrowser(_ bundle: String) -> Bool {
    ["com.apple.Safari", "com.google.Chrome", "com.microsoft.edgemac", "org.mozilla.firefox", "com.brave.Browser", "company.thebrowser.Browser", "com.vivaldi.Vivaldi"].contains(bundle)
  }
}
