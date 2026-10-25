import SwiftUI
import SafariServices

struct ContentView: View {
    @EnvironmentObject private var store: NewsStore
    @State private var reading: Story?
    @State private var showSettings = false

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Masthead(onSettings: { showSettings = true })

                MaximCard(maxim: Maxim.forDate())
                    .padding(.horizontal, 20)
                    .padding(.bottom, 8)

                if let message = store.errorMessage {
                    Text(message)
                        .font(Theme.serif(.footnote))
                        .italic()
                        .foregroundStyle(Theme.muted)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                        .padding(.vertical, 12)
                }

                if let edition = store.edition {
                    ForEach(Realm.allCases) { realm in
                        let stories = edition.stories(in: realm)
                        if !stories.isEmpty {
                            RealmSection(realm: realm, stories: stories, edition: edition) { reading = $0 }
                        }
                    }
                    Footer(fetchedAt: edition.fetchedAt)
                } else if store.isLoading {
                    ProgressView("Consulting the oracle…")
                        .font(Theme.serif(.footnote))
                        .tint(Theme.gold)
                        .padding(.top, 60)
                }
            }
            .frame(maxWidth: 640)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.paper.ignoresSafeArea())
        .refreshable { await store.refresh() }
        .sheet(item: $reading) { story in
            SafariView(url: story.link).ignoresSafeArea()
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
    }
}

// MARK: - Masthead

private struct Masthead: View {
    let onSettings: () -> Void

    private var greeting: (greek: String, english: String) {
        let hour = Calendar.current.component(.hour, from: Date())
        switch hour {
        case 4..<12: return ("Καλημέρα", "Good morning")
        case 12..<18: return ("Χαῖρε", "Good afternoon")
        default: return ("Καλησπέρα", "Good evening")
        }
    }

    var body: some View {
        VStack(spacing: 10) {
            HStack {
                Spacer()
                Button(action: onSettings) {
                    Image(systemName: "bell.badge")
                        .font(.title3)
                        .foregroundStyle(Theme.muted)
                        .padding(8)
                }
                .accessibilityLabel("Notification settings")
            }

            MeanderBand().padding(.horizontal, 40)

            Text("LYCEUM")
                .font(.system(size: 40, weight: .bold, design: .serif))
                .tracking(10)
                .foregroundStyle(Theme.ink)

            Text(Date.now.formatted(.dateTime.weekday(.wide).day().month(.wide).year()).uppercased())
                .font(Theme.serif(.caption, weight: .semibold))
                .tracking(2)
                .foregroundStyle(Theme.terracotta)

            MeanderBand().padding(.horizontal, 40)

            VStack(spacing: 2) {
                Text(greeting.greek)
                    .font(Theme.serif(.title2, weight: .semibold))
                    .foregroundStyle(Theme.aegean)
                Text("\(greeting.english). Here is what matters today.")
                    .font(Theme.serif(.subheadline))
                    .foregroundStyle(Theme.muted)
            }
            .padding(.top, 6)
            .padding(.bottom, 20)
        }
        .padding(.horizontal, 20)
        .padding(.top, 4)
    }
}

// MARK: - Maxim

private struct MaximCard: View {
    let maxim: Maxim

    var body: some View {
        VStack(spacing: 14) {
            Text("THE DAILY LOGOS")
                .font(Theme.serif(.caption2, weight: .bold))
                .tracking(3)
                .foregroundStyle(Theme.gold)

            Text("“\(maxim.text)”")
                .font(Theme.serif(.title3, weight: .medium))
                .italic()
                .foregroundStyle(Theme.ink)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            Text("— \(maxim.author)")
                .font(Theme.serif(.footnote, weight: .semibold))
                .foregroundStyle(Theme.aegean)

            Rectangle().fill(Theme.rule).frame(height: 1).padding(.horizontal, 30)

            VStack(spacing: 4) {
                Text("A LENS FOR TODAY’S NEWS")
                    .font(Theme.serif(.caption2, weight: .bold))
                    .tracking(2)
                    .foregroundStyle(Theme.muted)
                Text(maxim.lens)
                    .font(Theme.serif(.subheadline))
                    .foregroundStyle(Theme.ink.opacity(0.85))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(22)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Theme.card)
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(Theme.gold.opacity(0.45), lineWidth: 1)
                )
        )
    }
}

// MARK: - Sections & stories

private struct RealmSection: View {
    let realm: Realm
    let stories: [Story]
    let edition: Edition
    let onOpen: (Story) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: realm.symbol)
                    .font(.title3)
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(realm.tint))
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(realm.name)
                            .font(Theme.serif(.title2, weight: .bold))
                            .foregroundStyle(Theme.ink)
                        Text(realm.greek)
                            .font(Theme.serif(.subheadline))
                            .foregroundStyle(realm.tint)
                    }
                    Text(realm.subtitle.uppercased())
                        .font(Theme.serif(.caption2, weight: .semibold))
                        .tracking(1.5)
                        .foregroundStyle(Theme.muted)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 28)
            .padding(.bottom, 8)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)

            ForEach(stories) { story in
                StoryRow(story: story, number: edition.number(of: story), tint: realm.tint)
                    .onTapGesture { onOpen(story) }
                    .accessibilityAddTraits(.isButton)
            }
        }
    }
}

private struct StoryRow: View {
    let story: Story
    let number: Int
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Rectangle().fill(Theme.rule).frame(height: 1).padding(.horizontal, 20)

            HStack(alignment: .top, spacing: 14) {
                Text("\(number)")
                    .font(.system(size: 34, weight: .light, design: .serif))
                    .foregroundStyle(tint)
                    .frame(width: 38, alignment: .trailing)

                VStack(alignment: .leading, spacing: 6) {
                    Text("\(story.source.uppercased())  ·  \(story.date.formatted(.relative(presentation: .named)))")
                        .font(Theme.serif(.caption2, weight: .semibold))
                        .tracking(1)
                        .foregroundStyle(Theme.muted)

                    Text(story.title)
                        .font(Theme.serif(.headline, weight: .bold))
                        .foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)

                    if !story.summary.isEmpty {
                        Text(story.summary)
                            .font(Theme.serif(.subheadline))
                            .foregroundStyle(Theme.ink.opacity(0.78))
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Text("Read more  →")
                        .font(Theme.serif(.caption, weight: .semibold))
                        .foregroundStyle(tint)
                        .padding(.top, 2)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
        }
        .contentShape(Rectangle())
    }
}

// MARK: - Footer

private struct Footer: View {
    let fetchedAt: Date

    var body: some View {
        VStack(spacing: 14) {
            MeanderBand().padding(.horizontal, 60)
            Text("That is all for now.")
                .font(Theme.serif(.title3, weight: .semibold))
                .foregroundStyle(Theme.ink)
            Text("Χαῖρε — until tomorrow.")
                .font(Theme.serif(.subheadline))
                .italic()
                .foregroundStyle(Theme.aegean)
            Text("γνῶθι σεαυτόν  ·  know thyself")
                .font(Theme.serif(.caption))
                .tracking(1)
                .foregroundStyle(Theme.gold)
            Text("Updated \(fetchedAt.formatted(.relative(presentation: .named)))")
                .font(Theme.serif(.caption2))
                .foregroundStyle(Theme.muted)
        }
        .padding(.top, 36)
        .padding(.bottom, 48)
    }
}

// MARK: - Safari

struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let config = SFSafariViewController.Configuration()
        config.entersReaderIfAvailable = true
        return SFSafariViewController(url: url, configuration: config)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
