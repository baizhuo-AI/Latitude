import Foundation

public enum CaptureDetail: String, Codable, Sendable {
  case excluded
  case metadataOnly
  case accessibility
}

public struct AppCaptureRule: Codable, Equatable, Sendable {
  public var id: String
  public var bundleIdentifierPrefixes: [String]
  public var applicationNames: [String]
  public var detail: CaptureDetail
  public var allowedSources: Set<EvidenceSource>

  public init(
    id: String,
    bundleIdentifierPrefixes: [String] = [],
    applicationNames: [String] = [],
    detail: CaptureDetail,
    allowedSources: Set<EvidenceSource>
  ) {
    self.id = id
    self.bundleIdentifierPrefixes = bundleIdentifierPrefixes
    self.applicationNames = applicationNames
    self.detail = detail
    self.allowedSources = allowedSources
  }

  public func matches(bundleIdentifier: String?, applicationName: String?) -> Bool {
    if let bundleIdentifier,
      bundleIdentifierPrefixes.contains(where: { bundleIdentifier.hasPrefix($0) })
    {
      return true
    }
    if let applicationName {
      return applicationNames.contains {
        $0.compare(applicationName, options: [.caseInsensitive, .diacriticInsensitive])
          == .orderedSame
      }
    }
    return false
  }
}

public struct AudioCaptureConfiguration: Codable, Equatable, Sendable {
  public var microphoneEnabled: Bool
  public var systemAudioEnabled: Bool
  public var retentionHours: Int

  public init(
    microphoneEnabled: Bool = false,
    systemAudioEnabled: Bool = false,
    retentionHours: Int = 24
  ) {
    self.microphoneEnabled = microphoneEnabled
    self.systemAudioEnabled = systemAudioEnabled
    self.retentionHours = retentionHours
  }
}

public struct HistoryConfiguration: Codable, Equatable, Sendable {
  public var segmentMinutes: Int
  public var rawEventRetentionHours: Int
  public var maximumTextLength: Int
  public var audio: AudioCaptureConfiguration
  public var appRules: [AppCaptureRule]

  public init(
    segmentMinutes: Int = 10,
    rawEventRetentionHours: Int = 48,
    maximumTextLength: Int = 4_000,
    audio: AudioCaptureConfiguration = .init(),
    appRules: [AppCaptureRule] = HistoryConfiguration.defaultAppRules
  ) {
    self.segmentMinutes = segmentMinutes
    self.rawEventRetentionHours = rawEventRetentionHours
    self.maximumTextLength = maximumTextLength
    self.audio = audio
    self.appRules = appRules
  }

  public static let defaultAppRules: [AppCaptureRule] = [
    AppCaptureRule(
      id: "wechat-safe-accessibility",
      bundleIdentifierPrefixes: ["com.tencent.xinWeChat", "com.tencent.WeChat"],
      applicationNames: ["WeChat", "微信"],
      detail: .accessibility,
      allowedSources: [.workspace, .accessibility, .inputEvent, .internalStatus]
    ),
    AppCaptureRule(
      id: "qq-generic-metadata-only",
      bundleIdentifierPrefixes: ["com.tencent.qq", "com.tencent.QQ"],
      applicationNames: ["QQ"],
      detail: .metadataOnly,
      allowedSources: [.workspace, .accessibility, .inputEvent, .internalStatus]
    ),
  ]
}

extension HistoryConfiguration {
  public static func loadOrCreate(at url: URL) throws -> HistoryConfiguration {
    let fileManager = FileManager.default
    if fileManager.fileExists(atPath: url.path) {
      let data = try Data(contentsOf: url)
      return try JSONDecoder().decode(HistoryConfiguration.self, from: data)
    }

    let configuration = HistoryConfiguration()
    try fileManager.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(configuration).write(to: url, options: .atomic)
    return configuration
  }
}
