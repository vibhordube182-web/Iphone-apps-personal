# AshKey Entertainment

Tinder for movies, for two. You and your partner each open the app on your own phone and swipe the same pool of
Hollywood and Bollywood movies. Anything you **both** like lands in **Matches**, with Australian streaming
availability, so you can pick tonight's movie.

- **HD posters, synopsis, cast** (photos and roles), director, runtime, rating, trailer link.
- **Where to watch in Australia** (Netflix, Stan, Disney+, Prime Video, Binge, Paramount+, ...), plus rent/buy, on
  the card, in the detail sheet and on every match. Data: TMDB + JustWatch.
- **Hollywood / Bollywood slider**, and an "only things I can stream in Australia" switch with your own services.
- **Matches tab**: filter by streaming service, mark as watched, and **Choose for us**.
- **Watched together**: swipe a card **down** (or tap the eye) for "already watched". It's shared, and hidden from both decks.
- **My likes**: everything you've liked, filterable by service.
- **It learns**: swipe, super-like (swipe up) or undo. Installable on the iPhone Home Screen, works offline for the shell.

## How the algorithm picks your next card (`taste.js`)

1. **Taste profile per person**: every swipe updates affinities for genre, language, decade, lead cast and director.
   Recent swipes count more, rarely-seen features are shrunk toward zero, and scores are judged against how generous
   you are overall (so a picky person's likes mean more).
2. **Score** = 40% your own affinity + 30% "both of us" (average of your affinity and hers, penalising
   disagreement) + 20% quality (Bayesian rating) + 5% popularity.
3. **Partner signal**: a movie your partner liked rises (so you get a chance to match); one she passed on sinks
   (it can never match). At most about 1 card in 3 is one she liked, so it never feels rigged.
4. **"Because you liked X"**: TMDB recommendations of what either of you liked are fed into the pool.
5. **Shared noise**: the same room-seeded randomness on both phones means you see largely the same movies, which
   is what makes matches likely. A little personal randomness (shrinking as it learns you) keeps it fresh, and
   10% of cards are wildcards to discover tastes you haven't shown yet.
6. **Deck assembly**: a Hollywood/Bollywood quota (your slider), and a variety penalty so it never serves four
   thrillers in a row.

## Setup (about 5 minutes, all free)

### 1. TMDB key
Create a free account at <https://www.themoviedb.org>, then Settings, API, "Developer". Copy the **API Key**
(or the "API Read Access Token").

### 2. Sync database (connects the two phones)
Option A, **Firebase** (nothing to host):
1. <https://console.firebase.google.com>, create a project, then Build, **Realtime Database**, Create database
   (any region; choose "locked mode").
2. Open the **Rules** tab and paste this, then Publish. Rooms are only reachable if you know the 10-letter room
   code, and nobody can list them:
   ```json
   { "rules": { "rooms": { "$room": { ".read": true, ".write": true } } } }
   ```
3. Copy the database URL shown at the top of the Data tab, like `https://xxxx-default-rtdb.firebaseio.com`.

Option B, **self-host**: `node reelmatch/server.js` serves the app and its own tiny database (`/db`, saved in
`data.json`). It needs HTTPS for iPhones, so run it somewhere public (Render, Fly, Railway) or behind a tunnel.
The app auto-detects it.

### 3. Host the app
The repo's GitHub Pages workflow (`daily-edition.yml`) already publishes it at
`https://<you>.github.io/<repo>/reelmatch/` once this is merged to `main` (Settings, Pages, Source: GitHub Actions).

### 4. Use it
1. First phone: open the URL in Safari, enter your name and the TMDB key, leave **Room code** empty and tap
   **Start a new room**. Your room code is on the **Us** tab.
2. Second phone: open the same URL (or the invite link from **Us → Share invite link**), type her name and the room
   code, tap **Join room**. She never needs the key or the database URL: the app reads the key from your private room
   (open the app once yourself before she joins).
3. Both: Share, **Add to Home Screen**, then on first launch enter your name and the code again (the Home Screen app
   has its own storage separate from Safari).
4. Re-adding or reinstalling? Use the same name: the app treats the same name in a room as the same person and
   restores your swipes.

The first phone's TMDB key lives only in that private room, not in the repo.

## Tests
```sh
node --test reelmatch/test/taste.test.mjs                              # algorithm
NODE_PATH=$(npm root -g) node reelmatch/test/e2e.cjs                   # two phones end to end (Playwright, TMDB mocked)
```
