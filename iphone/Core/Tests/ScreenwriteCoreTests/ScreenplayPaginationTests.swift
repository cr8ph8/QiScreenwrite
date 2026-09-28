import Foundation
import XCTest
@testable import ScreenwriteCore

final class ScreenplayPaginationTests: XCTestCase {
    private func verifyLossless(_ source: String, file: StaticString = #filePath, line: UInt = #line) {
        let pages = ScreenplayPagination.pages(in: source)
        XCTAssertFalse(pages.isEmpty, file: file, line: line)
        // Swift String equality is canonically equivalent; compare bytes as well.
        XCTAssertEqual(Data(pages.map(\.text).joined().utf8), Data(source.utf8), file: file, line: line)
        let original = source as NSString
        var boundaries: Set<Int> = [0]
        var end = 0
        for character in source {
            end += String(character).utf16.count
            boundaries.insert(end)
        }
        var offset = 0
        for (index, page) in pages.enumerated() {
            XCTAssertEqual(page.number, index + 1, file: file, line: line)
            XCTAssertEqual(page.sourceRange.location, offset, file: file, line: line)
            XCTAssertTrue(boundaries.contains(offset), file: file, line: line)
            XCTAssertTrue(boundaries.contains(NSMaxRange(page.sourceRange)), file: file, line: line)
            XCTAssertEqual(Data(page.text.utf8), Data(original.substring(with: page.sourceRange).utf8), file: file, line: line)
            if !source.isEmpty { XCTAssertGreaterThan(page.sourceRange.length, 0, file: file, line: line) }
            offset = NSMaxRange(page.sourceRange)
        }
        XCTAssertEqual(offset, original.length, file: file, line: line)
        offset = 0
        for classified in ScreenplayPagination.lines(in: source) {
            XCTAssertEqual(classified.sourceRange.location, offset, file: file, line: line)
            XCTAssertTrue(boundaries.contains(offset), file: file, line: line)
            XCTAssertTrue(boundaries.contains(NSMaxRange(classified.sourceRange)), file: file, line: line)
            XCTAssertTrue(boundaries.contains(classified.contentRange.location), file: file, line: line)
            XCTAssertTrue(boundaries.contains(NSMaxRange(classified.contentRange)), file: file, line: line)
            XCTAssertGreaterThanOrEqual(classified.contentRange.location, offset, file: file, line: line)
            XCTAssertLessThanOrEqual(NSMaxRange(classified.contentRange), NSMaxRange(classified.sourceRange), file: file, line: line)
            offset = NSMaxRange(classified.sourceRange)
        }
        XCTAssertEqual(offset, original.length, file: file, line: line)
    }

    func testEmptyInputAndTerminalInsertionLine() {
        XCTAssertEqual(ScreenplayPagination.pages(in: ""), [.init(number: 1, sourceRange: NSRange(location: 0, length: 0), text: "")])
        XCTAssertEqual(ScreenplayPagination.lines(in: ""), [.init(sourceRange: NSRange(location: 0, length: 0), contentRange: NSRange(location: 0, length: 0), element: .action)])
        XCTAssertEqual(ScreenplayPagination.lines(in: "Hi\r\n").map(\.sourceRange), [NSRange(location: 0, length: 4), NSRange(location: 4, length: 0)])
        XCTAssertEqual(ScreenplayPagination.lines(in: "Hi\r\n").first?.contentRange, NSRange(location: 0, length: 2))
        for source in ["", "\n", "\r\n", "\r", "\n\n", "no final newline", "  \t"] { verifyLossless(source) }
    }

    func testPreservesTitleNotesBoneyardsBOMAndMixedLineEndings() {
        let source = "\u{FEFF}Title: Synthetic test\r\n    Continued title\rAuthor: Nobody\n\n[[A note\n===\nends here]]\r\n/* deleted scene\rINT. HIDDEN - DAY\n===\n*/\n\nINT. ROOM - DAY\r\n\r\nÉVA\r\nHello 🎬.\n"
        verifyLossless(source)
        let lines = ScreenplayPagination.lines(in: source)
        XCTAssertEqual(lines.first?.element, .title)
        let noteLines = lines.filter { $0.element == .note }
        XCTAssertEqual(noteLines.count, 7)
        XCTAssertEqual(ScreenplayPagination.pages(in: source).count, 1)
        XCTAssertEqual(lines.filter { $0.element == .scene }.count, 1)
    }

    func testLongActionSplitsAtWhitespaceAndPreservesUnicodeBytes() {
        let source = "!" + String(repeating: "e\u{301} 👨‍👩‍👧‍👦 🇺🇸 🧑🏽‍🚀 cafe\u{301} \t", count: 1_100)
        let pages = ScreenplayPagination.pages(in: source)
        XCTAssertGreaterThan(pages.count, 2)
        for page in pages.dropLast() { XCTAssertTrue(page.text.last?.isWhitespace == true) }
        verifyLossless(source)
    }

    func testUnbrokenGraphemesHardWrapWithoutLoss() {
        let source = "!" + String(repeating: "👨‍👩‍👧‍👦e\u{301}", count: 4_000)
        XCTAssertGreaterThan(ScreenplayPagination.pages(in: source).count, 2)
        verifyLossless(source)
    }

    func testLongDialogueSplitsAndUsesNarrowerBudgetThanAction() {
        let content = String(repeating: "spoken words 🎬 e\u{301} ", count: 700)
        let dialogue = "@Éva\r\n(quietly)\r\n" + content
        let action = "!" + content
        let pages = ScreenplayPagination.pages(in: dialogue)
        XCTAssertGreaterThan(pages.count, 2)
        XCTAssertGreaterThan(pages.count, ScreenplayPagination.pages(in: action).count)
        XCTAssertTrue(pages[0].text.hasPrefix("@Éva\r\n(quietly)\r\nspoken"))
        XCTAssertFalse(pages.map(\.text).joined().contains("(MORE)"))
        verifyLossless(dialogue)
        verifyLossless(action)
    }

    func testExplicitBreakIsRetainedOnPrecedingPage() {
        let source = "!First.\r\n  ===  \r\n!Second.\n====\n!Third."
        XCTAssertEqual(ScreenplayPagination.pages(in: source).map(\.text), ["!First.\r\n  ===  \r\n", "!Second.\n====\n", "!Third."])
        XCTAssertEqual(ScreenplayPagination.pages(in: "===\n===\n").map(\.text), ["===\n", "===\n"])
        XCTAssertEqual(ScreenplayPagination.pages(in: "===").map(\.text), ["==="])
        XCTAssertEqual(ScreenplayPagination.pages(in: "!Contains === inline\n==\n").count, 1)
        for text in [source, "===\n===\n", "===", "===\r\n!Next"] { verifyLossless(text) }
    }

    func testSceneHeadingMovesWithFollowingActionOrSpeech() {
        let filler = String(repeating: "!A short action.\n", count: 53) + "\n"
        for next in ["!She opens the door.\n", "@Éva\n(quietly)\nHello there.\n"] {
            let tail = "INT. ROOM - DAY\n\n" + next
            let source = filler + tail
            let pages = ScreenplayPagination.pages(in: source)
            XCTAssertEqual(pages.count, 2)
            XCTAssertEqual(pages[0].text, filler)
            XCTAssertEqual(pages[1].text, tail)
            verifyLossless(source)
        }
    }

    func testCueAndParentheticalStayWithSpeechAtPageBottom() {
        let filler = String(repeating: "!Action.\n", count: 52) + "\n"
        let speech = "@Éva\n(whispering)\nCome with me.\n"
        XCTAssertEqual(ScreenplayPagination.pages(in: filler + speech).map(\.text), [filler, speech])
        let longSpeech = "@Éva\n(whispering)\n" + String(repeating: "Come with me. ", count: 500)
        let pages = ScreenplayPagination.pages(in: filler + longSpeech)
        XCTAssertEqual(pages[0].text, filler)
        XCTAssertTrue(pages[1].text.hasPrefix("@Éva\n(whispering)\nCome"))
        verifyLossless(filler + longSpeech)
    }

    func testParagraphBoundaryPreferredOverFillingEveryPage() {
        let first = String(repeating: "!First paragraph line.\n", count: 35) + "\n"
        let second = String(repeating: "!Second paragraph line.\n", count: 25)
        XCTAssertEqual(ScreenplayPagination.pages(in: first + second).map(\.text), [first, second])
    }

    func testForcingPrefixesAndTitleContinuationKeepContentWhitespace() {
        let source = "Title:  My title  \r\n    A continuation  \r\nAuthor: Me\r\n\r\n!LOUD ACTION  \n\n@Éva\n(softly)\nHello.  \n\n.forced scene\n\n> CUT TO:  "
        let lines = ScreenplayPagination.lines(in: source)
        XCTAssertEqual(lines.map(\.element), [.title, .title, .title, .action, .action, .action, .character, .parenthetical, .dialogue, .action, .scene, .action, .transition])
        let text = source as NSString
        XCTAssertEqual(text.substring(with: lines[0].contentRange), "  My title  ")
        XCTAssertEqual(text.substring(with: lines[1].contentRange), "    A continuation  ")
        XCTAssertEqual(text.substring(with: lines[4].contentRange), "LOUD ACTION  ")
        XCTAssertEqual(text.substring(with: lines[6].contentRange), "Éva")
        XCTAssertEqual(text.substring(with: lines[8].contentRange), "Hello.  ")
        XCTAssertEqual(text.substring(with: lines[10].contentRange), "forced scene")
        XCTAssertEqual(text.substring(with: lines[12].contentRange), " CUT TO:  ")
        verifyLossless(source)
    }

    func testFiftyFiveLineBudgetAndLongParagraphRemainder() {
        let page = String(repeating: "!Action.\r\n", count: 55)
        XCTAssertEqual(ScreenplayPagination.pages(in: page).map(\.text), [page])
        let pages = ScreenplayPagination.pages(in: page + "!Next.\r\n")
        XCTAssertEqual(pages.count, 2)
        // Avoid leaving only one line of a long paragraph on the second page.
        XCTAssertEqual(pages[0].text, String(repeating: "!Action.\r\n", count: 54))
        XCTAssertEqual(pages[1].text, "!Action.\r\n!Next.\r\n")
        verifyLossless(page + "!Next.\r\n")
    }

    func testHeadingWithOversizedActionStartsOnFreshPage() {
        let filler = String(repeating: "!Action.\n", count: 52) + "\n"
        let tail = "INT. ROOM - DAY\n\n!" + String(repeating: "Long action follows. ", count: 600)
        let pages = ScreenplayPagination.pages(in: filler + tail)
        XCTAssertEqual(pages.first?.text, filler)
        XCTAssertTrue(pages[1].text.hasPrefix("INT. ROOM - DAY\n\n!Long action follows."))
        verifyLossless(filler + tail)
    }

    func testUppercaseCueRequiresParagraphAndFollowingSpeech() {
        let source = "INT. ROOM - DAY\n\nÉVA (V.O.)\n(softly)\nI am here.\nSTILL SPEAKING\n\nTHE DOOR SLAMS.\nDust falls.\n\nLONELY UPPERCASE\n\nA paragraph starts.\nUPPERCASE INSIDE ACTION\nAnother action.\n\nCUT TO:\n\nEXT. STREET - DAY\n\nAUTHOR: is action here"
        let lines = ScreenplayPagination.lines(in: source)
        let elements = lines.filter { $0.contentRange.length > 0 }.map(\.element)
        XCTAssertEqual(elements, [.scene, .character, .parenthetical, .dialogue, .dialogue, .action, .action, .action, .action, .action, .action, .transition, .scene, .action])
        verifyLossless(source)
    }

    func testDeterministicMixedSourceCoverageAtManyPageBoundaries() {
        let chunks = ["!e\u{301} 🎬\r\n", "\r\n", "@Éva\n", "(thinking)\n", "Hello 👩🏽‍🚀.\n", "===\r\n", "[[note]]\n", "/*\n", "===\n", "*/\n", ".Room\n", "\u{2028}", "\u{2029}", "\r", "!"]
        for seed in 0..<12 {
            var state = UInt64(seed + 1)
            var source = ""
            for _ in 0..<450 {
                state = state &* 6_364_136_223_846_793_005 &+ 1
                source += chunks[Int((state >> 32) % UInt64(chunks.count))]
            }
            verifyLossless(source)
        }
    }
}
