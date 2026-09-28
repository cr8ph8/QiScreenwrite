// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ScreenwriteCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "ScreenwriteCore", targets: ["ScreenwriteCore"])],
    targets: [
        .target(name: "ScreenwriteCore"),
        .testTarget(name: "ScreenwriteCoreTests", dependencies: ["ScreenwriteCore"])
    ]
)
