## Brower Extension Implementation

Developer todo list

user flowSat Feb 7, 2026

**o help you design the "Library View" where the user sees their clips?** I 

### Description

***I am creating a browser extension that will  enable the user to clip web snippets or urls,  assign them a category, a rank as to how interesting it is (Options: Noise*, Neutral, Interesting, Insightful, Wise*) and  a rank as to how ethical it is (Options: *Malicious, Sketchy, Neutral, Good, Exemplary*). It will store the clips locally as well as broadcast them over Nostr. Clips can be marked private in which case they will be broadcast encrypted.  A companion website will be created that will display the clippings** and allow filtering and sorting based on their category, interest  ranking or ethic  ranking, as well as if they are were broadcast by friends/follows.

### How the User Flow Works:

1. **Clip:** User finds a site/video.

2. **Cast:** User assigns a worth.

3. **Store:** The clip is saved to **IndexedDB** (Free local storage).

4. **Broadcast:** The "Stamp" is sent to Nostr (Public proof).

### **1. The "Control Deck" Layout**

Imagine the extension window is a slim horizontal rectangle. Under the URL of the site, you have one row with three combo boxes:

. The Evaluation UI (Strict Requirements)

Create a UI Overlay (Sidebar or Modal) with these exact 3 dropdown options in a horizontal row, each one should default to the default value and the axis 3 should be able to be typed in for a custom category:

\* \*\*Axis 1: Interest\*\* -\> \[Wise, Insightful, Interesting, Neutral, Noise\]  default:Neutral

\* \*\*Axis 2: Ethics\*\* -\> \[Exemplary, Honest, Biased, Neutral, Misleading, Malicious\] default:Neutral

\* \*\*Axis 3: Category\*\* -\> \[General, Tech, Finance, Health, Politics, Philosophy, Science, Culture\] default: General


- **Box 1: Interest** (Options: *Boring, Neutral, Interesting, Mind-blowing, Wise*)

- **Box 2: Ethics** (Options: *Malicious, Sketchy, Neutral, Good, Exemplary*)

- **Box 3: Category** (Options: *Main, Education, Entertainment, Finance, Hobbies, News, Politics, Tech, \[ + Custom \]*)

**Left Button (Outline/Subtle):** **CAPTURE** (Saves as an encrypted private note in your Signal Log).

Saves the data strictly to **IndexedDB**. The Nostr signing and relay broadcast are skipped. **The Encryption:** The extension encrypts the clip and the "Worth" data using the user’s own public key. T**he Broadcast:** It is sent to the Nostr relays as a "Private Note." **The Result:** The data is physically "out there" on the network (safe from browser wipes), but **only the user** who owns that private key can decrypt and read it.


**Right Button (Solid/Primary):** **CAST** (Broadcasts a public "Worth Stamp" to the Nostr network).

Saves to IndexedDB *and* broadcasts the signed "Stamp" to Nostr.


- **Behavior:**

  - **Checked:** 

  - **Unchecked:** 


### 2. Handling the "Custom Category"

To keep this from getting cluttered, the **Category** combo box should be "searchable" or "editable."

- **The UX Flow:** When the user clicks the Category box, they can either scroll to "Main" or just start typing.

- **The Logic:** If they type a word that doesn't exist (e.g., "Nostr-Dev"), a small "Add New" button appears. Once they hit "Broadcast," that category is saved to their **IndexedDB** so it appears in the dropdown next time.

- make sure the combo box has a **"Type-to-Filter"** feature. If a user types "T," it should jump straight to **Tech**. This keeps the "one-second" goal alive. 


### 3. Visual Feedback: The "Live Signal"

Since your brand is **WorthCast** (the Signal Tower), you can make the UI feel alive:

- As they change the Ethics box to "Bad," the Signal Tower icon in the corner could glow **Red**.

- If they set Interest to "Mind-blowing," the signal waves coming off the tower could become **more intense/vibrant**.


### Share Card- The Viral "Stamp" (What it looks like)

When that item is shared—whether it’s a link on X (formerly Twitter), a Note on Nostr, or a message in a group chat—it generates a **Preview Card** with the **WorthCast Stamp** overlay.

- **The Icon:** Your **Signal Tower** icon appears in the corner.

- **The Gradient:** The border of the preview card glows based on the value (Green for Good, Yellow for Interesting, Red for Bad).

- **The Verified Badge:** A small text line says: *"Ascribed by \[User's NIP-05 Name\] via WorthCast."*


### Sharing via Nostr (The Protocol Flow)

### 1. For \[ CAST \] (Public Highlights)

**Event Kind: 9802 (Highlights)**

This is the standard established by **NIP-84**. Using this ensures that other Nostr apps (like Highlighter or Habla) can "see" your public casts, giving your users immediate reach.

- **Content:** The rich-text (HTML) snippet you clipped.

- **Tags:**

  - `\["r", "URL"\]`: The source website link.

  - `\["title", "Page Title"\]`: The title of the website.

  - `\["alt", "Snippet from \[Title\]"\]`: A plain-text fallback for clients that don't support HTML.

  - **The WorthCast Secret Sauce (Custom Tags):**

    - `\["interest", "Wise"\]`

    - `\["ethics", "Exemplary"\]`

    - `\["category", "Tech"\]`

>   - **Why this is genius:** By putting your grading axes in the `tags`, people can search the Nostr network specifically for "Wise Tech" highlights across all users.


### 2. For \[ CAPTURE \] (Private Vault)

**Event Kind: 31234 (Drafts) or 30078 (App Data)**

For private storage, you want to use **NIP-44 Encryption**. This ensures only the user can read their private captures.

- **The Method:** You take the same JSON structure as a public "Cast" (the snippet + your 3 boxes), but you **encrypt the entire content string**.

- **Option A (Kind 31234):** Usually used for "Drafts." This is good if you think a user might want to "Capture" something now and "Cast" it later.

- **Option B (Kind 30078 - Recommended):** This is for "Arbitrary App Data." It tells other Nostr clients, "This belongs to WorthCast." It’s the cleanest way to store a private library that won't clutter up a user's public social feed.

- **Encrypted Tag:** You should also encrypt the tags (Interest/Ethics) inside the content so that relays can't even see the "Metadata" of what the user is private-saving.


### 3. The "Meta" Logic (Managing the Library)

To make your app feel "pro," you should use one more event kind:

**Event Kind: 10003 (Bookmarks)**

- **Purpose:** This is a "Replaceable List." Instead of searching through thousands of old events every time the app opens, you maintain a single "Master List" of the IDs of all the user's favorite or recent Casts/Captures.

- **Benefit:** It makes your **Library View** load instantly.


### Summary Table for Developers

| **Action** | **Nostr Kind** | **NIP** | **Access** |
| - | - | - | - |
| **Cast** (Public) | **9802** | 84 | Public / Interoperable |
| **Capture** (Private) | **30078** | 78 | Encrypted (NIP-44) |
| **Library Index** | **10003** | 51 | Master List of IDs |

### Technical Tip: The "Label" Tag

To make your "Ethics" and "Interest" ratings even more powerful, you could use **NIP-32 (Labeling)**. This is a specific NIP designed for "rating" or "labeling" things.

Instead of a custom tag, you would use:

`\["l", "Exemplary", "ethics"\]`

`\["l", "Wise", "interest"\]`


Because you are broadcasting over Nostr, sharing works natively with the protocol:

- **The Event:** The "Stamp" is actually a **Nostr Event (Kind 1984 or similar)**.

- **The Relay:** When the user shares the clip, the "Stamp" is broadcast to their chosen relays.

- **The Social Proof:** Anyone else using the WorthCast extension who sees that link will see your "Stamp" floating over it in real-time. It’s like seeing a "Heads Up" from a friend before you even click the link.


### How the "Stamp" looks now (The Summary):

When a user shares a clip, the **WorthCast Stamp** essentially says:

> **"This is a \[Wise\] piece of \[Tech\] content with \[Exemplary\] ethics."**

That is a very powerful "Nutrition Label" for the web.

#### Rich text selection

- **Capture the Selection:** Instead of using `window.getSelection().toString()`, the extension uses `window.getSelection().getRangeAt(0).cloneContents()`. This grabs the actual HTML elements (the "tags") along with the text.

- **Sanitize the HTML:** You don't want to save malicious scripts from a random site. You use a library (like `DOMPurify`) to "clean" the HTML so only the formatting (like `\<b\>`, `\<i\>`, `\<a\>`, `\<ul\>`) remains.

- **Storage in IndexedDB:** You store this "Clean HTML" as a string in your database.

- Your extension can ask the browser for `navigator.storage.persist()`. **The Result:** Once granted, the browser will **not** delete your IndexedDB data even if the user clears their history or cache, unless they specifically go into "Advanced" settings to wipe extension data.


- **Display:** When the user opens their **Library**, you tell the browser to render that string as HTML. The clipping will look exactly like it did on the original website.


### **The "Nostr Backup" (The Stealth Safety Net)**

Since you are already a Nostr app, you have a unique advantage. Even for "Local Only" clips, you could offer a **Private Backup**:

- **Encrypted Notes:** You can encrypt the clip data using the user's public key (NIP-04 or NIP-44) and send it to a Nostr relay as a "Private Note."

- **The Benefit:** To the public, it looks like gibberish. But if the user clears their browser, they can "Restore from Relay," and the extension will decrypt their clips and put them back in the library.

### **How Syncing Back Works (The Technical Flow)**

If the user gets a new computer and installs the **WorthCast** extension:

1. They enter their Nostr Public Key (or use an extension like Alby/Nos2x).

2. WorthCast queries the relays for all events signed by that key.

3. The extension "re-fills" the **IndexedDB** library with all the rich-text clips and worth-values.

4. **Result:** Their library is back in seconds, exactly how they left it.


#### Data Structure for IndexedDB

Since you’re using **IndexedDB** (the free local storage we discussed), you’ll want to organize your "columns" to reflect these three things. This makes your **Library** searchable later.

| **Field Name** | **Data Type** | **Example Value** |
| - | - | - |
| `id` | String (Primary Key) | A unique hash of the URL + Timestamp |
| `url` | String | `https://example.com/video-clip` |
| `interest\_score` | Integer | `3` (out of 5) |
| `ethics\_score` | String | `"Good"` |
| `category` | String | `"Main"` |
| `nostr\_event\_id` | String | The ID of the broadcast on Nostr |
| `clipping\_text` | Blob/Text | The actual highlighted text from the site |



## Your OpenSats "Win" Strategy

OpenSats loves projects that are **lean** and **interoperable**.

**Don't try to build a social network.** Build the *tool* that creates the data. If your MVP successfully sends Kind 9802 events, users will immediately see their WorthCasts show up on other Nostr apps like **Habla** or **Highlighter**. This "instant ecosystem" is your biggest selling point.

### **The MVP Checklist:**

- \[ \] **Manifest v3** Extension setup.

- \[ \] **HTML Clipping** logic (using `getSelection`).

- \[ \] **NIP-07** Login support (letting users use Alby/Nos2x to sign).

- \[ \] **Simple Database** (IndexedDB) for local persistence.

- \[ \] **Basic Feed** to view what you've saved.


### **The Mission Statement (Preview)**

If you were to apply today, your headline would be:

> *"WorthCast: A decentralized browser extension for ascribing value to the web. We turn the act of bookmarking into an act of signaling, allowing users to build private wisdom vaults and public ethics maps using Nostr."*

