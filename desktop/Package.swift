// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "QiCanIScreenwrite", platforms: [.macOS(.v14)],
  products: [.executable(name: "QiCanIScreenwrite", targets: ["QiCanIScreenwrite"])],
  targets: [.executableTarget(name: "QiCanIScreenwrite")])
