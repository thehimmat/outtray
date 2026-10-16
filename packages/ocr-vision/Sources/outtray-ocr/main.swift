// outtray-ocr: recognize the text in one image with Apple Vision and print it
// as one `ocr-v1` JSON object on stdout (ADR-0002, issue #8).
//
//   outtray-ocr [--no-language-correction] <image>   recognize; JSON on stdout
//   outtray-ocr --contract                           print the contract version
//
// Exit status: 0 on success, 64 on bad usage, 65 when the image cannot be
// read, 70 when Vision fails. Errors go to stderr, never to stdout, so stdout
// is either a complete result or empty.
//
// Engine: VNRecognizeTextRequest at the accurate level. Language correction
// is on by default; --no-language-correction turns it off, because it can
// rewrite identifier-like tokens toward dictionary words (#160 measures both).
// RecognizeDocumentsRequest (macOS 26, adds paragraphs and tables) is the
// planned upgrade; the contract's `engine` field already names it.

import CoreGraphics
import Foundation
import ImageIO
import OcrCore
import Vision

func fail(_ message: String, _ status: Int32) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(status)
}

var args = Array(CommandLine.arguments.dropFirst())
if args == ["--contract"] {
  print(ocrContract)
  exit(0)
}
var languageCorrection = true
if let flag = args.firstIndex(of: "--no-language-correction") {
  languageCorrection = false
  args.remove(at: flag)
}
guard args.count == 1, !args[0].hasPrefix("--") else {
  fail("usage: outtray-ocr [--no-language-correction] <image> | outtray-ocr --contract", 64)
}

let path = args[0]
let url = URL(fileURLWithPath: path)
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
  let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
  fail("cannot read image: \(path)", 65)
}

let started = DispatchTime.now().uptimeNanoseconds
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = languageCorrection
let handler = VNImageRequestHandler(cgImage: image, options: [:])
do {
  try handler.perform([request])
} catch {
  fail("Vision failed on \(path): \(error.localizedDescription)", 70)
}

var lines: [Line] = []
for observation in request.results ?? [] {
  guard let candidate = observation.topCandidates(1).first else { continue }
  let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
  if text.isEmpty { continue }
  // Vision's box is normalized with the origin at the bottom left; flip it.
  let b = observation.boundingBox
  let box = Box(
    x: Double(b.minX), y: Double(1 - b.maxY), width: Double(b.width), height: Double(b.height))
  lines.append(Line(text: text, confidence: Double(candidate.confidence), box: box))
}
let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000

let output = Output(
  engine: "vision-recognize-text",
  engineRevision: request.revision,
  elapsedMs: elapsedMs,
  pages: [Page(width: image.width, height: image.height, lines: readingOrder(lines))]
)

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
do {
  let data = try encoder.encode(output)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
  fail("could not encode the result: \(error)", 70)
}
