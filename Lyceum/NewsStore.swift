import SwiftUI

@MainActor
final class NewsStore: ObservableObject {
    @Published private(set) var edition: Edition?
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?

    private static let cacheURL = FileManager.default
        .urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("edition.json")

    init() {
        if let data = try? Data(contentsOf: Self.cacheURL) {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            edition = try? decoder.decode(Edition.self, from: data)
        }
    }

    /// Refreshes if there is no edition yet or the cached one is older than `maxAge`.
    func refreshIfStale(maxAge: TimeInterval = 30 * 60) async {
        if let edition, Date().timeIntervalSince(edition.fetchedAt) < maxAge { return }
        await refresh()
    }

    func refresh() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }

        if let fresh = await NewsService.fetchEdition() {
            edition = fresh
            errorMessage = nil
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            if let data = try? encoder.encode(fresh) { try? data.write(to: Self.cacheURL) }
        } else {
            errorMessage = edition == nil
                ? "The oracle is silent. Check your connection and pull down to try again."
                : "Couldn’t refresh — showing your last edition."
        }
    }
}
