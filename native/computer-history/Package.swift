// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "LatitudeHistory", platforms: [.macOS(.v11)], products: [.library(name: "HistoryCore", targets: ["HistoryCore"])], targets: [.target(name: "HistoryCore"), .testTarget(name: "HistoryCoreTests", dependencies: ["HistoryCore"])])
