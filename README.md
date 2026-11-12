# Fabula

A small chat page for brainstorming stories and translating them. It runs entirely in the browser and talks directly to the [Mistral API](https://docs.mistral.ai/). There is no server.

- **Pomysły** (ideas): a writing helper that asks questions and suggests options instead of writing the story itself.
- **Tłumaczenie** (translation): a literary translator into a chosen language (Polish, English, Dutch, Persian, Spanish).

The system prompts are in `prompts.js`.

## Setup

1. Create a Mistral API key at <https://console.mistral.ai/>. Set a spending limit on the workspace.
2. Optional, for syncing between devices: create a fine-grained GitHub token with access to `gchrupala/app-data` only and the permission *Contents: Read and write*.
3. Open the page. The settings dialog opens on first use. Enter a name (used as the folder in `app-data`), the Mistral key and, optionally, the GitHub token.

Keys are stored in the browser's local storage on that device.

## Bold and italics

When text is pasted from a document or web page (Google Docs, Word, a browser), bold and italics are kept as Markdown marks (`**bold**`, `*italics*`) in the text field. Her messages show these two kinds of formatting and nothing else, so a line of dialogue starting with "- " stays as it is. The model is told that the marks are her formatting, and the translator keeps them in the translation.

## Story notes

*Notatki* opens her story notes: free text with titles, characters, names and places she has decided. They are added to the writing helper's instructions in every *Pomysły* conversation, so it knows her stories across conversations. *Uzupełnij z tej rozmowy* asks the model for a draft of new notes from the open conversation and adds it to the end of the text, for her to check and edit before saving. The notes are synced with the conversations.

## Long translations

Models tend to stop early on long texts, or to skip the second half. A text to translate of more than 900 words is therefore split into parts of about 700 words at line breaks, and the parts are translated one after another, each with the previous part and its translation as context. Translations have no length limit, and a part that still stops because of length is continued automatically. Writing-helper replies are limited to 1200 tokens.

## Long conversations

Only the most recent part of a conversation is sent to the model: at most 40 messages and 40,000 characters (the latest message is always sent). The model is told when earlier messages are hidden.

## Data

Conversations are kept in local storage. When a GitHub token is set, they are also synced to `<name>/fabula.json` in `gchrupala/app-data`, following the format of the other apps there (`{"fabula": 1, "saved", "device", "data": {"conversations", "notes"}}`). The app was earlier called Biblioteka: if `<name>/fabula.json` does not exist yet, the conversations are read from `<name>/biblioteka.json` and saved under the new name. Sync runs on page load, when the page becomes visible again, a few seconds after each reply, and on the *Synchronizuj* button. Conversations from several devices are merged; for the same conversation, the most recently changed version wins.

## Hosting

GitHub Pages serves the page from the root of `main` (*Settings → Pages → Deploy from a branch*) at <https://fabula.maxapki.top/> (custom domain set in `CNAME` and under *Settings → Pages*). Every push to `main` redeploys it.

The page can be installed as an app: in Chrome or Edge via the install icon in the address bar or *Install app* in the menu, on Android via *Add to home screen*, on iPhone/iPad via *Share → Add to Home Screen* in Safari. `manifest.webmanifest`, `sw.js` and `icons/` make this possible.

The page also works when `index.html` is opened directly from disk, but cannot be installed that way.

## Model

The default model is `mistral-large-2512` (Mistral Large 3), a fixed version: `mistral-large-latest` moved to Mistral Large 4 in November 2026, which always reasons before answering. Devices that had the earlier default, `mistral-small-latest`, are switched to it once. The model can be changed in the settings; the field suggests the models the key can see. If the Mistral plan does not include the chosen model (error 403), the app tries `mistral-small-latest`, `open-mistral-nemo` and `ministral-8b-latest` in that order and keeps the first one that works.
