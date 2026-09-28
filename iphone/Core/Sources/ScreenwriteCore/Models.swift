import Foundation

public struct PocketSnapshot: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var body: String
    public var genre: String
    public var logline: String
    public var projectFormat: String
    public var targetPages: Int?
    public var development: PocketDevelopment

    public init(id: String = UUID().uuidString.lowercased(), title: String = "Untitled",
                body: String = "", genre: String = "", logline: String = "",
                projectFormat: String = "", targetPages: Int? = nil,
                development: PocketDevelopment = .init()) {
        self.id = id; self.title = title; self.body = body; self.genre = genre
        self.logline = logline; self.projectFormat = projectFormat
        self.targetPages = targetPages; self.development = development
    }

    /// Validates the same lossless portable shape used by import and export.
    public func validate() throws { _ = try PocketPackage.validatedPayloadData(self) }
}

public struct PocketDevelopment: Codable, Equatable, Sendable {
    public var concept: String
    public var logline: String
    public var synopsis: String
    public var outline: String
    public var beats: [PocketBeat]
    public var characters: [PocketCharacter]
    public var worldNotes: String
    public var researchNotes: [PocketResearchNote]
    public var world: PocketWorld

    public init(concept: String = "", logline: String = "", synopsis: String = "",
                outline: String = "", beats: [PocketBeat] = [], characters: [PocketCharacter] = [],
                worldNotes: String = "", researchNotes: [PocketResearchNote] = [],
                world: PocketWorld = .init()) {
        self.concept = concept; self.logline = logline; self.synopsis = synopsis
        self.outline = outline; self.beats = beats; self.characters = characters
        self.worldNotes = worldNotes; self.researchNotes = researchNotes; self.world = world
    }
}

public struct PocketBeat: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var description: String

    public init(id: String = UUID().uuidString.lowercased(), title: String = "", description: String = "") {
        self.id = id; self.title = title; self.description = description
    }
}

public struct PocketCharacter: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var role: String
    public var description: String
    public var arc: String

    public init(id: String = UUID().uuidString.lowercased(), name: String = "", role: String = "",
                description: String = "", arc: String = "") {
        self.id = id; self.name = name; self.role = role; self.description = description; self.arc = arc
    }
}

public struct PocketResearchNote: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var notes: String
    public var source: String

    public init(id: String = UUID().uuidString.lowercased(), title: String = "",
                notes: String = "", source: String = "") {
        self.id = id; self.title = title; self.notes = notes; self.source = source
    }
}

public struct PocketWorld: Codable, Equatable, Sendable {
    public var schemaVersion: Int
    public var elements: [PocketWorldElement]
    public var links: [PocketWorldLink]

    public init(schemaVersion: Int = 1, elements: [PocketWorldElement] = [], links: [PocketWorldLink] = []) {
        self.schemaVersion = schemaVersion; self.elements = elements; self.links = links
    }
}

public struct PocketWorldElement: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var type: String
    public var name: String
    public var description: String
    public var storyFunction: String
    public var sensoryDetails: String
    public var continuity: String
    public var status: String
    public var order: Int

    public init(id: String = UUID().uuidString.lowercased(), type: String = "location", name: String = "",
                description: String = "", storyFunction: String = "", sensoryDetails: String = "",
                continuity: String = "", status: String = "idea", order: Int = 0) {
        self.id = id; self.type = type; self.name = name; self.description = description
        self.storyFunction = storyFunction; self.sensoryDetails = sensoryDetails
        self.continuity = continuity; self.status = status; self.order = order
    }
}

public struct PocketWorldLink: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var elementId: String
    public var targetType: String
    public var targetRef: String
    public var targetLabel: String
    public var notes: String

    public init(id: String = UUID().uuidString.lowercased(), elementId: String, targetType: String,
                targetRef: String, targetLabel: String, notes: String = "") {
        self.id = id; self.elementId = elementId; self.targetType = targetType
        self.targetRef = targetRef; self.targetLabel = targetLabel; self.notes = notes
    }
}
