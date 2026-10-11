// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "MdCollab",
    platforms: [.macOS(.v12)],
    targets: [
        .executableTarget(
            name: "MdCollab",
            path: "Sources/MdCollab"
        )
    ]
)
