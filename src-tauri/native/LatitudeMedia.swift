import Foundation
import AppKit
import AVFoundation
import Speech
import Vision

public typealias LatitudeMediaCallback = @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>?) -> Void

private func reply(_ callback: LatitudeMediaCallback, _ context: UnsafeMutableRawPointer?, _ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value)
    String(data: data, encoding: .utf8)!.withCString { callback(context, $0) }
}

private final class VoiceCapture {
    static var current: VoiceCapture?
    let engine = AVAudioEngine()
    let request = SFSpeechAudioBufferRecognitionRequest()
    var task: SFSpeechRecognitionTask?
    var transcript = ""
    var inputInstalled = false
    var ended = false
    var completion: (() -> Void)?

    func stopAudio() {
        engine.stop()
        if inputInstalled { engine.inputNode.removeTap(onBus: 0); inputInstalled = false }
        request.endAudio()
    }

    func finish() {
        stopAudio()
        task?.cancel()
        task = nil
        if VoiceCapture.current === self { VoiceCapture.current = nil }
    }
}

@_cdecl("latitude_speech_start")
public func latitudeSpeechStart(_ callback: @escaping LatitudeMediaCallback, _ context: UnsafeMutableRawPointer?) {
    DispatchQueue.main.async {
        guard VoiceCapture.current == nil else {
            reply(callback, context, ["error": "另一个窗口正在录音，请先完成或取消。"])
            return
        }
        let capture = VoiceCapture()
        VoiceCapture.current = capture
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else {
                DispatchQueue.main.async {
                    capture.finish()
                    reply(callback, context, ["error": "语音识别权限未开启。请在系统设置中允许维度使用语音识别，或继续打字。"])
                }
                return
            }
            AVCaptureDevice.requestAccess(for: .audio) { allowed in
                DispatchQueue.main.async {
                    guard allowed else {
                        capture.finish()
                        reply(callback, context, ["error": "麦克风权限未开启。请在系统设置中允许维度使用麦克风，或继续打字。"])
                        return
                    }
                    guard VoiceCapture.current === capture else {
                        reply(callback, context, ["error": "录音已取消。"])
                        return
                    }
                    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")), recognizer.isAvailable else {
                        capture.finish()
                        reply(callback, context, ["error": "系统语音识别暂时不可用，请检查网络或继续打字。"])
                        return
                    }
                    let input = capture.engine.inputNode
                    let format = input.outputFormat(forBus: 0)
                    guard format.sampleRate > 0 && format.channelCount > 0 else {
                        capture.finish()
                        reply(callback, context, ["error": "没有找到可用的麦克风，请检查输入设备。"])
                        return
                    }
                    capture.request.shouldReportPartialResults = true
                    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in capture.request.append(buffer) }
                    capture.inputInstalled = true
                    capture.task = recognizer.recognitionTask(with: capture.request) { result, error in
                        DispatchQueue.main.async {
                            if let result = result { capture.transcript = result.bestTranscription.formattedString }
                            if result?.isFinal == true || error != nil {
                                capture.ended = true
                                capture.stopAudio()
                                capture.completion?()
                            }
                        }
                    }
                    do {
                        capture.engine.prepare()
                        try capture.engine.start()
                        reply(callback, context, ["ok": true])
                    } catch {
                        capture.finish()
                        reply(callback, context, ["error": "麦克风启动失败，请检查输入设备后重试。"])
                    }
                }
            }
        }
    }
}

@_cdecl("latitude_speech_stop")
public func latitudeSpeechStop(_ callback: @escaping LatitudeMediaCallback, _ context: UnsafeMutableRawPointer?) {
    DispatchQueue.main.async {
        guard let capture = VoiceCapture.current else {
            reply(callback, context, ["error": "当前没有录音。"])
            return
        }
        guard capture.completion == nil else {
            reply(callback, context, ["error": "正在整理录音，请稍候。"])
            return
        }
        var replied = false
        let complete = {
            guard !replied else { return }
            replied = true
            let text = capture.transcript
            capture.completion = nil
            capture.finish()
            reply(callback, context, ["text": text])
        }
        capture.completion = complete
        capture.stopAudio()
        if capture.ended { complete() }
        else { DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: complete) }
    }
}

@_cdecl("latitude_speech_cancel")
public func latitudeSpeechCancel(_ callback: @escaping LatitudeMediaCallback, _ context: UnsafeMutableRawPointer?) {
    DispatchQueue.main.async {
        if let capture = VoiceCapture.current {
            capture.transcript = ""
            if let completion = capture.completion { completion() }
            else { capture.finish() }
        }
        reply(callback, context, ["ok": true])
    }
}

@_cdecl("latitude_ocr_attachment")
public func latitudeOcrAttachment(_ base64: UnsafePointer<CChar>, _ callback: @escaping LatitudeMediaCallback, _ context: UnsafeMutableRawPointer?) {
    let encoded = String(cString: base64)
    DispatchQueue.global(qos: .userInitiated).async {
        guard let data = Data(base64Encoded: encoded) else {
            reply(callback, context, ["error": "图片数据无法读取，请重新选择。"])
            return
        }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = true
        do {
            try VNImageRequestHandler(data: data, options: [:]).perform([request])
            let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
            reply(callback, context, ["text": text])
        } catch {
            fputs("[Latitude OCR] \(error)\n", stderr)
            reply(callback, context, ["error": "这张图片无法识别，请尝试 PNG 或 JPEG 图片。"])
        }
    }
}

@_cdecl("latitude_pick_attachments")
public func latitudePickAttachments(_ callback: @escaping LatitudeMediaCallback, _ context: UnsafeMutableRawPointer?) {
    DispatchQueue.main.async {
        let panel = NSOpenPanel()
        panel.title = "选择发给秘书的附件"
        panel.prompt = "添加"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.allowedFileTypes = ["txt", "md", "markdown", "csv", "pdf", "docx", "png", "jpg", "jpeg", "webp"]
        panel.begin { result in
            reply(callback, context, ["paths": result == .OK ? panel.urls.map { $0.path } : []])
        }
    }
}
