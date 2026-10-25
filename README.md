# Lyceum

A morning news briefing for iPhone, in the spirit of The Economist Espresso, with Greek philosophy woven through it.

- **Five realms** with Greek names: *Polis* (geopolitics), *Techne* (tech), *Agora* (current affairs), *Oikonomia* (economy), *Sophia* (ideas).
- **The Daily Logos**: a different Greek maxim each day, with a "lens" for reading that day's news.
- Numbered, bite-sized stories; tap to open in reader mode.
- Optional morning notification (carries the day's maxim).
- No backend or API keys: live RSS feeds are fetched on-device and cached for offline reading.
- Light and dark mode, Greek-key ornament, serif typography.

## Run it (needs a Mac with Xcode 15+)

```sh
brew install xcodegen
xcodegen generate        # creates Lyceum.xcodeproj from project.yml
open Lyceum.xcodeproj
```

In Xcode: select the Lyceum target, then Signing & Capabilities, choose your Team and change the bundle identifier (`com.example.lyceum`). Plug in your iPhone, select it as the run destination, and press Run. A free Apple ID is enough for personal use (the app expires after 7 days unless re-installed).

## Customising

- Feeds: `Lyceum/NewsService.swift` (`FeedSource.all`)
- Stories per realm: `Realm.limit` in `Lyceum/Models.swift`
- Maxims: `Lyceum/Maxim.swift`
- Colours: `Lyceum/Theme.swift`
