# Lyceum

A morning news briefing for iPhone, in the spirit of The Economist Espresso, with Greek philosophy woven through it.

- **Five realms** with Greek names: *Polis* (geopolitics), *Techne* (tech), *Agora* (current affairs), *Oikonomia* (economy), *Sophia* (ideas).
- **The Daily Logos**: a different Greek maxim each day, with a "lens" for reading that day's news.
- Numbered, bite-sized stories; tap to open in reader mode.
- Optional morning notification (carries the day's maxim).
- No backend or API keys: live RSS feeds are fetched on-device and cached for offline reading.
- Light and dark mode, Greek-key ornament, serif typography.

## Web app (no Mac, no signing)

`web/` is an installable web app version of Lyceum, personalised for its owner (Melbourne/Mumbai news and weather, Musk-orbit and longevity sections, rock and football, a daily Greek reading and a streak). Edit `GROUPS`/`FEEDS` in `scripts/fetch_news.py` and `NAME`/`CITIES` in `web/index.html` to retune it. A GitHub Action (`daily-edition.yml`) fetches the feeds every morning and publishes it to GitHub Pages. Open the Pages URL in Safari on your iPhone, tap Share, then Add to Home Screen.

One-time setup: merge to `main`, then Settings, Pages, Source: *GitHub Actions*, then run *Daily edition* once from the Actions tab.

## Native app without a Mac

GitHub's macOS servers build the app for you.

**Free (Apple ID, re-sign every 7 days):** open the repo's *Actions* tab, open the latest *Build* run and download the `Lyceum-unsigned-ipa` artifact. Unzip it to get `Lyceum.ipa`, then install it on your iPhone with [Sideloadly](https://sideloadly.io) (Windows/macOS) or AltStore, signing in with your Apple ID.

**Paid ($99/yr Apple Developer, no expiry, installs via TestFlight):**
1. In App Store Connect create an app record with your bundle ID.
2. Create an App Store Connect API key (Users and Access, Integrations, role *App Manager* or *Admin*).
3. Add repo secrets: `APPLE_TEAM_ID`, `BUNDLE_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64` (the .p8 file, base64-encoded).
4. Run the *TestFlight* workflow from the Actions tab, then install from the TestFlight app.

## Run it on a Mac (Xcode 15+)

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
