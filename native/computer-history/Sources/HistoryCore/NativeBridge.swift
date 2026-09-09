import Foundation
public typealias HistoryCallback = @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>?) -> Void
@MainActor private var nativeEngine: AccessibilityCaptureEngine?

@_cdecl("latitude_history_configure")
public func latitudeHistoryConfigure(_ input:UnsafePointer<CChar>) {
  let data=Data(String(cString:input).utf8)
  DispatchQueue.main.async {
    guard let config=try? JSONDecoder().decode(NativeHistoryConfig.self,from:data) else {nativeEngine?.stop();return}
    let engine=nativeEngine ?? AccessibilityCaptureEngine();nativeEngine=engine;engine.config=config
    if !config.enabled || !config.nativeEnabled {engine.stop()} else if config.paused {engine.pause()} else {engine.start()}
  }
}

@_cdecl("latitude_history_poll")
public func latitudeHistoryPoll(_ input: UnsafePointer<CChar>, _ callback: @escaping HistoryCallback, _ context: UnsafeMutableRawPointer?) {
  let data = Data(String(cString: input).utf8)
  DispatchQueue.main.async {
    do {
      let config = try JSONDecoder().decode(NativeHistoryConfig.self, from:data)
      let engine = nativeEngine ?? AccessibilityCaptureEngine(); nativeEngine = engine
      engine.config = config
      var events: [HistoryEvent] = []
      engine.onEvent = { events.append($0) }
      if config.enabled && config.nativeEnabled && !config.paused { engine.start(); engine.sample() }
      else if config.paused { engine.pause() } else { engine.stop() }
      let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
      let encodedEvents = try JSONSerialization.jsonObject(with: encoder.encode(events))
      let state = !config.enabled || !config.nativeEnabled ? "stopped" : config.paused ? "paused" : !AccessibilityCaptureEngine.hasAccessibilityPermission ? "permission_required" : engine.coverage == "locked" ? "locked" : "running"
      let payload: [String:Any] = ["state":state, "events":encodedEvents, "permission":AccessibilityCaptureEngine.hasAccessibilityPermission, "coverage":engine.coverage]
      let json = try JSONSerialization.data(withJSONObject:payload)
      String(decoding:json,as:UTF8.self).withCString { callback(context,$0) }
      engine.onEvent = nil
    } catch { "{\"state\":\"error\",\"events\":[],\"error\":\"记录设置无法读取\"}".withCString { callback(context,$0) } }
  }
}
@_cdecl("latitude_history_request_permission")
public func latitudeHistoryPermission() {
  DispatchQueue.main.async { AccessibilityCaptureEngine.requestAccessibilityPermission() }
}
