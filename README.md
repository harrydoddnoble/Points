# Points

A small points tracker for the children. You add or take away points by voice (Gemini on the watch, or Google on the phone), with a reason, and the app shows each child's score for the day, the week and overall.

## How it works

Google no longer lets people build custom voice commands for Assistant or Gemini (Conversational Actions were switched off in 2023), so the app can't be "talked to" directly. What Gemini *can* do is add items to **Google Tasks**, so the app uses a Google Tasks list called **Points** as its storage:

1. You say something like *"Hey Google, add 'Sam plus two for tidying his room' to my Points list."*
2. Gemini adds that as a task in the Points list.
3. When you open the app, it reads the list, works out what each task means (child, plus or minus, how many, and why) and updates the scores. It then ticks the task off in Google Tasks and records when it was logged.
4. Points added in the app itself are written to the same list, so everything stays in one place.

There is also an optional **"⭐ Today's score: Sam 5, Ella 3"** task that the app keeps at the top of the list. Because the entries themselves get ticked off, asking *"Hey Google, what's on my Points list?"* should read that score out. Two caveats, though: it's only refreshed when the app is open, so it can be out of date (and on a new day it will still show yesterday's score until you open the app), and how Gemini reads lists out isn't something I could test from here.

## Things you can say

The child's name has to be in the sentence, along with either "plus"/"minus", a +/− symbol, or a number with a word like "add", "give", "take" or "lose". Some examples that work:

- "Sam plus two for tidying his room"
- "Add 3 points to Ella for helping with dinner"
- "Take one point from Sam because he hit his sister"
- "Minus two Ella shouting"
- "Give Sam a point for sharing"
- "Sam lost 2 points for not listening"

Anything in the Points list that doesn't make sense to the app shows up under **"Couldn't understand"**, so nothing is silently lost. Speech-to-text often hears "two points" as "to points" or "four" as "for", and the app allows for that.

Everyday tasks such as "Take Sam to football" are deliberately ignored (no number and no "points"), which matters if you ever point the app at a list you also use for other things.

## AI helper (optional)

If you switch on the AI helper in settings, two extra things happen.

**It reads entries the rules can't.** Anything in the Points list that the built-in rules don't understand gets sent to the AI, which decides which child it's about, whether it's a plus or a minus, and how many points (1 unless you said a number). So you can just say *"Sam was really kind to his sister"* or *"Ella helped carry all the shopping in"*. Entries read this way have a small **AI** badge, so you can spot them and delete any it got wrong. Each entry is only sent once, because the answer is saved in the task's notes. Things that clearly aren't about the children (like "Buy milk") stay under "Couldn't understand".

The rules still handle anything they *can* read, like "Sam +2 tidying". That keeps things predictable and means most entries never go to the AI at all. The catch is that the AI doesn't double-check the rules: if the rules confidently misread something, the AI won't catch it.

**It writes summaries.** The "How's everyone doing?" card turns today, the last 7 days or the last 30 days into a short write-up for each child. Each one covers what's going well, what to work on and one small thing to try. The instructions ask it to be balanced, to describe behaviour rather than labelling the child, not to compare the children, and to say so when there isn't much to go on. It's still an AI reading a handful of short notes, though, so it's a prompt for your own thinking rather than an assessment.

### Choosing a provider

You bring your own API key, and it's stored only in that browser. You can pick either:

- **Claude (Anthropic).** Get a key at <https://console.anthropic.com/>. It's pay-as-you-go. The default model, `claude-opus-5-5`, is Anthropic's main model. As a rough estimate, reading an entry costs about 2–3p and a summary about 5–10p, so daily use might come to a few pounds a month (only entries the rules can't read are sent). If you'd rather keep it cheaper, typing `claude-haiku-5-5` into the Model box should cut that by well over 90%, though summaries may be less thoughtful. Either way, it's worth setting a monthly spend limit in the Console. Anthropic doesn't use API data to train its models by default.
- **Gemini (Google).** Get a key at <https://aistudio.google.com/>. There's a free tier, but on it Google may use what you send to improve its products, and people may review it. The paid tier doesn't do that. Google's terms have in the past treated UK and EEA users differently here, so it's worth checking the current terms. The default model is `gemini-3.8-flash`.

Either way, **"Hide the children's names"** is on by default. Each name is replaced with a code like `[C1]` before anything leaves the device, and swapped back when the answer arrives. Other personal details in what you dictate (a school name, say) are still sent as they are.

Because the key sits in the browser, anyone who can use that browser could in principle find it, so only turn this on for a device you trust. You can change the model in settings if a newer one comes out.

## Setting it up

### 1. Host the app

The workflow in `.github/workflows/pages.yml` runs the tests and publishes the app to GitHub Pages whenever `main` changes.

1. Merge this branch into `main`.
2. In the repository on GitHub, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. After the workflow runs, the app will be at `https://harrydoddnoble.github.io/<repo-name>/`.

GitHub Pages is free for public repositories. For a private repository it needs a paid GitHub plan. Nothing personal is stored in the code (names and points live in your browser and your Google account), so making the repository public is reasonable, but that's your call.

To try it locally instead, run `npm start` and open <http://localhost:8000>.

### 2. Try demo mode (optional)

Open the app, tap **Open settings**, type the children's names separated by commas and save. Demo mode keeps everything in that one browser, so it's handy for a look around but voice won't reach it.

### 3. Connect Google Tasks (needed for voice)

This takes about five minutes and only has to be done once. Google moves these menus around now and then, so the names may differ slightly.

1. Go to <https://console.cloud.google.com/> and create a new project (e.g. "Points").
2. Under **APIs & Services → Library**, search for **Google Tasks API** and enable it.
3. Open **Google Auth Platform** (previously "OAuth consent screen"), choose **External**, give the app a name and your email address. Under **Audience**, add your own Google account (and your partner's, if they'll use it) as a **test user**. Leave it in "Testing"; it doesn't need to be published or verified.
4. Under **Clients**, create a client of type **Web application**. Under **Authorised JavaScript origins**, add `https://harrydoddnoble.github.io` (and `http://localhost:8000` if you want to run it locally). Copy the **client ID**.
5. In the app, open settings, choose **Google Tasks**, paste the client ID and tap **Connect Google**. Google will warn that the app isn't verified; that's expected for your own testing-mode app, so continue.
6. Pick **Create a "Points" list** (or an existing list) and save.

Make sure the watch and phone are signed into the same Google account you connected.

## Known limitations

- **Signing in again.** Google's browser sign-in gives the app an hour-long pass. After that the app shows a **Reconnect** button, which is usually a single tap. Keeping you signed in for longer would need a small server, which felt like more than this needs, but it could be added later.
- **Gemini's support for Tasks.** On phones, Gemini can add to Google Tasks through its Google Tasks app integration. On watches, I couldn't confirm from Google's documentation whether Gemini on Wear OS can add to a *named* Tasks list, so it's worth trying the phrase on your watch. If it can only create reminders, those go into your default "My Tasks" list. In that case you could choose "My Tasks" as the list in settings and say *"Remind me Sam plus two for tidying"*, since the app ignores tasks that aren't points entries.
- **Timing.** Google Tasks doesn't keep a "created" time, so the app uses the moment the task was last changed before the app first saw it. In practice that's when Gemini added it, unless someone edits the task before the app is opened.
- **Day boundaries** use the phone's local midnight, and weeks start on Monday.

## Development

- `parser.js` turns task titles into `{ child, delta, reason }`.
- `store.js` holds the Google Tasks and demo storage.
- `ai.js` holds the optional AI helper (Claude or Gemini): reading free-text entries, writing summaries and hiding names.
- `app.js` handles the interface and sign-in.
- `npm test` runs the parser and storage tests (Node 20+).
