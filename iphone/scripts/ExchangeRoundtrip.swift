// Compiled directly with Core Models.swift and PocketPackage.swift by check-exchange.mjs.
// This CLI exercises the shipping Core API; it does not implement the transport.
import Foundation

private struct CheckFailure: Error, CustomStringConvertible {
    let description: String
}

private func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw CheckFailure(description: message) }
}

// Swift String equality treats composed and decomposed Unicode as equal. Compare
// every string's UTF-8 bytes instead, including opaque references and whitespace.
private func exactJSON(_ actual: Any, _ expected: Any, at path: String = "$" ) throws {
    if let expected = expected as? String {
        guard let actual = actual as? String else { throw CheckFailure(description: "\(path): not text") }
        try require(actual.utf8.elementsEqual(expected.utf8), "\(path): UTF-8 bytes changed")
    } else if let expected = expected as? [String: Any] {
        guard let actual = actual as? [String: Any] else { throw CheckFailure(description: "\(path): not an object") }
        try require(Set(actual.keys) == Set(expected.keys), "\(path): fields changed")
        for key in expected.keys.sorted() {
            try exactJSON(actual[key]!, expected[key]!, at: "\(path).\(key)")
        }
    } else if let expected = expected as? [Any] {
        guard let actual = actual as? [Any] else { throw CheckFailure(description: "\(path): not an array") }
        try require(actual.count == expected.count, "\(path): row count changed")
        for index in expected.indices { try exactJSON(actual[index], expected[index], at: "\(path)[\(index)]") }
    } else if let expected = expected as? NSNumber, let actual = actual as? NSNumber {
        try require(actual == expected, "\(path): number changed")
    } else {
        throw CheckFailure(description: "\(path): unexpected JSON value")
    }
}

private func json(_ snapshot: PocketSnapshot) throws -> Any {
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot))
}

private func checkedWrite(_ snapshot: PocketSnapshot, to filename: String) throws -> String {
    try snapshot.validate()
    let bytes = try PocketPackage.encode(snapshot)
    let decoded = try PocketPackage.decode(bytes)
    try decoded.validate()
    try exactJSON(json(decoded), json(snapshot))
    try bytes.write(to: URL(fileURLWithPath: filename), options: .atomic)
    return try PocketPackage.contentHash(bytes)
}

@main
enum ExchangeRoundtrip {
    static func main() throws {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let mode = args.first else { throw CheckFailure(description: "Expected roundtrip or defaults") }
        switch mode {
        case "roundtrip":
            try require(args.count == 4, "Usage: ExchangeRoundtrip roundtrip INPUT.qiscript EXPECTED.json OUTPUT.qiscript")
            let input = try Data(contentsOf: URL(fileURLWithPath: args[1]))
            let expected = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[2])))
            var snapshot = try PocketPackage.decode(input)
            try snapshot.validate()
            try exactJSON(json(snapshot), expected)
            let inputHash = try PocketPackage.contentHash(input)
            try require(snapshot.development.world.elements.count == 2, "Expected two world elements")
            try require(snapshot.development.world.links.count == 3, "Expected three world links")
            try require(snapshot.development.world.links[1].targetType == "scene", "Expected opaque scene link")

            // Deliberate edits. Node independently constructs the expected result.
            snapshot.body += "\r\nEXT. 帰り道 - DAWN #opaque-final#\r\n\r\nÉ\r\nStill e\u{301}; still 海 🎬.\r\n"
            snapshot.development.worldNotes += "\r\nSwift world note: café / e\u{301} / العربية.  "
            snapshot.development.world.elements[0].description += "\r\nSwift: the tide returns 🌊.  "
            snapshot.development.world.links[1].notes += "\r\nSwift: keep this scene reference opaque.  "
            let outputHash = try checkedWrite(snapshot, to: args[3])
            let pages = snapshot.targetPages.map(String.init) ?? "absent"
            print("PASS Swift decode/validate, exact input UTF-8, body/world edit, encode/decode; targetPages=\(pages); input=\(inputHash); output=\(outputHash)")

        case "defaults":
            try require(args.count == 3, "Usage: ExchangeRoundtrip defaults EMPTY.qiscript POPULATED.qiscript")
            let empty = PocketSnapshot()
            try require(empty.title == "Untitled" && empty.targetPages == nil, "Invalid snapshot defaults")
            try require(empty.id != PocketSnapshot().id && empty.id == empty.id.lowercased(), "Default IDs must be independent lowercase UUIDs")
            let emptyHash = try checkedWrite(empty, to: args[1])

            // All public row/world initializers, including required link arguments.
            let element = PocketWorldElement()
            let populated = PocketSnapshot(development: PocketDevelopment(
                beats: [PocketBeat()], characters: [PocketCharacter()], researchNotes: [PocketResearchNote()],
                world: PocketWorld(elements: [element], links: [PocketWorldLink(
                    elementId: element.id, targetType: "scene", targetRef: "opaque:default/海#e\u{301}", targetLabel: "")])
            ))
            let populatedHash = try checkedWrite(populated, to: args[2])
            print("PASS Swift default initializers, validate, encode/decode; targetPages absent; empty=\(emptyHash); populated=\(populatedHash)")

        default:
            throw CheckFailure(description: "Unknown mode: \(mode)")
        }
    }
}
