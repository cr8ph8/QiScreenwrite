import Foundation

public enum ScreenplayElement: String, CaseIterable, Sendable {
    case scene, action, character, dialogue, parenthetical, transition, title, note
}

public struct ScreenplayPage: Equatable, Sendable {
    public let number: Int
    /// UTF-16 range in the original source, including all markup and line endings.
    public let sourceRange: NSRange
    public let text: String

    public init(number: Int, sourceRange: NSRange, text: String) {
        self.number = number
        self.sourceRange = sourceRange
        self.text = text
    }
}

public struct ScreenplayLine: Equatable, Sendable {
    /// Includes the original line terminator, if present.
    public let sourceRange: NSRange
    /// Excludes the terminator and any forcing/title-key prefix (including indentation
    /// before that prefix). All remaining whitespace and inline markup are retained.
    public let contentRange: NSRange
    public let element: ScreenplayElement

    public init(sourceRange: NSRange, contentRange: NSRange, element: ScreenplayElement) {
        self.sourceRange = sourceRange
        self.contentRange = contentRange
        self.element = element
    }
}

/// Source-preserving editing pages, estimated at US Letter / 12-point Courier.
/// This is not a print renderer: each grapheme counts as one column, source blank
/// lines consume space, and no (MORE), repeated cues, or other text is inserted.
public enum ScreenplayPagination {
    /// Always returns at least one page. Nonempty page spans are contiguous and
    /// concatenate to the exact source, including title pages, notes, and boneyards.
    /// A line containing only three or more '=' characters forces a break AFTER
    /// that line; its source belongs to the preceding page. No trailing empty page
    /// is created. Breaks inside notes/boneyards are ordinary source text.
    public static func pages(in source: String) -> [ScreenplayPage] {
        guard !source.isEmpty else {
            return [.init(number: 1, sourceRange: NSRange(location: 0, length: 0), text: "")]
        }
        let units = groupedUnits(classify(source))
        let original = source as NSString
        var pages: [ScreenplayPage] = []
        var pageStart = 0
        var pageEnd = 0
        var used = 0

        func finishPage() {
            guard pageEnd > pageStart else { return }
            let range = NSRange(location: pageStart, length: pageEnd - pageStart)
            pages.append(.init(number: pages.count + 1, sourceRange: range, text: original.substring(with: range)))
            pageStart = pageEnd
            used = 0
        }

        for unit in units {
            if unit.isBreak {
                pageEnd = NSMaxRange(unit.rows[unit.rows.count - 1].range)
                finishPage()
                continue
            }
            let minimum = minimumStart(unit.rows)
            // Prefer intact paragraphs/speeches when they fit on a fresh page.
            if used > 0 && unit.rows.count > lineBudget - used &&
                (unit.rows.count <= lineBudget || minimum > lineBudget - used) {
                finishPage()
            }
            var offset = 0
            while offset < unit.rows.count {
                if used == lineBudget { finishPage() }
                let available = lineBudget - used
                let remaining = unit.rows.count - offset
                var take = min(available, remaining)
                if take < remaining {
                    let floor = offset == 0 ? min(minimum, take) : 1
                    var preferred = take
                    // Keep a cue/parenthetical with speech where the budget permits.
                    while preferred > floor &&
                        (isLeadIn(unit.rows[offset + preferred - 1].element) ||
                         unit.rows[offset + preferred].element == .parenthetical) {
                        preferred -= 1
                    }
                    if !isLeadIn(unit.rows[offset + preferred - 1].element) &&
                        unit.rows[offset + preferred].element != .parenthetical {
                        take = preferred
                    }
                    if remaining - take == 1 && take > max(floor, 2) &&
                        !isLeadIn(unit.rows[offset + take - 2].element) {
                        take -= 1
                    }
                }
                pageEnd = NSMaxRange(unit.rows[offset + take - 1].range)
                used += take
                offset += take
                if offset < unit.rows.count { finishPage() }
            }
        }
        finishPage()
        return pages
    }

    /// Classify the FULL draft before intersecting ranges with pages: a page alone
    /// cannot recover the cue for dialogue continued from the preceding page.
    /// Includes blank lines and a zero-length final line after a terminal newline;
    /// empty input has one zero-length action line. All offsets are UTF-16.
    public static func lines(in source: String) -> [ScreenplayLine] {
        classify(source).map(\.line)
    }

    private static let lineBudget = 55
    private static let titleKeys: Set<String> = [
        "title", "credit", "author", "authors", "source", "draft date", "date",
        "contact", "copyright", "notes"
    ]

    private struct PhysicalLine {
        let range: NSRange
        let body: String
        let syntaxStart: String.Index
        let trimmed: String

        init(range: NSRange, body: String) {
            self.range = range
            self.body = body
            syntaxStart = body.firstIndex { !$0.isWhitespace && !(range.location == 0 && $0 == "\u{FEFF}") } ?? body.endIndex
            trimmed = String(body[syntaxStart...]).trimmingCharacters(in: .whitespaces)
        }

        func content(after prefixEnd: String.Index? = nil) -> NSRange {
            let offset = prefixEnd.map { body[..<$0].utf16.count } ?? 0
            return NSRange(location: range.location + offset, length: body.utf16.count - offset)
        }
    }

    private struct ClassifiedLine {
        let physical: PhysicalLine
        let line: ScreenplayLine
        let isBreak: Bool
        var isBlank: Bool { physical.trimmed.isEmpty }
    }

    private static func physicalLines(_ source: String) -> [PhysicalLine] {
        var result: [PhysicalLine] = []
        var start = source.startIndex
        var startOffset = 0
        var offset = 0
        // Character iteration treats CRLF and extended graphemes as indivisible.
        for index in source.indices {
            let character = source[index]
            let end = source.index(after: index)
            offset += String(character).utf16.count
            if character.isNewline {
                result.append(.init(range: NSRange(location: startOffset, length: offset - startOffset), body: String(source[start..<index])))
                start = end
                startOffset = offset
            }
        }
        result.append(.init(range: NSRange(location: startOffset, length: offset - startOffset), body: String(source[start...])))
        return result
    }

    private static func classify(_ source: String) -> [ClassifiedLine] {
        let physical = physicalLines(source)
        var result: [ClassifiedLine] = []
        var titlePage = true
        var sawTitleKey = false
        var speech = false
        var annotationEnd: String?

        for (index, raw) in physical.enumerated() {
            let text = raw.trimmed
            var element: ScreenplayElement = .action
            var content = raw.content()
            var pageBreak = false
            let paragraphStart = index == 0 || result.last?.isBlank == true || result.last?.isBreak == true || result.last?.line.element == .scene

            if containsAnnotation(raw.body, closing: &annotationEnd) {
                element = .note
                titlePage = false
                speech = false
            } else if text.isEmpty {
                speech = false
                if sawTitleKey { titlePage = false }
            } else if titlePage, let colon = raw.body[raw.syntaxStart...].firstIndex(of: ":"),
                      titleKeys.contains(raw.body[raw.syntaxStart..<colon].trimmingCharacters(in: .whitespaces).lowercased()) {
                element = .title
                sawTitleKey = true
                content = raw.content(after: raw.body.index(after: colon))
            } else if titlePage && sawTitleKey && raw.body.first?.isWhitespace == true {
                element = .title
            } else {
                titlePage = false
                let marker = raw.body[raw.syntaxStart...].first
                if isPageBreak(text) {
                    pageBreak = true
                    speech = false
                } else if marker == "!" {
                    element = .action
                    content = raw.content(after: raw.body.index(after: raw.syntaxStart))
                    speech = false
                } else if marker == "@" {
                    element = .character
                    content = raw.content(after: raw.body.index(after: raw.syntaxStart))
                    speech = true
                } else if isForcedHeading(text) {
                    element = .scene
                    content = raw.content(after: raw.body.index(after: raw.syntaxStart))
                    speech = false
                } else if marker == ">" {
                    element = .transition
                    content = raw.content(after: raw.body.index(after: raw.syntaxStart))
                    speech = false
                } else if paragraphStart && isHeading(text) {
                    element = .scene
                    speech = false
                } else if paragraphStart && isTransition(text) {
                    element = .transition
                    speech = false
                } else if speech {
                    element = text.hasPrefix("(") && text.hasSuffix(")") ? .parenthetical : .dialogue
                } else if paragraphStart && isCue(text) && index + 1 < physical.count && canFollowCue(physical[index + 1].trimmed) {
                    element = .character
                    speech = true
                }
            }
            result.append(.init(physical: raw, line: .init(sourceRange: raw.range, contentRange: content, element: element), isBreak: pageBreak))
        }
        return result
    }

    private static func isPageBreak(_ text: String) -> Bool {
        text.count >= 3 && text.allSatisfy { $0 == "=" }
    }

    private static func isForcedHeading(_ text: String) -> Bool {
        text.first == "." && !text.hasPrefix("..")
    }

    private static func isHeading(_ text: String) -> Bool {
        text.range(of: "^(INT\\.?/EXT\\.?|EXT\\.?/INT\\.?|INT|EXT|EST|I/E)(\\.|\\s)", options: [.regularExpression, .caseInsensitive]) != nil
    }

    private static func isTransition(_ text: String) -> Bool {
        text == text.uppercased() && text.hasSuffix("TO:")
    }

    private static func isCue(_ text: String) -> Bool {
        // Unforced ALL CAPS is ambiguous. Require a paragraph start, following
        // speech, a short cue, and no sentence-ending punctuation. Use ! to force
        // uppercase action and @ for cues that do not satisfy this heuristic.
        text.count <= 60 && text == text.uppercased() && text != text.lowercased() &&
            !(text.last.map { ".!?:".contains($0) } ?? false)
    }

    private static func canFollowCue(_ text: String) -> Bool {
        !text.isEmpty && !isPageBreak(text) && !isHeading(text) && !isTransition(text) &&
            !isForcedHeading(text) && !text.hasPrefix("!") && !text.hasPrefix("@") &&
            !text.hasPrefix(">") && !text.hasPrefix("[[") && !text.hasPrefix("/*")
    }

    /// Notes/boneyards remain visible. A line containing an inline annotation is
    /// styled as a whole note line; this deliberately avoids a full inline parser.
    private static func containsAnnotation(_ text: String, closing: inout String?) -> Bool {
        var cursor = text.startIndex
        var found = closing != nil
        while cursor < text.endIndex {
            if let endToken = closing {
                guard let end = text.range(of: endToken, range: cursor..<text.endIndex) else { break }
                cursor = end.upperBound
                closing = nil
            } else {
                let note = text.range(of: "[[", range: cursor..<text.endIndex)
                let boneyard = text.range(of: "/*", range: cursor..<text.endIndex)
                guard let start = [note, boneyard].compactMap({ $0 }).min(by: { $0.lowerBound < $1.lowerBound }) else { break }
                closing = String(text[start]) == "[[" ? "]]" : "*/"
                found = true
                cursor = start.upperBound
            }
        }
        return found
    }

    private struct Row {
        let range: NSRange
        let element: ScreenplayElement
        let isBlank: Bool
    }

    private struct Unit {
        var rows: [Row]
        let isBreak: Bool
        let isBlank: Bool
    }

    private static func width(_ element: ScreenplayElement) -> Int {
        switch element {
        case .character: return 38
        case .dialogue: return 35
        case .parenthetical: return 25
        default: return 60
        }
    }

    private static func rows(_ line: ClassifiedLine) -> [Row] {
        let characters = Array(line.physical.body)
        var offsets = [0]
        for character in characters { offsets.append(offsets[offsets.count - 1] + String(character).utf16.count) }
        if characters.isEmpty || line.isBreak {
            return [.init(range: line.line.sourceRange, element: line.line.element, isBlank: line.isBlank)]
        }
        var result: [Row] = []
        var start = 0
        while start < characters.count {
            var end = min(start + width(line.line.element), characters.count)
            if end < characters.count, let space = (start..<end).last(where: { characters[$0].isWhitespace }) {
                end = space + 1
            }
            let lower = line.line.sourceRange.location + offsets[start]
            // Attach the physical terminator to the final wrapped row, never split it.
            let upper = end == characters.count ? NSMaxRange(line.line.sourceRange) : line.line.sourceRange.location + offsets[end]
            result.append(.init(range: NSRange(location: lower, length: upper - lower), element: line.line.element, isBlank: line.isBlank))
            start = end
        }
        return result
    }

    private static func groupedUnits(_ lines: [ClassifiedLine]) -> [Unit] {
        var paragraphs: [Unit] = []
        for line in lines where line.line.sourceRange.length > 0 {
            let wrapped = rows(line)
            if !line.isBreak && !line.isBlank, let previous = paragraphs.last,
               !previous.isBreak && !previous.isBlank,
               let first = previous.rows.first?.element,
               ((first == .character && [.dialogue, .parenthetical].contains(line.line.element)) ||
                (first == line.line.element && [.action, .title, .note, .dialogue].contains(first))) {
                paragraphs[paragraphs.count - 1].rows.append(contentsOf: wrapped)
            } else {
                paragraphs.append(.init(rows: wrapped, isBreak: line.isBreak, isBlank: line.isBlank))
            }
        }
        var units: [Unit] = []
        var index = 0
        while index < paragraphs.count {
            var unit = paragraphs[index]
            index += 1
            if unit.rows.first?.element == .scene {
                var next = index
                while next < paragraphs.count && paragraphs[next].isBlank { next += 1 }
                if next < paragraphs.count && !paragraphs[next].isBreak && paragraphs[next].rows.first?.element != .scene {
                    for following in paragraphs[index...next] { unit.rows.append(contentsOf: following.rows) }
                    index = next + 1
                }
            }
            units.append(unit)
        }
        return units
    }

    private static func isLeadIn(_ element: ScreenplayElement) -> Bool {
        element == .scene || element == .character || element == .parenthetical
    }

    private static func minimumStart(_ rows: [Row]) -> Int {
        let content = rows.firstIndex { !$0.isBlank && !isLeadIn($0.element) } ?? rows.count
        return min(lineBudget, min(rows.count, content + 2))
    }
}
