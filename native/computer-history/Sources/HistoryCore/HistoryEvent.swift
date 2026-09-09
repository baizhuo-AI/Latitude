import Foundation

public enum HistoryEventKind: String, Codable, Sendable {
  case appActivated
  case windowChanged
  case focusedElementChanged
  case accessibilityTextChanged
  case inputActivity
  case click
  case shortcut
  case audioStarted
  case audioStopped
  case captureStatus
}

public enum EvidenceSource: String, Codable, Sendable {
  case workspace
  case accessibility
  case inputEvent
  case browserExtension
  case microphone
  case systemAudio
  case screenshot
  case ocr
  case internalStatus
}

public struct HistoryEvent: Codable, Equatable, Sendable {
  public var schemaVersion: Int
  public var id: UUID
  public var timestamp: Date
  public var kind: HistoryEventKind
  public var source: EvidenceSource
  public var applicationName: String?
  public var bundleIdentifier: String?
  public var processIdentifier: Int32?
  public var windowTitle: String?
  public var url: String?
  public var targetRole: String?
  public var targetSubrole: String?
  public var targetLabel: String?
  public var visibleText: String?
  public var selectedText: String?
  public var inputCharacterCount: Int?
  public var shortcut: String?
  public var metadata: [String: String]

  public init(
    id: UUID = UUID(),
    timestamp: Date = Date(),
    kind: HistoryEventKind,
    source: EvidenceSource,
    applicationName: String? = nil,
    bundleIdentifier: String? = nil,
    processIdentifier: Int32? = nil,
    windowTitle: String? = nil,
    url: String? = nil,
    targetRole: String? = nil,
    targetSubrole: String? = nil,
    targetLabel: String? = nil,
    visibleText: String? = nil,
    selectedText: String? = nil,
    inputCharacterCount: Int? = nil,
    shortcut: String? = nil,
    metadata: [String: String] = [:]
  ) {
    self.schemaVersion = 1
    self.id = id
    self.timestamp = timestamp
    self.kind = kind
    self.source = source
    self.applicationName = applicationName
    self.bundleIdentifier = bundleIdentifier
    self.processIdentifier = processIdentifier
    self.windowTitle = windowTitle
    self.url = url
    self.targetRole = targetRole
    self.targetSubrole = targetSubrole
    self.targetLabel = targetLabel
    self.visibleText = visibleText
    self.selectedText = selectedText
    self.inputCharacterCount = inputCharacterCount
    self.shortcut = shortcut
    self.metadata = metadata
  }
}
