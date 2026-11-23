# Bored Arcade

A game hub with all our browser games, hosted on one Render site.

```
/                 -> the arcade hub (public/index.html)
/storm-drop/      -> Storm Drop .io (public/storm-drop/index.html)
/stick-rounds/    -> Stick Rounds (public/stick-rounds/index.html)
/rocket-rivals/   -> RocketRivals (public/rocket-rivals/index.html)
/sleigh-rider/    -> Sleigh Rider 3D (public/sleigh-rider/index.html)
```

- `server.js` serves everything in `public/`, runs the live multiplayer rooms for every game (WebSocket at `/ws`, each game/room code gets its own room), and stores accounts.
- The hub shows how many people are in each game right now (`/api/stats`).
- **Adding a new game later:** put its HTML in `public/<game-name>/index.html`, add a screenshot to `public/img/`, and copy one of the game cards in `public/index.html`.

## Update log
The hub shows an Update log (and the ✨ button). Admins can add or remove entries in the 🛡 admin tools. Updates shipped in code are listed in `SHIPPED_UPDATES` in `server.js`; each one is added to the log once, by its `id`.

## Visitor counts
Admins see a 📊 Visitors panel in the 🛡 admin tools: people and page views per day, and per game, for the last 14 days. No cookies or outside trackers; a visitor is a one-way hash of IP + browser + date, so IPs aren't stored. Optional: set `VISIT_SALT` on Render to any random text so counts stay consistent across restarts.

## Sleigh Rider 3D leaderboard
Solo endless sleigh run. Scores post to `/api/sleigh/scores` (best score per name, stored with the accounts, so set `DATABASE_URL` to keep it). Logged-in arcade players post under their account name with a ✓; guests pick a name.

## Stick Rounds online
On this site, Create room / Join with a 4-letter code goes through our own server, so it works for anyone with the link (no sign-in needed).

---

# Storm Drop .io

An 8-bit multiplayer battle royale. Drop from the ship, grab loot, outlast the storm.

## Files
- `public/index.html` — the whole game (graphics, controls, bots)
- `server.js` — serves the page and relays players' live positions/shots to each other
- `package.json` — tells the host to install `ws` + `pg` and run `node server.js`

## Run it on your own computer (optional)
1. Install Node.js 18+ from https://nodejs.org
2. In this folder: `npm install` then `npm start`
3. Open http://localhost:3000 in two browser tabs — you're playing against yourself.

## Put it online for free (Render.com)
1. Make a free GitHub account and create a new repository (e.g. `storm-drop`).
2. Upload every file in this folder to it (`server.js`, `package.json`, `README.md`, and the `public` folder). Don't upload `node_modules`.
3. Go to https://render.com, sign up with GitHub, click **New + → Web Service**, and pick your repo.
4. Settings:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
5. Click **Create Web Service**. In a minute or two you get a link like `https://storm-drop.onrender.com` — send it to anyone and they're in the same match.

Note: Render's free tier sleeps after ~15 minutes with nobody on it. The first visitor after that waits ~30–60 seconds for it to wake up. Paid tiers ($7/mo) stay awake.

Other hosts that work the same way (Node + WebSockets): Railway, Fly.io, Glitch-style hosts.
Static-only hosts (GitHub Pages, Netlify, itch.io) will load the game but only in solo-vs-bots mode, because they can't run `server.js`.

## Accounts (email + password) — save progress forever
Players can sign up with an email and password on the main menu. Coins, bought items, equipped cosmetics, stats and name are saved to the account, so they carry over to any device.

**Important for Render's free plan:** Render wipes its disk every time the server restarts or goes to sleep, so accounts need a real database. Use a free Neon Postgres database (it doesn't expire):
1. Go to https://neon.tech, sign up (free, no card), and create a project.
2. On the project dashboard click **Connect** and copy the connection string (starts with `postgresql://...`).
3. In Render, open your web service → **Environment** → **Add Environment Variable**:
   - Key: `DATABASE_URL`
   - Value: the connection string you copied
4. Save. Render redeploys, and the logs should say `Accounts stored in: Postgres (DATABASE_URL)`.

Without `DATABASE_URL` the game still works, but accounts are kept in a temporary file and will disappear when Render restarts.
Passwords are stored hashed (scrypt), never in plain text. There's no "forgot password" email yet, so pick one you'll remember.
Progress is still saved in the browser for people who don't make an account.

## Coins & shop
- Earn coins: **+15** per elimination, **+100** per win, **+5** for every match you play.
- Open **Locker** to spend them. Every hat, pattern and parachute has a price; tap an item once to see it, tap again to buy.
- Coins from before this update were converted: old stats were turned into coins and anything you'd already unlocked stays yours.

## Ranked
Every match gives ELO toward your rank (saved to your account):
- **+10 ELO per elimination** (always the same)
- Placement: 1st **+60**, 2nd **+45**, 3rd **+38**, 4th-5th **+30**, 6th-10th **+20**, 11th-15th **+12**, 16th-20th **+6**, lower **+3**
- Team modes: winning team +60, losing team +20
- Ranks: Bronze (0) → Silver (400) → Gold (1000) → Plat (2000) → Diamond (3500) → Grandmaster (5500)
Your rank shows on the menu, in the end-of-match screen, and as a coloured gem next to your name.

## New items
- **Shockwave grenades** (V): throw to launch everyone nearby (you too) into the air. No damage.
- **Grappler**: shoot it at a wall, tree, rock or crate and it pulls you there.
- **Kinetic Blade**: melee sword that dashes you forward with every slash.

## Limited-time modes (pick with the Mode button in the lobby)
- **Solid Gold**: every gun is legendary.
- **One Shot**: snipers only, low gravity (jump pads/shockwaves go further), any hit eliminates.
- **Floor is Lava**: lava pools grow across the map. Stand in buildings, on towers/rooftops, or keep moving.
- **Team Rumble**: Red vs Blue with respawns (5 seconds). First team to 25 eliminations wins.
- **50 v 50**: Red vs Blue, no respawns. Last team standing wins.

## Maps & voting
- Every match has a brand new random layout.
- In the lobby, vote for the next map: 🌳 Green Valley, 🎄 Winter Wonderland (snow, Christmas trees, presents, snowmen, candy canes, a giant decorated Christmas tree), 🌵 Dusty Dunes (cacti, skulls, barrels), 🎃 Spooky Hollow (night time, glowing pumpkins, a graveyard).
- The most votes wins; ties and no votes pick randomly. Voting locks a second before the drop ship leaves.

## How duos work
In the lobby, click **Invite** next to a player (or walk up to them and press **T**). They click **Accept**. Teammates can't hurt each other, show in green, and can revive each other: hold **E** next to a knocked teammate for 4 seconds.

## 3D graphics
- The game now renders in 3D using three.js (loaded from cdnjs, so players need internet - same as the fonts).
- **Settings → 3D graphics** switches to Classic 2D; **High quality** toggles shadows/sharpness for slower computers.
- If a computer can't run 3D, the game automatically falls back to Classic 2D.

## Towers, lighthouse & two-story houses
- 4 wooden watchtowers, a Lighthouse landmark (top right) and the 3 biggest houses now have a deck up top.
- Walk into the stairs to climb up; walk off the stair side to come down.
- Up high you see farther, and your shots and grenades fly over walls, trees and rocks. You can't loot or use jump pads up there.

## Building
- Punch trees (+12 wood) or rocks (+8), or break crates (+20) to collect wood (max 400).
- Press **B** for build mode: a blue ghost wall shows where it goes (red = can't place). Click to place a wall for 10 wood.
- Walls snap to a grid and face where you aim, so you can box yourself in. Each wall has 150 HP; bullets, rockets and grenades break them.
- Up to 24 walls per player; your oldest wall breaks if you build more. Switching weapons leaves build mode.

## Character & hit effects
- Characters have little feet that walk, plus a bob and squish when moving.
- Muzzle flashes, sparks on walls, wood splinters that bounce off crates, and a small screen kick on big guns (turn off with Screen shake).

## Starting a match & keybinds
- Matches only start when someone presses **START MATCH** in the lobby (6-second countdown after).
- If you join while a match is running, you can press **Play bots while you wait**.
- Every control (including shooting) can be changed in **Settings → Keybinds**. Two keys per action; Backspace clears; Reset restores defaults.

## Modes, supply drops, new gear
- **Party modes** (lobby panel): Classic, Snipers Only, Shotgun Brawl, Grenade Chaos, Fists Only, Tiny Map.
- **Supply drops**: 3 per match, announced in chat and shown on the map. Press E to open.
- **New weapons**: Bow, Rocket Launcher (epic/legendary), Heal Dart (heals your duo).
- **Jump pads** (blue) and **bounce mushrooms** (red) launch you.
- **Settings** (gear button): sound/music volume, chat filter, screen shake, damage numbers, FPS.
- After you're eliminated you get a **match summary** and can **spectate** with your target's health, gun and kills shown.

## Chat & lobby controls
- Press **Enter** to chat (bottom-left). Enter sends, Esc cancels.
- In the lobby panel: **Start now** skips the countdown, and **Bots: Normal / Few / Off** picks how many bots join.
- The player with the most eliminations gets a crown (kill leader).

## Landing, grenades, locker
- During the lobby countdown or the plane ride, click the map (M) or minimap to drop a landing flag. You auto-jump and glide to it; your duo sees your flag.
- Grenades come from crates and chests. Press **C** or right-click to throw.
- **Locker** (menu or lobby) has hats, patterns and parachute colors, unlocked by playing. Progress is saved in each player's browser.

## Map
Press **M** to open the full map (town names, A–H / 1–8 grid, storm, teammate, pings). Click it to ping.

## Pings
Press **G** (or middle-click) to ping where your mouse is, or click the minimap. Your duo partner sees the marker, plus an arrow at the screen edge if it's off-screen.

## Tweaks
- Max players per server: `MAX_PLAYERS` in `server.js` (default 40).
- Bots fill matches up to 16 total players — search for `spawnBots` in `public/index.html`.
- Lobby countdown: `PRE=15` (seconds) in `public/index.html`. If you're alone in the lobby it drops to 5 seconds, and if a match is already running without you, you get a private bot match.
