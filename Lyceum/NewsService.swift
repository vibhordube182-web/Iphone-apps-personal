import Foundation

struct FeedSource: Sendable {
    let name: String
    let url: URL
    let realm: Realm

    init(_ name: String, _ url: String, _ realm: Realm) {
        self.name = name
        self.url = URL(string: url)!
        self.realm = realm
    }

    static let all: [FeedSource] = [
        // Polis — geopolitics
        FeedSource("BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml", .polis),
        FeedSource("The Guardian", "https://www.theguardian.com/world/rss", .polis),
        FeedSource("Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml", .polis),
        FeedSource("DW", "https://rss.dw.com/xml/rss-en-all", .polis),
        // Techne — technology
        FeedSource("BBC Technology", "https://feeds.bbci.co.uk/news/technology/rss.xml", .techne),
        FeedSource("Ars Technica", "https://feeds.arstechnica.com/arstechnica/index", .techne),
        FeedSource("The Verge", "https://www.theverge.com/rss/index.xml", .techne),
        FeedSource("The Guardian", "https://www.theguardian.com/technology/rss", .techne),
        // Agora — current affairs
        FeedSource("BBC News", "https://feeds.bbci.co.uk/news/rss.xml", .agora),
        FeedSource("NPR", "https://feeds.npr.org/1001/rss.xml", .agora),
        FeedSource("The Guardian", "https://www.theguardian.com/uk-news/rss", .agora),
        // Oikonomia — economy
        FeedSource("BBC Business", "https://feeds.bbci.co.uk/news/business/rss.xml", .oikonomia),
        FeedSource("The Guardian", "https://www.theguardian.com/business/rss", .oikonomia),
        // Sophia — ideas
        FeedSource("Aeon", "https://aeon.co/feed.rss", .sophia),
    ]
}

enum NewsService {
    static func fetchEdition() async -> Edition? {
        let results = await withTaskGroup(of: (FeedSource, [RawItem]).self) { group in
            for source in FeedSource.all {
                group.addTask { (source, await fetch(source)) }
            }
            var out: [(FeedSource, [RawItem])] = []
            for await result in group { out.append(result) }
            return out
        }
        let stories = assemble(results)
        return stories.isEmpty ? nil : Edition(fetchedAt: Date(), stories: stories)
    }

    private static func fetch(_ source: FeedSource) async -> [RawItem] {
        var request = URLRequest(url: source.url, timeoutInterval: 15)
        request.setValue("Lyceum/1.0 (iOS)", forHTTPHeaderField: "User-Agent")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return [] }
            return FeedParser().parse(data)
        } catch {
            return []
        }
    }

    // MARK: Selection

    private static func assemble(_ results: [(FeedSource, [RawItem])]) -> [Story] {
        var stories: [Story] = []
        var seen: [Set<String>] = []
        let cutoff = Date().addingTimeInterval(-48 * 3600)

        for realm in Realm.allCases {
            var queues: [[Story]] = results
                .filter { $0.0.realm == realm }
                .map { entry in
                    entry.1
                        .compactMap { story(from: $0, source: entry.0) }
                        .sorted { $0.date > $1.date }
                }

            // Prefer the last 48 hours, but fall back to older items for slow feeds.
            let fresh = queues.map { $0.filter { $0.date > cutoff } }
            if fresh.reduce(0, { $0 + $1.count }) >= realm.limit { queues = fresh }

            // Round-robin across sources so no single outlet dominates a realm.
            var picked = 0
            var turn = 0
            while picked < realm.limit, queues.contains(where: { !$0.isEmpty }) {
                let i = turn % queues.count
                turn += 1
                guard !queues[i].isEmpty else { continue }
                let candidate = queues[i].removeFirst()
                let words = tokens(candidate.title)
                if seen.contains(where: { jaccard($0, words) > 0.5 }) { continue }
                seen.append(words)
                stories.append(candidate)
                picked += 1
            }
        }
        return stories
    }

    private static func story(from raw: RawItem, source: FeedSource) -> Story? {
        let title = TextCleaner.plain(fromHTML: raw.title)
        guard !title.isEmpty,
              let link = URL(string: raw.link.trimmingCharacters(in: .whitespacesAndNewlines)),
              link.scheme?.hasPrefix("http") == true else { return nil }

        var summary = TextCleaner.brief(TextCleaner.plain(fromHTML: raw.summary))
        if summary.count < 30 || summary.lowercased().hasPrefix(title.lowercased()) { summary = "" }

        return Story(title: title, summary: summary, source: source.name,
                     link: link, date: raw.date ?? Date(), realm: source.realm)
    }

    private static func tokens(_ s: String) -> Set<String> {
        Set(s.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { $0.count > 2 })
    }

    private static func jaccard(_ a: Set<String>, _ b: Set<String>) -> Double {
        guard !a.isEmpty, !b.isEmpty else { return 0 }
        return Double(a.intersection(b).count) / Double(a.union(b).count)
    }
}
