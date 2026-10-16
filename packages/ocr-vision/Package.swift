// swift-tools-version:5.9
// The Apple Vision OCR sidecar (ADR-0002, issue #8). One image in, one
// `ocr-v1` JSON object out on stdout; the contract's schema lives in
// packages/core/src/ocr-contract.ts.
import PackageDescription

let package = Package(
  name: "outtray-ocr",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(name: "outtray-ocr", path: "Sources/outtray-ocr")
  ]
)
