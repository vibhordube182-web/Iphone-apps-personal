import SwiftUI

/// The five "realms" of the edition, named for Greek concepts.
enum Realm: String, CaseIterable, Codable, Identifiable {
    case polis, techne, agora, oikonomia, sophia

    var id: String { rawValue }

    var name: String { rawValue.capitalized }

    var greek: String {
        switch self {
        case .polis: "Πόλις"
        case .techne: "Τέχνη"
        case .agora: "Ἀγορά"
        case .oikonomia: "Οἰκονομία"
        case .sophia: "Σοφία"
        }
    }

    var subtitle: String {
        switch self {
        case .polis: "Geopolitics & the world"
        case .techne: "Technology & craft"
        case .agora: "Current affairs"
        case .oikonomia: "Markets & the economy"
        case .sophia: "Ideas worth your time"
        }
    }

    var symbol: String {
        switch self {
        case .polis: "globe.europe.africa.fill"
        case .techne: "cpu"
        case .agora: "building.columns.fill"
        case .oikonomia: "chart.line.uptrend.xyaxis"
        case .sophia: "lightbulb.fill"
        }
    }

    var tint: Color {
        switch self {
        case .polis: Theme.terracotta
        case .techne: Theme.aegean
        case .agora: Theme.gold
        case .oikonomia: Theme.olive
        case .sophia: Theme.muted
        }
    }

    /// How many stories each realm contributes to the morning edition.
    var limit: Int {
        switch self {
        case .polis: 4
        case .techne: 3
        case .agora: 3
        case .oikonomia: 2
        case .sophia: 1
        }
    }
}

struct Story: Identifiable, Codable, Hashable {
    let title: String
    let summary: String
    let source: String
    let link: URL
    let date: Date
    let realm: Realm

    var id: String { link.absoluteString }
}

struct Edition: Codable {
    let fetchedAt: Date
    let stories: [Story]

    func stories(in realm: Realm) -> [Story] {
        stories.filter { $0.realm == realm }
    }

    /// Stories are stored in realm order, so the position gives the running number.
    func number(of story: Story) -> Int {
        (stories.firstIndex(where: { $0.id == story.id }) ?? 0) + 1
    }
}
