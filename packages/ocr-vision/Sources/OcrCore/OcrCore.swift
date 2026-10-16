// The sidecar's output types and reading order. No Vision import, so this is
// testable on its own (`swift test`).

import Foundation

public let ocrContract = "ocr-v1"

public struct Box: Encodable, Equatable {
  public let x: Double
  public let y: Double
  public let width: Double
  public let height: Double

  /// A box normalized to the page, origin top left, each value clamped to
  /// 0...1 and rounded to 4 places (a fifth of a pixel on a 2000 px page),
  /// so recordings stay small and stable.
  public init(x: Double, y: Double, width: Double, height: Double) {
    self.x = unit(x)
    self.y = unit(y)
    self.width = unit(width)
    self.height = unit(height)
  }
}

public struct Line: Encodable, Equatable {
  public let text: String
  public let confidence: Double
  public let box: Box

  public init(text: String, confidence: Double, box: Box) {
    self.text = text
    self.confidence = unit(confidence)
    self.box = box
  }
}

public struct Page: Encodable {
  public let width: Int
  public let height: Int
  public let lines: [Line]

  public init(width: Int, height: Int, lines: [Line]) {
    self.width = width
    self.height = height
    self.lines = lines
  }
}

public struct Output: Encodable {
  public let contract: String
  public let engine: String
  public let engineRevision: Int
  public let elapsedMs: Double
  public let pages: [Page]

  public init(engine: String, engineRevision: Int, elapsedMs: Double, pages: [Page]) {
    self.contract = ocrContract
    self.engine = engine
    self.engineRevision = engineRevision
    self.elapsedMs = (elapsedMs * 10).rounded() / 10
    self.pages = pages
  }
}

func unit(_ v: Double) -> Double {
  return (min(1, max(0, v)) * 10_000).rounded() / 10_000
}

/// Reading order: rows top to bottom, left to right within a row.
///
/// Two lines share a row when each one's vertical centre falls inside the
/// other's vertical span, or when their bottoms (the baseline, roughly)
/// align. Requiring the centres both ways keeps a tall heading from
/// absorbing the small lines beside it; the baseline rule pairs a label with
/// a value set much larger on the same line. Multi-column prose still interleaves row by
/// row; RecognizeDocumentsRequest (paragraphs) is the fix for that (#160).
public func readingOrder(_ lines: [Line]) -> [Line] {
  let byTop = lines.sorted { ($0.box.y, $0.box.x) < ($1.box.y, $1.box.x) }
  var rows: [[Line]] = []
  for line in byTop {
    if let anchor = rows.last?.first, sameRow(anchor, line) {
      rows[rows.count - 1].append(line)
    } else {
      rows.append([line])
    }
  }
  return rows.flatMap { row in row.sorted { ($0.box.x, $0.box.y) < ($1.box.x, $1.box.y) } }
}

func sameRow(_ a: Line, _ b: Line) -> Bool {
  func centre(_ l: Line) -> Double { l.box.y + l.box.height / 2 }
  func bottom(_ l: Line) -> Double { l.box.y + l.box.height }
  func contains(_ l: Line, _ y: Double) -> Bool { y >= l.box.y && y <= bottom(l) }
  let mutual = contains(a, centre(b)) && contains(b, centre(a))
  // Text set in different sizes on one line shares a baseline, which the box
  // bottom approximates; a heading beside small lines shares only its top.
  let baseline = abs(bottom(a) - bottom(b)) <= min(a.box.height, b.box.height) / 2
  return mutual || baseline
}

/// The scale `--enhance` applies to an image: up to 1600 px wide when it is
/// narrower, never past 4000 px on its longer side (a long receipt photo
/// would otherwise grow without bound), never down.
public func enhanceScale(width: Int, height: Int) -> Double {
  let targetWidth = 1600.0
  let maxSide = 4000.0
  guard width > 0, height > 0, Double(width) < targetWidth else { return 1 }
  let scale = min(targetWidth / Double(width), maxSide / Double(max(width, height)))
  return max(1, scale)
}
