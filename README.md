# MangaDex - Cloud

A userscript for MangaDex that recalibrates the rating scale, tracks your personal ranking (`#Rank`) across all titles you browse, and lets you write private notes on manga pages. Everything can be synced across devices using a private GitHub Gist or stored locally in the browser.

<img width="700" height="407" alt="Mangadex-Cloud 1" src="https://github.com/user-attachments/assets/e0decc5f-6ad9-45dd-8b18-bb4671b0f8ff" />


## Why recalculate ratings?

Default Bayesian ratings on MangaDex are heavily compressed. Almost every series sits somewhere between 7.50 and 9.20, which makes it hard to tell an average manga apart from a great one at a glance.

This script takes the original Bayesian score ($x$) and applies a quadratic formula to spread that crowded range across a full 0–10 scale:

`Score = -0.03256 * (x - 5.5)^2 + 2.5177 * (x - 5.5)`

* **7.50** becomes **4.91**
* **8.00** becomes **6.09**
* **8.50** becomes **7.26**
* **9.00** becomes **8.41**
* **9.50** becomes **9.55**

Scores are color-coded (red to green/cyan) and cached as you browse. Based on the titles you've seen so far, the script calculates and displays each manga's `#Rank` in your database. You can still keep the original MangaDex rating visible in parentheses if you want both.

## What it does

* **Title Page:** Shows the recalculated score, `#Rank` badge, and a personal note card under the synopsis (`Ctrl+Enter` to save, `Esc` to cancel).
* **Home Page:** Adds ratings, ranks, and your personal notes directly to the *Popular New Titles* carousel, and replaces the comment icon in *Latest Updates* with the manga's score.
* **Feeds, Search & Follows:** Displays custom ratings on chapter feeds (on the cover, next to the flag, or on the right), search results, follow lists, and the top navigation search bar (including while reading a chapter).
* **Device Profiles:** You can create multiple layout profiles (e.g., Desktop and iPad) with separate visibility toggles and badge positions. The settings menu can also be resized by dragging its bottom-left corner.

## Compatibility

* **Desktop:** Tested on Chrome / Edge / Firefox with **Tampermonkey**.
* **iPad (iPadOS):** Tested with **Alook Browser** (via built-in userscript support). Also works with Safari using the Userscripts / Tampermonkey extension.
* **Android (Phones & Tablets):** Should work on browsers with extension support like **Kiwi Browser** or **Firefox** (with Tampermonkey), though not extensively tested.


<img width="700" height="546" alt="Mangadex-Cloud 2" src="https://github.com/user-attachments/assets/0b22aa4f-a9d0-4741-9eb9-2ac4883fd8e4" />

## Installation

* **From Greasy Fork:** Install a userscript manager like [Tampermonkey](https://www.tampermonkey.net/), then click the green **Install this script** button.
* **From GitHub:** Make sure Tampermonkey is installed, open the `.user.js` file in this repository, and click the **Raw** button at the top right. Tampermonkey will automatically open the installation prompt. (Alternatively, copy the file contents and paste them into a new script in your userscript manager, such as Alook Browser on iPad).

## Setup & Sync

On your first visit to MangaDex after installing, a setup prompt will appear:

1. **GitHub Cloud Sync (Recommended):**
   * Click the `?` icon next to the Token input for a direct link to generate a GitHub Personal Access Token (only the `gist` permission is needed).
   * Paste your token (`ghp_...`).
   * **First device:** Leave the **Gist ID** box empty and click **Connect**. The script will automatically create a private `mangadex-data.json` Gist in your account.
   * **Other devices (e.g., iPad):** Open Settings -> click your profile name at the top right -> click **Change Token / Gist** -> click **Copy ID**. Paste both your Token and this Gist ID on your second device so they use the same database.
2. **Local-Only Mode:**
   * If you don't want to use GitHub, check the confirmation box at the bottom and continue with Local Storage. Keep in mind that clearing your browser data will delete your notes and cached ratings.

### Cloud Icon States (Top Right Navbar)
* **No dot:** Synced. Click the cloud icon to open Settings.
* **Red dot:** Unsaved changes waiting for the auto-sync timer (default is 4 seconds, configurable to 1m, 10m, custom, or manual-only). **Click the cloud icon while the red dot is visible to sync immediately.**
* **Orange dot:** Setup required, or cloud fetch failed (switches to read-only local backup mode so your cloud data doesn't get overwritten).
