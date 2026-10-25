import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage(Notifications.enabledKey) private var enabled = false
    @AppStorage(Notifications.minutesKey) private var minutes = Notifications.defaultMinutes
    @State private var denied = false

    private var time: Binding<Date> {
        Binding(
            get: {
                Calendar.current.date(bySettingHour: minutes / 60, minute: minutes % 60, second: 0, of: Date()) ?? Date()
            },
            set: { date in
                let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
                minutes = (parts.hour ?? 7) * 60 + (parts.minute ?? 0)
            }
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Morning reminder", isOn: $enabled)
                        .tint(Theme.aegean)
                    if enabled {
                        DatePicker("Deliver at", selection: time, displayedComponents: .hourAndMinute)
                    }
                } header: {
                    Text("Morning edition")
                } footer: {
                    Text(denied
                         ? "Notifications are turned off for Lyceum. Enable them in Settings › Notifications."
                         : "A gentle nudge each morning with the day’s Greek maxim. Open the app to read the full edition.")
                }

                Section("About") {
                    Text("Lyceum gathers headlines from BBC, The Guardian, Al Jazeera, DW, NPR, Ars Technica, The Verge and Aeon directly on your phone, and groups them into five realms: Polis, Techne, Agora, Oikonomia and Sophia.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onChange(of: enabled) { _, isOn in
                Task {
                    let granted = isOn ? await Notifications.requestAuthorization() : true
                    denied = !granted
                    if !granted { enabled = false }
                    await Notifications.reschedule()
                }
            }
            .onChange(of: minutes) { _, _ in
                Task { await Notifications.reschedule() }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
