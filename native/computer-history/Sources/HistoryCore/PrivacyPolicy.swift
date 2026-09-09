import Foundation

public struct PrivacyPolicy: Sendable {
  public let configuration: HistoryConfiguration

  private static let sensitiveRoleFragments = [
    "secure", "password", "creditcard", "payment",
  ]

  public init(configuration: HistoryConfiguration) {
    self.configuration = configuration
  }

  /// Applies privacy controls before an event can reach disk.
  public func sanitize(_ original: HistoryEvent) -> HistoryEvent? {
    var event = original

    if event.metadata["privateBrowsing"] == "true" {
      return nil
    }

    if let rule = configuration.appRules.first(where: {
      $0.matches(bundleIdentifier: event.bundleIdentifier, applicationName: event.applicationName)
    }) {
      guard rule.detail != .excluded, rule.allowedSources.contains(event.source) else {
        return nil
      }
      if rule.detail == .metadataOnly {
        removeContent(from: &event, reason: "metadata_only:\(rule.id)")
      }
    }

    if isSensitiveElement(event) {
      removeContent(from: &event, reason: "secure_element")
    }

    event.windowTitle = bounded(event.windowTitle)
    event.targetLabel = bounded(event.targetLabel)
    event.visibleText = bounded(event.visibleText)
    event.selectedText = bounded(event.selectedText)
    return event
  }

  private func isSensitiveElement(_ event: HistoryEvent) -> Bool {
    let descriptor = [event.targetRole, event.targetSubrole, event.targetLabel]
      .compactMap { $0 }
      .joined(separator: " ")
      .lowercased()
    return Self.sensitiveRoleFragments.contains { descriptor.contains($0) }
  }

  private func removeContent(from event: inout HistoryEvent, reason: String) {
    event.targetLabel = nil
    event.visibleText = nil
    event.selectedText = nil
    event.url = nil
    event.shortcut = nil
    event.metadata["redaction"] = reason
  }

  private func bounded(_ value: String?) -> String? {
    guard let value else { return nil }
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { return nil }
    return String(normalized.prefix(configuration.maximumTextLength))
  }
}
