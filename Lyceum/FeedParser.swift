import Foundation

struct RawItem {
    var title = ""
    var summary = ""
    var link = ""
    var date: Date?
}

/// Minimal RSS 2.0 + Atom parser.
final class FeedParser: NSObject, XMLParserDelegate {
    private var items: [RawItem] = []
    private var current: RawItem?
    private var text = ""

    func parse(_ data: Data) -> [RawItem] {
        let parser = XMLParser(data: data)
        parser.delegate = self
        parser.parse()
        return items
    }

    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?,
                qualifiedName qName: String?, attributes attributeDict: [String: String] = [:]) {
        text = ""
        if elementName == "item" || elementName == "entry" {
            current = RawItem()
        } else if elementName == "link", current != nil, let href = attributeDict["href"] {
            let rel = attributeDict["rel"]
            if rel == nil || rel == "alternate" { current?.link = href }
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        text += string
    }

    func parser(_ parser: XMLParser, foundCDATA CDATABlock: Data) {
        text += String(data: CDATABlock, encoding: .utf8) ?? ""
    }

    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?,
                qualifiedName qName: String?) {
        defer { text = "" }
        guard current != nil else { return }
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)

        switch elementName {
        case "title":
            if current!.title.isEmpty { current!.title = value }
        case "description", "summary", "content":
            if current!.summary.isEmpty { current!.summary = value }
        case "link":
            if !value.isEmpty { current!.link = value }
        case "pubDate", "published", "updated", "dc:date":
            if current!.date == nil { current!.date = Self.parseDate(value) }
        case "item", "entry":
            items.append(current!)
            current = nil
        default:
            break
        }
    }

    // MARK: Dates

    private static let rfc822: [DateFormatter] = [
        "EEE, dd MMM yyyy HH:mm:ss Z",
        "EEE, dd MMM yyyy HH:mm:ss zzz",
        "dd MMM yyyy HH:mm:ss Z",
        "EEE, d MMM yyyy HH:mm:ss Z",
    ].map { format in
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = format
        return f
    }

    private static let isoPlain = ISO8601DateFormatter()
    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func parseDate(_ string: String) -> Date? {
        if let d = isoPlain.date(from: string) ?? isoFractional.date(from: string) { return d }
        for f in rfc822 {
            if let d = f.date(from: string) { return d }
        }
        return nil
    }
}

// MARK: - Text cleanup

enum TextCleaner {
    static func plain(fromHTML html: String) -> String {
        var s = html.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
        let named = [
            "&amp;": "&", "&quot;": "\"", "&apos;": "'", "&lt;": "<", "&gt;": ">",
            "&nbsp;": " ", "&rsquo;": "’", "&lsquo;": "‘", "&ldquo;": "“", "&rdquo;": "”",
            "&ndash;": "–", "&mdash;": "—", "&hellip;": "…",
        ]
        for (k, v) in named { s = s.replacingOccurrences(of: k, with: v) }
        s = decodeNumericEntities(s)
        return s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func decodeNumericEntities(_ input: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: "&#(x?)([0-9a-fA-F]+);") else { return input }
        var result = input
        let matches = regex.matches(in: input, range: NSRange(input.startIndex..., in: input))
        for m in matches.reversed() {
            guard let whole = Range(m.range, in: result),
                  let hexFlag = Range(m.range(at: 1), in: result),
                  let digits = Range(m.range(at: 2), in: result),
                  let code = UInt32(result[digits], radix: result[hexFlag].isEmpty ? 10 : 16),
                  let scalar = Unicode.Scalar(code) else { continue }
            result.replaceSubrange(whole, with: String(Character(scalar)))
        }
        return result
    }

    /// Trims to roughly `limit` characters, preferring a sentence boundary.
    static func brief(_ text: String, limit: Int = 230) -> String {
        guard text.count > limit else { return text }
        let head = String(text.prefix(limit))
        if let r = head.range(of: ". ", options: .backwards), head.distance(from: head.startIndex, to: r.lowerBound) > limit / 2 {
            return String(head[..<r.lowerBound]) + "."
        }
        if let r = head.range(of: " ", options: .backwards) {
            return String(head[..<r.lowerBound]) + "…"
        }
        return head + "…"
    }
}
