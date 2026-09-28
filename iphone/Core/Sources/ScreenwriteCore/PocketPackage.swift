import Foundation
import CoreFoundation
import CryptoKit

public struct PocketValidationError: Error, LocalizedError, Equatable, Sendable {
    public let message: String
    public var errorDescription: String? { message }
}

public struct PocketRecordReference: Codable, Equatable, Sendable {
    public var id: String
    public var version: Int
    public var sha256: String
    public init(id: String, version: Int, sha256: String) {
        self.id = id; self.version = version; self.sha256 = sha256
    }
}

/// An exact Mac-issued base, never a shared version counter or authority grant.
public struct PocketContinuation: Codable, Equatable, Sendable {
    public var exchangeId: String
    public var projectId: String
    public var draft: PocketRecordReference
    public var development: PocketRecordReference
    public init(exchangeId: String, projectId: String, draft: PocketRecordReference, development: PocketRecordReference) {
        self.exchangeId = exchangeId; self.projectId = projectId; self.draft = draft; self.development = development
    }
}

public struct PocketTransfer: Sendable {
    public var snapshot: PocketSnapshot
    public var continuation: PocketContinuation?
}

/// Portable creative snapshots only. A checksum establishes byte integrity, not authorship.
public enum PocketPackage {
    private static let envelopeLimit = 8 * 1024 * 1024
    private static let payloadLimit = 4 * 1024 * 1024
    private static let schema = "qicaniscreenwrite-pocket/v1"
    private static let linkedSchema = "qicaniscreenwrite-pocket/v2"
    private static let encoding = "base64-json-utf8"
    private struct LinkedPayload: Codable {
        var snapshot: PocketSnapshot
        var continuation: PocketContinuation
    }

    public static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    public static func encode(_ snapshot: PocketSnapshot) throws -> Data {
        let payload = try validatedPayloadData(snapshot)
        return try envelope(payload, schema: schema)
    }

    public static func encodeContinuation(_ snapshot: PocketSnapshot, continuation: PocketContinuation) throws -> Data {
        try snapshot.validate()
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let payload = try encoder.encode(LinkedPayload(snapshot: snapshot, continuation: continuation))
        try require(payload.count <= payloadLimit, "Payload exceeds 4 MiB.")
        try PocketValidation.linked(PocketValidation.json(payload))
        return try envelope(payload, schema: linkedSchema)
    }

    public static func validateContinuation(_ continuation: PocketContinuation) throws {
        let data = try JSONEncoder().encode(continuation)
        try PocketValidation.continuation(PocketValidation.json(data))
    }

    private static func envelope(_ payload: Data, schema: String) throws -> Data {
        let envelope = ["schema": schema, "contentEncoding": encoding,
                        "contentSha256": sha256(payload), "payloadBase64": payload.base64EncodedString()]
        let data = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys, .withoutEscapingSlashes])
        try require(data.count <= envelopeLimit, "Package exceeds 8 MiB.")
        return data
    }

    public static func decode(_ data: Data) throws -> PocketSnapshot {
        try decodeTransfer(data).snapshot
    }

    public static func decodeTransfer(_ data: Data) throws -> PocketTransfer {
        let envelope = try validatedEnvelope(data)
        if envelope.linked {
            let payload = try JSONDecoder().decode(LinkedPayload.self, from: envelope.payload)
            return .init(snapshot: payload.snapshot, continuation: payload.continuation)
        }
        return .init(snapshot: try JSONDecoder().decode(PocketSnapshot.self, from: envelope.payload), continuation: nil)
    }

    public static func contentHash(_ data: Data) throws -> String {
        try validatedEnvelope(data).hash
    }

    static func validatedPayloadData(_ snapshot: PocketSnapshot) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let payload = try encoder.encode(snapshot)
        try require(payload.count <= payloadLimit, "Payload exceeds 4 MiB.")
        try PocketValidation.snapshot(PocketValidation.json(payload))
        return payload
    }

    private static func validatedEnvelope(_ data: Data) throws -> (payload: Data, hash: String, linked: Bool) {
        try require(data.count <= envelopeLimit, "Package exceeds 8 MiB.")
        let envelope = try PocketValidation.shape(PocketValidation.json(data),
            ["schema", "contentEncoding", "contentSha256", "payloadBase64"], "Envelope")
        let linked = envelope["schema"] as? String == linkedSchema
        try require(linked || envelope["schema"] as? String == schema, "Unsupported package schema.")
        try require(envelope["contentEncoding"] as? String == encoding, "Unsupported content encoding.")
        guard let hash = envelope["contentSha256"] as? String,
              hash.utf8.count == 64, hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
        else { throw invalid("Expected a lowercase SHA256 checksum.") }
        guard let base64 = envelope["payloadBase64"] as? String,
              base64.utf8.count <= ((payloadLimit + 2) / 3) * 4,
              let payload = Data(base64Encoded: base64), payload.count <= payloadLimit,
              payload.base64EncodedString() == base64
        else { throw invalid("Payload must be canonical base64 within 4 MiB.") }
        // Hash the exact received bytes before parsing or decoding their content.
        try require(sha256(payload) == hash, "Payload checksum does not match.")
        let value = try PocketValidation.json(payload)
        if linked { try PocketValidation.linked(value) } else { try PocketValidation.snapshot(value) }
        return (payload, hash, linked)
    }
}

private func invalid(_ message: String) -> PocketValidationError { .init(message: message) }
private func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw invalid(message) }
}

private enum PocketValidation {
    static func json(_ data: Data) throws -> Any {
        try require(String(data: data, encoding: .utf8) != nil, "JSON must contain valid UTF-8.")
        var preflight = JSONPreflight(bytes: Array(data))
        try preflight.check()
        // Foundation also rejects malformed JSON, unescaped controls and lone UTF-16 surrogates.
        return try JSONSerialization.jsonObject(with: data)
    }

    static func shape(_ value: Any?, _ keys: Set<String>, _ path: String,
                      optional: Set<String> = []) throws -> [String: Any] {
        guard let object = value as? [String: Any] else { throw invalid("\(path) must be an object.") }
        let actual = Set(object.keys)
        try require(keys.isSubset(of: actual) && actual.isSubset(of: keys.union(optional)),
                    "\(path) has unsupported or missing fields.")
        return object
    }

    static func text(_ value: Any?, _ limit: Int, _ path: String) throws -> String {
        guard let value = value as? String, !value.contains("\0"), value.utf16.count <= limit
        else { throw invalid("\(path) must be text of at most \(limit) UTF-16 units without NUL.") }
        return value
    }

    static func integer(_ value: Any?, _ range: ClosedRange<Int>, _ path: String) throws {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
            throw invalid("\(path) must be an integer.")
        }
        let n = number.doubleValue
        try require(n.isFinite && n.rounded(.towardZero) == n && n >= Double(range.lowerBound)
                    && n <= Double(range.upperBound), "\(path) is outside its integer bounds.")
    }

    static func uuid(_ value: Any?, _ path: String) throws -> String {
        guard let id = value as? String else { throw invalid("\(path) must be a UUID.") }
        let bytes = Array(id.utf8)
        try require(bytes.count == 36 && bytes.enumerated().allSatisfy { index, byte in
            if [8, 13, 18, 23].contains(index) { return byte == 45 }
            return (48...57).contains(byte) || (65...70).contains(byte) || (97...102).contains(byte)
        }, "\(path) must be a UUID.")
        return id.lowercased()
    }

    static func choice(_ value: Any?, _ choices: Set<String>, _ path: String) throws {
        guard let value = value as? String, choices.contains(value) else {
            throw invalid("\(path) has an unsupported value.")
        }
    }

    static func list(_ value: Any?, _ limit: Int, _ path: String) throws -> [Any] {
        guard let rows = value as? [Any], rows.count <= limit else {
            throw invalid("\(path) must be an array with at most \(limit) rows.")
        }
        return rows
    }

    static func fields(_ object: [String: Any], _ limits: [String: Int], _ path: String) throws -> Int {
        var total = 0
        for (field, limit) in limits { total += try text(object[field], limit, "\(path).\(field)").utf16.count }
        return total
    }

    static func continuation(_ value: Any, snapshotID: String? = nil) throws {
        let item = try shape(value, ["exchangeId", "projectId", "draft", "development"], "Continuation")
        _ = try uuid(item["exchangeId"], "Continuation.exchangeId")
        let project = try text(item["projectId"], 160, "Continuation.projectId")
        try require(project.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$", options: .regularExpression) != nil, "Invalid originating project.")
        var suffix: String?
        for (field, prefix) in [("draft", "screenplay-draft:"), ("development", "story-development:")] {
            let ref = try shape(item[field], ["id", "version", "sha256"], "Continuation.\(field)")
            let id = try text(ref["id"], 160, "Continuation record ID")
            try require(id.hasPrefix(prefix), "Invalid continuation record kind.")
            let uuidText = String(id.dropFirst(prefix.count))
            _ = try uuid(uuidText, "Continuation record ID")
            if let previous = suffix { try require(uuidText == previous, "Continuation records do not share a draft identity.") }
            suffix = uuidText
            if let snapshotID { try require(uuidText == snapshotID, "Continuation does not match the screenplay identity.") }
            try integer(ref["version"], 1...2147483646, "Continuation version")
            let hash = try text(ref["sha256"], 64, "Continuation checksum")
            try require(hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil, "Invalid continuation checksum.")
        }
    }

    static func linked(_ value: Any) throws {
        let payload = try shape(value, ["snapshot", "continuation"], "Linked payload")
        guard let snapshotValue = payload["snapshot"] as? [String: Any], let id = snapshotValue["id"] as? String else { throw invalid("Missing linked screenplay.") }
        try snapshot(snapshotValue)
        try continuation(payload["continuation"]!, snapshotID: id)
    }

    static func snapshot(_ value: Any) throws {
        let snapshot = try shape(value, ["id", "title", "body", "genre", "logline", "projectFormat", "development"],
                                 "Snapshot", optional: ["targetPages"])
        _ = try uuid(snapshot["id"], "Snapshot.id")
        _ = try fields(snapshot, ["title": 200, "body": 200000, "genre": 120, "logline": 1000], "Snapshot")
        try choice(snapshot["projectFormat"], ["", "vertical", "micro", "short", "pilot_30", "pilot_60", "feature"],
                   "Snapshot.projectFormat")
        if let pages = snapshot["targetPages"] { try integer(pages, 1...1000, "Snapshot.targetPages") }
        let development = try shape(snapshot["development"],
            ["concept", "logline", "synopsis", "outline", "beats", "characters", "worldNotes", "researchNotes", "world"], "Development")
        var total = try fields(development,
            ["concept": 4000, "logline": 1000, "synopsis": 16000, "outline": 32000, "worldNotes": 24000], "Development")
        for (name, limit, rowFields) in [
            ("beats", 200, ["title": 200, "description": 4000]),
            ("characters", 100, ["name": 120, "role": 200, "description": 6000, "arc": 4000]),
            ("researchNotes", 100, ["title": 200, "notes": 6000, "source": 2000])
        ] {
            var ids = Set<String>() // Desktop uniqueness is per development collection.
            for value in try list(development[name], limit, name) {
                let row = try shape(value, Set(rowFields.keys).union(["id"]), name)
                try require(ids.insert(uuid(row["id"], "\(name).id")).inserted, "Duplicate \(name) UUID.")
                total += try fields(row, rowFields, name)
            }
        }
        total += try world(development["world"])
        try require(total <= 400000, "Development exceeds 400000 UTF-16 units in total.")
    }

    static func world(_ value: Any?) throws -> Int {
        let world = try shape(value, ["schemaVersion", "elements", "links"], "World")
        try integer(world["schemaVersion"], 1...1, "World.schemaVersion")
        let elements = try list(world["elements"], 300, "World.elements")
        let links = try list(world["links"], 1000, "World.links")
        var ids = Set<String>()
        var elementIDs = Set<String>()
        var total = 0
        for value in elements {
            let element = try shape(value,
                ["id", "type", "name", "description", "storyFunction", "sensoryDetails", "continuity", "status", "order"], "World element")
            let id = try uuid(element["id"], "World element.id")
            try require(ids.insert(id).inserted, "Duplicate world element UUID.")
            elementIDs.insert(id)
            try choice(element["type"], ["character", "location", "world_rule", "faction", "timeline_note", "thematic_note", "prop", "relationship"], "World element.type")
            try choice(element["status"], ["idea", "established", "needs_review"], "World element.status")
            try integer(element["order"], 0...9007199254740991, "World element.order")
            total += try fields(element, ["name": 160, "description": 8000, "storyFunction": 4000,
                                         "sensoryDetails": 4000, "continuity": 4000], "World element")
        }
        for value in links {
            let link = try shape(value, ["id", "elementId", "targetType", "targetRef", "targetLabel", "notes"], "World link")
            try require(ids.insert(uuid(link["id"], "World link.id")).inserted, "Duplicate world link UUID.")
            let source = try uuid(link["elementId"], "World link.elementId")
            try require(elementIDs.contains(source), "World link source element does not exist.")
            try choice(link["targetType"], ["element", "scene", "character"], "World link.targetType")
            total += try fields(link, ["targetRef": 500, "targetLabel": 500, "notes": 2000], "World link")
            let ref = try text(link["targetRef"], 500, "World link.targetRef")
            // ECMAScript trim whitespace exactly; Foundation whitespace differs for U+0085 and U+FEFF.
            let whitespace: Set<UInt32> = [9, 10, 11, 12, 13, 32, 0xA0, 0x1680, 0x2000, 0x2001, 0x2002,
                0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF]
            try require(ref.unicodeScalars.contains { !whitespace.contains($0.value) }, "World link needs a target reference.")
            if link["targetType"] as? String == "element" {
                let target = try uuid(ref, "World link.targetRef")
                try require(target != source && elementIDs.contains(target), "World link target must be another existing element.")
            }
        }
        try require(total <= 200000, "World exceeds 200000 UTF-16 units in total.")
        return total
    }
}

/// Preserve distinctions JSONSerialization discards: duplicate object keys and integer -0.
/// Foundation checks the complete JSON grammar after this bounded lexical pass.
private struct JSONPreflight {
    let bytes: [UInt8]
    var index = 0

    mutating func check() throws {
        try value(depth: 0)
        whitespace()
        try require(index == bytes.count, "Unexpected data after JSON.")
    }

    mutating func whitespace() {
        while index < bytes.count && [9, 10, 13, 32].contains(bytes[index]) { index += 1 }
    }

    mutating func take(_ byte: UInt8) -> Bool {
        whitespace()
        guard index < bytes.count && bytes[index] == byte else { return false }
        index += 1
        return true
    }

    mutating func string() throws -> Range<Int> {
        whitespace()
        let start = index
        try require(take(34), "Expected a JSON string.")
        while index < bytes.count {
            let byte = bytes[index]
            index += 1
            if byte == 34 { return start..<index }
            if byte == 92 { index += 1 } // Escaped quote cannot terminate the string.
        }
        throw invalid("Unterminated JSON string.")
    }

    mutating func value(depth: Int) throws {
        whitespace()
        try require(depth <= 32 && index < bytes.count, "Invalid or excessively nested JSON.")
        switch bytes[index] {
        case 123: // object
            index += 1
            var keys = Set<String>()
            if take(125) { return }
            repeat {
                let range = try string()
                guard let key = try JSONSerialization.jsonObject(with: Data(bytes[range]), options: .fragmentsAllowed) as? String
                else { throw invalid("Invalid JSON object key.") }
                try require(keys.insert(key).inserted, "Duplicate JSON object key: \(key).")
                try require(take(58), "Expected a JSON colon.")
                try value(depth: depth + 1)
            } while take(44)
            try require(take(125), "Expected a JSON object end.")
        case 91: // array
            index += 1
            if take(93) { return }
            repeat { try value(depth: depth + 1) } while take(44)
            try require(take(93), "Expected a JSON array end.")
        case 34:
            _ = try string()
        default:
            let start = index
            while index < bytes.count && ![9, 10, 13, 32, 44, 93, 125].contains(bytes[index]) { index += 1 }
            try require(index > start, "Expected a JSON value.")
            let token = String(decoding: bytes[start..<index], as: UTF8.self)
            try require(!(token.hasPrefix("-") && Double(token) == 0), "Negative zero is not supported.")
        }
    }
}
