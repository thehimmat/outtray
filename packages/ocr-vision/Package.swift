// swift-tools-version:5.9
// The Apple Vision OCR sidecar (ADR-0002, issue #8). One image in, one
// `ocr-v1` JSON object out on stdout; the contract's schema lives in
// packages/core/src/ocr-contract.ts. OcrCore holds the parts that do not need
// Vision (the output types, reading order), so they are unit-tested.
import PackageDescription

let package = Package(
  name: "outtray-ocr",
  platforms: [.macOS(.v13)],
  targets: [
    .target(name: "OcrCore", path: "Sources/OcrCore"),
    .executableTarget(
      name: "outtray-ocr", dependencies: ["OcrCore"], path: "Sources/outtray-ocr"),
    .testTarget(name: "OcrCoreTests", dependencies: ["OcrCore"], path: "Tests/OcrCoreTests"),
  ]
)
