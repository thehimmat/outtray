// outtray-ocr: recognize the text in one image with Apple Vision and print it
// as one `ocr-v1` JSON object on stdout (ADR-0002, issue #8).
//
//   outtray-ocr <image>       recognize; JSON on stdout
//   outtray-ocr --contract    print the contract version and exit
//
// Exit status: 0 on success, 64 on bad usage, 65 when the image cannot be
// read, 70 when Vision fails. Errors go to stderr, never to stdout, so stdout
// is either a complete result or empty.
//
// Engine: VNRecognizeTextRequest at the accurate level. RecognizeDocumentsRequest
// (macOS 26, adds paragraphs and tables) is the planned upgrade; the contract's
// `engine` field already names it so the switch is not a contract change.

import CoreGraphics
import Foundation
import ImageIO
import Vision

let contract = "ocr-v1"

struct Box: Encodable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct Line: Encodable {
  let text: String
  let confidence: Double
  let box: Box
}

struct Page: Encodable {
  let width: Int
  let height: Int
  let lines: [Line]
}

struct Output: Encodable {
  let contract: String
  let engine: String
  let engineRevision: Int
  let elapsedMs: Double
  let pages: [Page]
}

func fail(_ message: String, _ status: Int32) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(status)
}

func clamp(_ v: CGFloat) -> Double {
  return min(1, max(0, Double(v)))
}

/// Reading order: group lines into rows by vertical overlap, then left to
/// right within a row. Vision's own order is close to this but not stable for
/// lines that share a baseline (a label and its value in two columns).
func readingOrder(_ lines: [Line]) -> [Line] {
  let byTop = lines.sorted { ($0.box.y, $0.box.x) < ($1.box.y, $1.box.x) }
  var rows: [[Line]] = []
  // A line joins the current row when its top is above the row's midline,
  // the midline of the row's first (topmost) line.
  var rowMid = -1.0
  for line in byTop {
    if rows.isEmpty || line.box.y >= rowMid {
      rows.append([line])
      rowMid = line.box.y + line.box.height / 2
    } else {
      rows[rows.count - 1].append(line)
    }
  }
  return rows.flatMap { row in row.sorted { $0.box.x < $1.box.x } }
}

let args = Array(CommandLine.arguments.dropFirst())
if args == ["--contract"] {
  print(contract)
  exit(0)
}
guard args.count == 1 else {
  fail("usage: outtray-ocr <image> | outtray-ocr --contract", 64)
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
request.usesLanguageCorrection = true
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
    x: clamp(b.minX), y: clamp(1 - b.maxY), width: clamp(b.width), height: clamp(b.height))
  lines.append(Line(text: text, confidence: clamp(CGFloat(candidate.confidence)), box: box))
}
let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000

let output = Output(
  contract: contract,
  engine: "vision-recognize-text",
  engineRevision: request.revision,
  elapsedMs: (elapsedMs * 10).rounded() / 10,
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
