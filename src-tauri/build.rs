fn main() {
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_macos_media();
    }
}

fn build_macos_media() {
    use std::{path::PathBuf, process::Command};
    let out = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        other => panic!("Unsupported macOS target: {other:?}"),
    };
    let target = format!("{arch}-apple-macosx11.0");
    println!("cargo:rerun-if-changed=native/LatitudeMedia.swift");
    let mut compiler = Command::new("xcrun");
    let status = compiler
        .args([
            "swiftc",
            "-target",
            &target,
            "-parse-as-library",
            "-emit-library",
            "-static",
            "-module-name",
            "LatitudeMedia",
            "-module-cache-path",
        ])
        .arg(out.join("swift-module-cache"))
        .arg("native/LatitudeMedia.swift")
        .args({
            let root = PathBuf::from("../native/computer-history/Sources/HistoryCore");
            println!("cargo:rerun-if-changed={}", root.display());
            let mut files: Vec<_> = std::fs::read_dir(root).unwrap().map(|e| e.unwrap().path()).filter(|p|p.extension().is_some_and(|s|s=="swift")).collect();
            files.sort(); files
        })
        .arg("-o")
        .arg(out.join("libLatitudeMedia.a"))
        .status()
        .expect("Xcode command-line tools are required for the macOS media bridge");
    assert!(status.success(), "Failed to compile the macOS media bridge");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=LatitudeMedia");
    // swiftc ships the small compatibility libraries needed by a Rust host;
    // the actual Swift runtime is supplied by supported macOS versions.
    let info = Command::new("xcrun")
        .args(["swiftc", "-print-target-info", "-target", &target])
        .output()
        .expect("Read Swift runtime search paths");
    assert!(
        info.status.success(),
        "Could not read Swift runtime search paths"
    );
    let info: serde_json::Value =
        serde_json::from_slice(&info.stdout).expect("Swift target info JSON");
    for key in ["runtimeLibraryPaths", "runtimeLibraryImportPaths"] {
        for path in info["paths"][key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|value| value.as_str())
        {
            println!("cargo:rustc-link-search=native={path}");
        }
    }
    for framework in ["Foundation", "AppKit", "AVFoundation", "Speech", "Vision", "ApplicationServices"] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
}
