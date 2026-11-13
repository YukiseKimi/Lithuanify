// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LithuanifyCore",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "LithuanifyCore", targets: ["LithuanifyCore"])],
    targets: [
        .target(name: "LithuanifyCore"),
        .testTarget(name: "LithuanifyCoreTests", dependencies: ["LithuanifyCore"])
    ]
)
