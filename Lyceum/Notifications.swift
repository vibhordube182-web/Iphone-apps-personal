import UserNotifications

/// Schedules a morning reminder carrying that day's maxim.
/// Fourteen one-off requests are queued so each day can show a different maxim;
/// they are refreshed every time the app becomes active.
enum Notifications {
    static let enabledKey = "notifyEnabled"
    static let minutesKey = "notifyMinutes"
    static let defaultMinutes = 7 * 60

    static func requestAuthorization() async -> Bool {
        (try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound])) ?? false
    }

    static func reschedule() async {
        let center = UNUserNotificationCenter.current()
        center.removeAllPendingNotificationRequests()

        let defaults = UserDefaults.standard
        guard defaults.bool(forKey: enabledKey) else { return }
        let minutes = defaults.object(forKey: minutesKey) as? Int ?? defaultMinutes

        let calendar = Calendar.current
        for offset in 0..<14 {
            guard let day = calendar.date(byAdding: .day, value: offset, to: Date()) else { continue }
            var parts = calendar.dateComponents([.year, .month, .day], from: day)
            parts.hour = minutes / 60
            parts.minute = minutes % 60
            guard let fire = calendar.date(from: parts), fire > Date() else { continue }

            let maxim = Maxim.forDate(day)
            let content = UNMutableNotificationContent()
            content.title = "Your morning edition is ready"
            content.body = "“\(maxim.text)” — \(maxim.author)"
            content.sound = .default

            let request = UNNotificationRequest(
                identifier: "lyceum.morning.\(offset)",
                content: content,
                trigger: UNCalendarNotificationTrigger(dateMatching: parts, repeats: false)
            )
            try? await center.add(request)
        }
    }
}
