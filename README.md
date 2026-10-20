# Chat Translator for WhatsApp Web

**Read any incoming WhatsApp Web message in Chinese — inline, under bubble, no copy-paste.**

A Chrome extension (Manifest V3) that detects each incoming message, detects its language, and renders a compact translation right below the original text. Built for people selling to customers in Spanish, Portuguese, Arabic, English, Russian and 100+ other languages.

English | **[中文说明](README.zh-CN.md)**

![Screenshot](docs/screenshot-chat.png)

## What it does

- **Inline translations** — the translation is inserted *inside* the bubble, right under the original text. The original message is never modified.
- **Auto language detection** — Spanish, Portuguese, Arabic, English, French, German, Russian, Turkish, Indonesian and more. A small tag shows which language was detected.
- **Context-aware** — optionally sends the previous 1–2 messages of the same conversation along with the message being translated, so short unpunctuated chat lines are parsed correctly.
- **Glossary** — pin your own terms (`pedido=订单`, `MOQ=最小起订量`) so a word is always translated the way your industry says it.
- **One-click refine** — click the small `AI` tag on any translation to re-translate that single message with a large language model, using context.
- **Survives WhatsApp redesigns** — messages are located by `[data-id]` and a four-level fallback chain, so class-name churn does not break it. Re-rendered DOM is repopulated automatically.
- **Cached and cheap** — every translated string is cached locally (4000 entries). Scrolling back never re-requests, never costs money.
- **Skips noise** — emoji-only, numbers-only, links-only and already-Chinese messages are ignored. Quoted replies are not double-translated.

| Popup | Settings |
| --- | --- |
| ![Popup](docs/screenshot-popup.png) | ![Settings](docs/screenshot-options.png) |

## Install (3 steps)

1. Open Chrome and go to `chrome://extensions/`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this folder

Then open (or reload) `https://web.whatsapp.com`. Translations appear automatically. No account, no sign-up, no server.

> Works with WhatsApp Business accounts too — they use the same `web.whatsapp.com` page.

## Translation engines

| Engine | Setup | Quality | Notes |
| --- | --- | --- | --- |
| **Google** (default) | none | ★★☆ | Free, fast, 100+ languages. Translates each sentence in isolation. |
| **DeepL** | API key | ★★★ | Better for European languages, supports passing conversation context. 500k chars/month free. |
| **LLM** | API key | ★★★★★ | Understands context, tone and industry terms. Any OpenAI-compatible endpoint works. |

The LLM channel works with any OpenAI-compatible API:

- DeepSeek — `https://api.deepseek.com/v1`, model `deepseek-chat`
- Qwen — `https://dashscope.aliyuncs.com/compatible-mode/v1`, model `qwen-plus`
- OpenAI — `https://api.openai.com/v1`, model `gpt-4o-mini`

Cost reference: roughly **$0.00008 per message** on DeepSeek, including context and system prompt. A 500-message day costs a few cents.

## Why context matters

Chat messages arrive without punctuation. A single-sentence machine translation can easily mis-attach an adverbial phrase:

| | |
| --- | --- |
| Original (pt) | `Olá desculpe a demora na segunda feira vejo isso` |
| Single-sentence MT | "Sorry for the Monday delay, I saw this" |
| Correct | "Hi, sorry for the wait — I'll look into it on Monday" |

`na segunda feira` modifies `vejo isso` (I'll handle it on Monday), not `desculpe a demora`. No word-level engine can resolve this in isolation. That is why this extension can pass the surrounding messages to the model, and why the built-in prompt instructs the model to segment the sentence before translating.

## Privacy

- No backend, no analytics, no tracking. Nothing is sent anywhere except to the translation provider you choose.
- Only the text of a message being translated leaves your browser (plus the optional 1–2 previous messages as context, when enabled).
- Translations are cached in `chrome.storage.local` on your machine and can be cleared at any time.
- Permissions are limited to `web.whatsapp.com` and the translation endpoints. Custom LLM domains are requested at runtime, only when you enter one.

## FAQ

**Nothing happens after installing.** The content script is injected on page load — reload WhatsApp (F5).

**Some messages have no translation.** Images, voice notes and stickers have no text. Quoted replies are skipped. Pure emoji, numbers and links are skipped by design.

**Translation failed.** Hover the error line to see the reason. Usually rate limiting or a proxy issue — click to retry.

**WhatsApp changed its DOM and translations stopped.** Open the popup → **Diagnose**. It reports how many message rows were found, whether text could be extracted, and why requests failed. If you file an issue, paste that report.

**Can I use it with a WhatsApp Business desktop app?** No — Chrome extensions cannot run inside a native app. Open `web.whatsapp.com` in Chrome instead, or use *Create shortcut → Open as window* for a standalone-looking window.

## Project layout

```
manifest.json      # MV3 manifest
content.js         # find messages, extract text, insert translation blocks
content.css        # translation block styling (light + dark)
background.js      # all network calls (Google / DeepL / LLM), context & glossary
popup.html/js/css  # toolbar popup
options.html/js/css# settings page
diagnose.html/js   # DOM diagnostics when something stops working
preview.html       # static style preview, not part of the extension
icons/             # extension icons
```

If WhatsApp changes again, only two functions need updating: `collectMessageEls()` and `extract()` in `content.js`.

## License

MIT — use it, fork it, ship it.
