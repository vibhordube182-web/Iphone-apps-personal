import SwiftUI

extension Color {
    init(light: UInt32, dark: UInt32) {
        self.init(UIColor { trait in
            let hex = trait.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        })
    }
}

enum Theme {
    static let paper = Color(light: 0xF6F1E7, dark: 0x12141A)
    static let card = Color(light: 0xFBF8F1, dark: 0x1C1F27)
    static let ink = Color(light: 0x1B1F2A, dark: 0xECE7DB)
    static let muted = Color(light: 0x6B6F7A, dark: 0x9A9DA8)
    static let aegean = Color(light: 0x1F4E79, dark: 0x7FB0DE)
    static let terracotta = Color(light: 0xB5502D, dark: 0xE08A62)
    static let gold = Color(light: 0xA98536, dark: 0xD9B866)
    static let olive = Color(light: 0x5F7035, dark: 0xA3B56F)
    static let rule = Color(light: 0xDDD4C0, dark: 0x2D313B)

    static func serif(_ style: Font.TextStyle, weight: Font.Weight = .regular) -> Font {
        .system(style, design: .serif, weight: weight)
    }
}

/// A row of Greek-key (meander) ornament.
struct Meander: Shape {
    var unit: CGFloat = 5

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let u = unit
        let y0 = rect.midY - 2.5 * u
        p.move(to: CGPoint(x: rect.minX, y: y0 + 5 * u))
        p.addLine(to: CGPoint(x: rect.maxX, y: y0 + 5 * u))

        let spiral: [(CGFloat, CGFloat)] = [(0, 5), (0, 0), (5, 0), (5, 4), (2, 4), (2, 2), (3, 2), (3, 3)]
        var x = rect.minX
        while x + 5 * u <= rect.maxX {
            for (i, pt) in spiral.enumerated() {
                let point = CGPoint(x: x + pt.0 * u, y: y0 + pt.1 * u)
                if i == 0 { p.move(to: point) } else { p.addLine(to: point) }
            }
            x += 6 * u
        }
        return p
    }
}

struct MeanderBand: View {
    var color: Color = Theme.gold
    var unit: CGFloat = 4

    var body: some View {
        Meander(unit: unit)
            .stroke(color, style: StrokeStyle(lineWidth: 1.4, lineCap: .square, lineJoin: .miter))
            .frame(height: unit * 5)
            .accessibilityHidden(true)
    }
}
