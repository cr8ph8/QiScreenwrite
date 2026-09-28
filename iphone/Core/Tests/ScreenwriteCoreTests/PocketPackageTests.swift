import Foundation
import XCTest
@testable import ScreenwriteCore

final class PocketPackageTests: XCTestCase {
    private let a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private let b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    private let c = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

    private func fixture() -> PocketSnapshot {
        .init(id: a, development: .init(
            beats: [.init()], characters: [.init()], researchNotes: [.init()],
            world: .init(elements: [.init(id: a), .init(id: b)], links: [
                .init(id: c, elementId: a, targetType: "scene", targetRef: "  opaque / É # reference  ", targetLabel: "")
            ])))
    }

    private func payload(_ snapshot: PocketSnapshot = .init()) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(snapshot)
    }

    private func envelope(_ payload: Data) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "schema": "qicaniscreenwrite-pocket/v1", "contentEncoding": "base64-json-utf8",
            "contentSha256": PocketPackage.sha256(payload), "payloadBase64": payload.base64EncodedString()
        ], options: .sortedKeys)
    }

    private func edited(_ data: Data, path: [String], value: Any?) throws -> Data {
        func replace(_ node: Any, _ path: ArraySlice<String>) throws -> Any {
            guard let key = path.first else { return value ?? NSNull() }
            if var array = node as? [Any], let index = Int(key), array.indices.contains(index) {
                array[index] = try replace(array[index], path.dropFirst())
                return array
            }
            var object = try XCTUnwrap(node as? [String: Any])
            if path.count == 1 { object[key] = value }
            else { object[key] = try replace(XCTUnwrap(object[key]), path.dropFirst()) }
            return object
        }
        return try JSONSerialization.data(withJSONObject: replace(JSONSerialization.jsonObject(with: data), path[...]), options: .sortedKeys)
    }

    private func rejects(_ payload: Data, file: StaticString = #filePath, line: UInt = #line) throws {
        let data = try envelope(payload)
        XCTAssertThrowsError(try PocketPackage.decode(data), file: file, line: line)
        XCTAssertThrowsError(try PocketPackage.contentHash(data), file: file, line: line)
    }

    func testDefaultsAndIndependentIdentities() throws {
        let snapshot = PocketSnapshot()
        XCTAssertEqual(snapshot.title, "Untitled")
        XCTAssertNil(snapshot.targetPages)
        XCTAssertEqual(snapshot.development.world.schemaVersion, 1)
        XCTAssertEqual(snapshot.id, snapshot.id.lowercased())
        XCTAssertNotEqual(snapshot.id, PocketSnapshot().id)
        XCTAssertNotEqual(PocketBeat().id, PocketBeat().id)
        XCTAssertNotEqual(PocketCharacter().id, PocketCharacter().id)
        XCTAssertNotEqual(PocketResearchNote().id, PocketResearchNote().id)
        XCTAssertNotEqual(PocketWorldElement().id, PocketWorldElement().id)
        try snapshot.validate()
        XCTAssertEqual(try PocketPackage.decode(PocketPackage.encode(snapshot)), snapshot)
    }

    func testUnicodeAndLineEndingsRoundTripAsExactBytes() throws {
        let authored = "  café e\u{301} 🎬 👩🏽‍🚀 字 العربية\r\nINT. ROOM - NIGHT\r\n\r\nA line.\rLast\n  "
        var snapshot = fixture()
        snapshot.title = authored; snapshot.body = authored; snapshot.genre = authored
        snapshot.logline = authored; snapshot.development.concept = authored
        snapshot.development.beats[0].description = authored
        snapshot.development.characters[0].arc = authored
        snapshot.development.researchNotes[0].source = authored
        snapshot.development.world.elements[0].continuity = authored
        snapshot.development.world.links[0].targetRef = authored
        let data = try PocketPackage.encode(snapshot)
        let decoded = try PocketPackage.decode(data)
        XCTAssertEqual(decoded, snapshot)
        XCTAssertEqual(try payload(decoded), try payload(snapshot))
        XCTAssertEqual(Array(decoded.body.utf8), Array(authored.utf8))
        XCTAssertEqual(Array(decoded.development.world.links[0].targetRef.utf8), Array(authored.utf8))
        XCTAssertEqual(try PocketPackage.contentHash(data), try PocketPackage.sha256(payload(snapshot)))
    }

    func testTargetPagesIsAbsentWhenUnknownAndNeverNull() throws {
        let raw = try payload()
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: raw) as? [String: Any])
        XCTAssertFalse(object.keys.contains("targetPages"))
        XCTAssertNil(try PocketPackage.decode(envelope(raw)).targetPages)
        for invalid: Any in [NSNull(), true, false, "10", 0, -1, 1001, 1.5] {
            try rejects(edited(raw, path: ["targetPages"], value: invalid))
        }
        for pages in [1, 1000] {
            XCTAssertEqual(try PocketPackage.decode(envelope(edited(raw, path: ["targetPages"], value: pages))).targetPages, pages)
        }
    }

    func testKnownSHA256AndChecksumTampering() throws {
        XCTAssertEqual(PocketPackage.sha256(Data("abc".utf8)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        let raw = try payload()
        let data = try envelope(raw)
        let changed = try edited(raw, path: ["title"], value: "Tampered")
        let tampered = try edited(data, path: ["payloadBase64"], value: changed.base64EncodedString())
        XCTAssertThrowsError(try PocketPackage.decode(tampered))
        XCTAssertThrowsError(try PocketPackage.contentHash(tampered))
        // Checksum failure takes precedence over interpretation of malformed payload bytes.
        let malformed = try edited(data, path: ["payloadBase64"], value: Data("not JSON".utf8).base64EncodedString())
        XCTAssertThrowsError(try PocketPackage.decode(malformed)) { error in
            XCTAssertEqual((error as? PocketValidationError)?.message, "Payload checksum does not match.")
        }
    }

    func testEnvelopeRejectsUnknownMissingAndInvalidFields() throws {
        let data = try envelope(payload())
        for key in ["schema", "contentEncoding", "contentSha256", "payloadBase64"] {
            XCTAssertThrowsError(try PocketPackage.decode(edited(data, path: [key], value: nil)), key)
            XCTAssertThrowsError(try PocketPackage.decode(edited(data, path: [key], value: NSNull())), key)
        }
        for (key, value) in [("extra", "ignored?"), ("schema", "qicaniscreenwrite-pocket/v2"),
                             ("contentEncoding", "json"), ("contentSha256", String(repeating: "A", count: 64)),
                             ("contentSha256", String(repeating: "g", count: 64))] {
            XCTAssertThrowsError(try PocketPackage.decode(edited(data, path: [key], value: value)), key)
        }
    }

    func testEveryNestedObjectRejectsUnknownAndMissingFields() throws {
        let raw = try payload(fixture())
        let objects: [([String], String)] = [
            ([], "body"), (["development"], "outline"),
            (["development", "beats", "0"], "description"),
            (["development", "characters", "0"], "arc"),
            (["development", "researchNotes", "0"], "source"),
            (["development", "world"], "links"),
            (["development", "world", "elements", "0"], "continuity"),
            (["development", "world", "links", "0"], "notes")
        ]
        for (path, field) in objects {
            try rejects(edited(raw, path: path + ["unsupported"], value: "must never disappear"))
            try rejects(edited(raw, path: path + [field], value: nil))
            try rejects(edited(raw, path: path + [field], value: NSNull()))
        }
        for field in ["schemaVersion", "projectId", "draftId", "worldSources"] {
            try rejects(edited(raw, path: ["development", field], value: "not portable"))
        }
    }

    func testCanonicalBase64AndStrictUTF8() throws {
        let raw = try payload()
        let data = try envelope(raw)
        for invalid in [raw.base64EncodedString() + "\n", " " + raw.base64EncodedString(), "!!!!", "e30", "e31="] {
            XCTAssertThrowsError(try PocketPackage.decode(edited(data, path: ["payloadBase64"], value: invalid)))
        }
        try rejects(Data([0xC0, 0xAF])) // Overlong UTF-8.
        try rejects(Data([0xED, 0xA0, 0x80])) // UTF-8-encoded surrogate.
        let utf16 = try XCTUnwrap(String(data: raw, encoding: .utf8)?.data(using: .utf16))
        try rejects(utf16)
        XCTAssertThrowsError(try PocketPackage.decode(Data([0xFF])))
    }

    func testMalformedUnicodeNULAndLiteralEscapePreservation() throws {
        let raw = try XCTUnwrap(String(data: payload(), encoding: .utf8))
        for escaped in [#"\uD800"#, #"\uDC00"#, #"x\uD800y"#, #"\uDC00\uD800"#, #"\u0000"#] {
            try rejects(Data(raw.replacingOccurrences(of: #""body":"""#, with: "\"body\":\"\(escaped)\"").utf8))
        }
        let paired = Data(raw.replacingOccurrences(of: #""body":"""#, with: #""body":"\ud83c\udfac""#).utf8)
        XCTAssertEqual(try PocketPackage.decode(envelope(paired)).body, "🎬")
        let literal = PocketSnapshot(body: #"literal \uD800, not a surrogate"#)
        XCTAssertEqual(try PocketPackage.decode(PocketPackage.encode(literal)).body, literal.body)
        var invalid = fixture()
        invalid.development.world.elements[0].name = "a\0b"
        XCTAssertThrowsError(try invalid.validate())
        XCTAssertThrowsError(try PocketPackage.encode(invalid))
    }

    func testDuplicateJSONKeysAndNegativeZeroAreRejectedBeforeFoundationLosesThem() throws {
        let raw = try XCTUnwrap(String(data: payload(fixture()), encoding: .utf8))
        let duplicate = raw.replacingOccurrences(of: #""title":"Untitled""#, with: #""title":"Untitled","\u0074itle":"second""#)
        try rejects(Data(duplicate.utf8))
        for token in ["-0", "-0.0", "-0e3"] {
            try rejects(Data(raw.replacingOccurrences(of: #""order":0"#, with: "\"order\":\(token)").utf8))
        }
        let data = try XCTUnwrap(String(data: envelope(payload()), encoding: .utf8))
        let duplicateEnvelope = data.dropLast() + #", "schema":"qicaniscreenwrite-pocket/v1"}"#
        XCTAssertThrowsError(try PocketPackage.decode(Data(duplicateEnvelope.utf8)))
    }

    func testAllTextBoundsUseUTF16WithoutTruncating() throws {
        let raw = try payload(fixture())
        let groups: [([String], [String: Int])] = [
            ([], ["title": 200, "body": 200000, "genre": 120, "logline": 1000]),
            (["development"], ["concept": 4000, "logline": 1000, "synopsis": 16000, "outline": 32000, "worldNotes": 24000]),
            (["development", "beats", "0"], ["title": 200, "description": 4000]),
            (["development", "characters", "0"], ["name": 120, "role": 200, "description": 6000, "arc": 4000]),
            (["development", "researchNotes", "0"], ["title": 200, "notes": 6000, "source": 2000]),
            (["development", "world", "elements", "0"], ["name": 160, "description": 8000, "storyFunction": 4000, "sensoryDetails": 4000, "continuity": 4000]),
            (["development", "world", "links", "0"], ["targetRef": 500, "targetLabel": 500, "notes": 2000])
        ]
        for (path, fields) in groups {
            for (field, limit) in fields {
                let atLimit = String(repeating: "🎬", count: limit / 2)
                let valid = try edited(raw, path: path + [field], value: atLimit)
                XCTAssertNoThrow(try PocketPackage.decode(envelope(valid)), field)
                try rejects(edited(raw, path: path + [field], value: atLimit + "x"))
                try rejects(edited(raw, path: path + [field], value: "\0"))
                try rejects(edited(raw, path: path + [field], value: 123))
            }
        }
    }

    func testAggregateWorldAndDevelopmentBounds() throws {
        var snapshot = PocketSnapshot(development: .init(world: .init(elements:
            (0..<25).map { _ in .init(description: String(repeating: "🎬", count: 4000)) })))
        try snapshot.validate() // Exactly 200000 world UTF-16 units.
        snapshot.development.world.elements[0].name = "x"
        XCTAssertThrowsError(try snapshot.validate())
        snapshot.development.world.elements[0].name = ""
        snapshot.development.beats = (0..<50).map { _ in .init(description: String(repeating: "x", count: 4000)) }
        try snapshot.validate() // Exactly 400000 aggregate development units, including world.
        snapshot.development.beats[0].title = "x"
        XCTAssertThrowsError(try snapshot.validate())
        snapshot.development.beats[0].title = ""
        snapshot.development.world.elements[0].description.removeLast()
        snapshot.development.world.links = [.init(elementId: snapshot.development.world.elements[0].id,
            targetType: "scene", targetRef: "12", targetLabel: "")]
        try snapshot.validate() // Link references participate in both totals.
        snapshot.development.world.links[0].notes = "x"
        XCTAssertThrowsError(try snapshot.validate())
    }

    func testCollectionBounds() throws {
        var snapshot = PocketSnapshot()
        snapshot.development.beats = (0..<200).map { _ in .init() }
        snapshot.development.characters = (0..<100).map { _ in .init() }
        snapshot.development.researchNotes = (0..<100).map { _ in .init() }
        snapshot.development.world.elements = (0..<300).map { _ in .init() }
        snapshot.development.world.links = (0..<1000).map { _ in .init(
            elementId: snapshot.development.world.elements[0].id, targetType: "character", targetRef: "opaque", targetLabel: "") }
        try snapshot.validate()
        let raw = try payload(snapshot)
        for path in [["development", "beats"], ["development", "characters"], ["development", "researchNotes"],
                     ["development", "world", "elements"], ["development", "world", "links"]] {
            var node: Any = try JSONSerialization.jsonObject(with: raw)
            for key in path { node = try XCTUnwrap((node as? [String: Any])?[key]) }
            var rows = try XCTUnwrap(node as? [[String: Any]])
            var extra = try XCTUnwrap(rows.first)
            extra["id"] = UUID().uuidString
            rows.append(extra)
            try rejects(edited(raw, path: path, value: rows))
            try rejects(edited(raw, path: path, value: [:] as [String: String]))
        }
    }

    func testUUIDUniquenessMatchesDesktopNamespaces() throws {
        var snapshot = fixture()
        snapshot.development.beats = [.init(id: a)]
        snapshot.development.characters = [.init(id: a)]
        snapshot.development.researchNotes = [.init(id: a)]
        try snapshot.validate() // Reuse across separate development collections is permitted.
        var invalid = snapshot
        invalid.development.beats.append(.init(id: a.uppercased()))
        XCTAssertThrowsError(try invalid.validate())
        invalid = snapshot; invalid.development.characters.append(.init(id: a.uppercased()))
        XCTAssertThrowsError(try invalid.validate())
        invalid = snapshot; invalid.development.researchNotes.append(.init(id: a.uppercased()))
        XCTAssertThrowsError(try invalid.validate())
        invalid = snapshot; invalid.development.world.elements[1].id = a.uppercased()
        XCTAssertThrowsError(try invalid.validate())
        invalid = snapshot; invalid.development.world.links.append(invalid.development.world.links[0])
        invalid.development.world.links[1].id = c.uppercased()
        XCTAssertThrowsError(try invalid.validate())
        invalid = snapshot; invalid.development.world.links[0].id = a.uppercased()
        XCTAssertThrowsError(try invalid.validate())
        let raw = try payload(snapshot)
        for path in [["id"], ["development", "beats", "0", "id"], ["development", "characters", "0", "id"],
                     ["development", "researchNotes", "0", "id"], ["development", "world", "elements", "0", "id"],
                     ["development", "world", "links", "0", "id"]] {
            for value in ["", "not-a-uuid", a + "\n", "{" + a + "}"] {
                try rejects(edited(raw, path: path, value: value))
            }
        }
    }

    func testWorldLinksRejectForeignSelfAndBlankReferences() throws {
        var snapshot = fixture()
        snapshot.development.world.links[0].elementId = a.uppercased()
        snapshot.development.world.links[0].targetType = "element"
        snapshot.development.world.links[0].targetRef = b.uppercased()
        try snapshot.validate() // Forward, case-insensitive references preserve their original text.
        let raw = try payload(snapshot)
        for (field, value) in [("elementId", c), ("elementId", "bad"), ("targetRef", c),
                               ("targetRef", a.uppercased()), ("targetRef", "bad"), ("targetType", "project")] {
            try rejects(edited(raw, path: ["development", "world", "links", "0", field], value: value))
        }
        for type in ["scene", "character"] {
            snapshot.development.world.links[0].targetType = type
            for blank in ["", " \r\n\t", "\u{FEFF}", "\u{A0}\u{3000}"] {
                snapshot.development.world.links[0].targetRef = blank
                XCTAssertThrowsError(try snapshot.validate())
            }
            for opaque in ["  scene:12 / É # \r\n", "\u{85}", a] {
                snapshot.development.world.links[0].targetRef = opaque
                XCTAssertEqual(try PocketPackage.decode(PocketPackage.encode(snapshot)), snapshot)
            }
        }
    }

    func testEnumsAndSafeIntegerOrdering() throws {
        var snapshot = fixture()
        for format in ["", "vertical", "micro", "short", "pilot_30", "pilot_60", "feature"] {
            snapshot.projectFormat = format
            try snapshot.validate()
        }
        for type in ["character", "location", "world_rule", "faction", "timeline_note", "thematic_note", "prop", "relationship"] {
            snapshot.development.world.elements[0].type = type
            for status in ["idea", "established", "needs_review"] {
                snapshot.development.world.elements[0].status = status
                try snapshot.validate()
            }
        }
        snapshot.development.world.elements[0].order = 9007199254740991
        XCTAssertEqual(try PocketPackage.decode(PocketPackage.encode(snapshot)), snapshot)
        let raw = try payload(snapshot)
        for (path, value): ([String], Any) in [
            (["projectFormat"], "FEATURE"), (["development", "world", "schemaVersion"], true),
            (["development", "world", "schemaVersion"], 2), (["development", "world", "elements", "0", "type"], "scene"),
            (["development", "world", "elements", "0", "status"], "approved")
        ] { try rejects(edited(raw, path: path, value: value)) }
        for value: Any in [-1, 0.5, true, "1", NSNull(), 9007199254740992] {
            try rejects(edited(raw, path: ["development", "world", "elements", "0", "order"], value: value))
        }
    }

    func testExactTransportSizeBounds() throws {
        var raw = try payload()
        raw.append(Data(repeating: 32, count: 4 * 1024 * 1024 - raw.count))
        XCTAssertNoThrow(try PocketPackage.decode(envelope(raw)))
        raw.append(32)
        try rejects(raw)
        var data = try envelope(payload())
        data.append(Data(repeating: 32, count: 8 * 1024 * 1024 - data.count))
        XCTAssertNoThrow(try PocketPackage.decode(data))
        data.append(32)
        XCTAssertThrowsError(try PocketPackage.decode(data))
        XCTAssertThrowsError(try PocketPackage.contentHash(data))
    }

    func testMalformedJSONAndWrongRootTypes() throws {
        for value in ["null", "[]", "true", "{}", "{", "{}{}", "{\"a\":1,}", "[1,]",
                      String(repeating: "[", count: 40) + "0" + String(repeating: "]", count: 40)] {
            try rejects(Data(value.utf8))
            XCTAssertThrowsError(try PocketPackage.decode(Data(value.utf8)))
        }
    }
}
