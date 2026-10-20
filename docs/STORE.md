# Store listing: what the repo gives you and what needs an account

Step 8 of `PLAN-NATIVE-WALLET.md`. Everything that can be done in the repo is done; the rest needs a
Google Play Console account (one-off fee) and an Apple Developer Program membership (yearly), both
in the publisher's legal name, which the stores show on the listing whatever the app says.

## What the repo provides

- **Icons and splash screens**, generated from the mark in `scripts/make-icons.mjs` (an ink square,
  "PQ" in Archivo at its widest in paper, one signal pixel) through `@capacitor/assets`:
  `assets/` holds the 1024 px and 2732 px sources, `android/app/src/main/res/` and
  `ios/App/App/Assets.xcassets/` the generated sets, light and dark. Re-run with
  `node scripts/make-icons.mjs && npx @capacitor/assets generate --android --ios --iconBackgroundColor '#0f0f0e' --iconBackgroundColorDark '#0f0f0e' --splashBackgroundColor '#e9e6df' --splashBackgroundColorDark '#0f0f0e'`.
- **Android back button**: `App.handleBack()` in `src/ui/app.ts`. A request sheet is a rejection, a
  page in the dapp browser goes back or closes, a screen under a tab returns to the tab's root, an
  onboarding step cancels, and a root minimises the app.
- **System bars**: the Android theme colours follow the paper/ink palette by day and night
  (`values/colors.xml`, `values-night/colors.xml`); the web layout already keeps clear of safe areas.
- **Privacy policy** at https://wallet.koinosproof.com/privacy.html (`public/privacy.html`), linked
  from Settings → About. The stores require this URL.
- **Builds**: every push to `master` builds a signed release APK and a signed AAB (`android-apk`,
  `android-aab` artifacts, with sha256) and an unsigned iOS app. The AAB is what Play takes.

## Google Play, internal testing track

1. Play Console → Create app: name "Koinos PQ Wallet", default language English, app (not game),
   free. Declarations: no ads, not aimed at children.
2. Set up the app:
   - Privacy policy: the URL above.
   - App access: "All functionality is available without special access" (a tester creates a wallet).
   - Ads: none. Content rating: fill the questionnaire (finance category, no user-generated content,
     no gambling; the test dapp link in the Dapps tab opens a web page, answer accordingly).
   - Target audience: 18 and over. News app: no. COVID: no.
   - Data safety: **no data collected, no data shared**. Say that encryption in transit applies (node
     calls are https) and that users can request deletion by deleting the wallet in the app
     (nothing exists elsewhere). Financial-info questions: the app does not collect it.
   - Government apps / financial features: declare the app as a non-custodial cryptocurrency wallet
     where asked (Play's "Financial features" declaration has a crypto wallet option).
3. Store listing: short and full description from the README's first paragraphs, the icon
   (`assets/icon-only.png` is 1024 px, Play wants 512 px: scale it), a feature graphic 1024×500 (the
   mark on paper), phone screenshots from `scripts/design-shots.mjs` or a device (at least two).
4. Testing → Internal testing → Create release: upload the `android-aab` artifact from the latest
   CI run, add testers by email (up to 100), roll out. Play re-signs nothing here: the AAB is signed
   with the project key, whose fingerprint is in the README.
5. Hand testers the opt-in link Play shows. Updates: bump `version` in `package.json` and `versionName` and `versionCode` in
   `android/app/build.gradle` (every release so far did), push, upload the new AAB.

## iOS

TestFlight needs the Apple Developer Program. Then, on a Mac with Xcode 26: `npm run build && npx cap
sync ios`, open `ios/App/App.xcworkspace`, set the team and a bundle id you own (the project uses
`ie.rawbyte.koinospq`), Product → Archive, distribute to App Store Connect, add testers in TestFlight.
Face ID and camera usage texts are already in `Info.plist`. The CI job proves the project compiles
with the plugins; it cannot sign.

## Before the first public release

- Replace "A test build, not audited" once a review has happened, in the README, the About text and
  the privacy page, in the same commit.
- The APK is ~35 MB because the barcode scanner ships every ABI's native library; ABI splits in
  `android/app/build.gradle` would halve what each phone downloads.
