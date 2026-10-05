# AI assistant

UwUMail's assistant helps with mail: writing and rewriting, summaries of a mail
or a conversation, a second opinion on spam, appointments read out of a mail,
and your own labels on new mail. It is off until someone sets it up. What it
writes stays a preview until you click *Insert* or *Replace*, auto-labels only
run when you switch them on, and it never sends, moves or deletes anything.

How it is built (scopes, limits, prompt checks) is in
[architecture.md](architecture.md#ai-assistant); this page is for using it.

## Where it runs

Every mailbox gets its assistant from one of two places, shown as sections
under *Settings → AI assistant*:

| Mailbox | Assistant | Who asks the model |
| --- | --- | --- |
| On a UwUMail server (JMAP) | the server's, set up by its admin, plus your own providers there if the admin allows | the server |
| Every other mailbox (IMAP, other JMAP servers) | *This device*: the providers you set up in UwUMail | UwUMail, straight from your device |

### Mailboxes on a UwUMail server

The server's admin adds providers in the portal (*Server → Settings → AI
assistant*): for everyone, some domains or some people, for some or all
features, with daily limits per person in requests and tokens, and per provider
a switch whether people see what it costs. Where the admin allows it, you can
add providers with your own key on the server too (the portal, the webmail or
here). Your choices — model per feature, labels, appointments on every mail,
currency — follow the account to every device.

The server's [AI assistant guide](https://github.com/MinifyX/UwUMail-Server/blob/main/docs/llm.md)
has the details for admins.

### This device

For all other mailboxes, add a provider under *Settings → AI assistant → This
device → Add provider*:

| Kind | What you need |
| --- | --- |
| OpenAI | an API key (a ChatGPT subscription is not one) |
| Anthropic Claude | an API key; Claude subscriptions can't be used by other programs |
| Google Gemini | an AI Studio key; for mail, from a project with billing (the free tier may be used to improve Google's products) |
| Mistral | an API key |
| OpenRouter | an API key; what happens to the data depends on where it is routed |
| Ollama | the address, no key |
| OpenAI-compatible | the address up to `/v1` (LM Studio, vLLM, llama.cpp, LiteLLM, a company gateway), a key if it needs one |

*Test & load models* checks the provider and fills the model list. Each
provider has a model for writing and a cheaper, faster one for everything else;
you can pick a different provider per feature.

- Keys go into the system's keychain; the settings only ever show their last
  four characters.
- Addresses must use `https`, except Ollama and OpenAI-compatible servers on
  this computer or in the local network, which may use `http`.
- There are no daily limits on this device: the provider bills you, or it is
  your own machine.

## Local models in one click

When an **Ollama** (`http://127.0.0.1:11434`) or **LM Studio**
(`http://127.0.0.1:1234`) runs on the same computer, the device's provider
settings say so and offer it with one click, with the models that are
installed to choose from. Nothing leaves the computer then, and it costs
nothing. Small local models are slower and follow the answer formats less
reliably; UwUMail checks every answer and drops what doesn't fit.

LM Studio needs its local server running to be found.
Ollama or LM Studio on another machine in your network can be added by hand as
an Ollama or OpenAI-compatible provider with its address.

## Before you click: tokens and cost

Hovering an AI button (a long press on the phone) shows a line like

> ≈ 1,250 tokens · ≈ €0.02 (max €0.05) · 48,000 left today

and below it a small table: input, pictures, answer, thinking, extra calls by
what they are for (e.g. *2 × reading pictures, retry (sometimes)*) and fees,
only the lines that aren't zero. On a menu's items the tooltip sits beside the
item, so it never covers the next one; near the bottom of the screen it opens
above the button.

- **Tokens:** everything the request would take: the prompt with what the API
  adds around it, the expected answer, the thinking of reasoning models (OpenAI's
  o-series and gpt-5, Gemini 2.5, DeepSeek R1, Qwen 3 …; Claude is never asked
  to think) and every further call the request makes. Text is counted at about
  four characters a token — an estimate, since every provider counts with its
  own tokenizer. For mailboxes on a UwUMail server the server builds the real
  prompt and counts it (a server older than 0.19.0 shows no tooltip, one older
  than 0.20.0 no breakdown); for other mailboxes UwUMail counts the same way on
  the device, where a request is always one call (pictures are read on the
  device for free). The estimate is free and counts against nothing.
- **Learning from real calls:** after at least five real requests of a feature
  with the same provider and model, the estimate follows what the last 50 really
  took (the median, never less than half or more than three times the rough
  count). The tooltip then says *Calibrated from your last calls*.
- **Cost:** always for your own providers; for a server's provider only when
  its admin switched on showing costs. Prices come from LiteLLM's public price
  list (and OpenRouter's own): input, output, reasoning, cached input, fees per
  request and per picture, and higher prices above a prompt size. They are
  converted with the European Central Bank's reference rates, fetched at most
  once a day and kept for offline use. A price set by hand on a provider (US
  dollars per million tokens, in and out) comes first; Ollama and local servers
  are free. *max* is the worst case: every call writing as much as it may.
- **What it really cost:** after a request, from what the provider reports:
  cached input at the cache's price, reasoning apart, the request's fee, and
  OpenRouter's own figure where it gives one.
- **Left today:** what remains of a server's daily limit; left out when there
  is none.
- **Currency:** euros; in English you may choose US dollars instead (*Settings →
  AI assistant → Costs*).

The usage view under *Settings → AI assistant* shows today and the last 30 days
per feature, with costs where they are known.

## Appointments

The dates bar above a mail comes from rules on the device, not from the AI.
*Find appointment* in the reader's AI menu has the assistant read the mail
right away, whatever the automatic setting says; *Check with AI* in the bar
refines what the rules found; and *Look for appointments whenever a mail
opens* does it for every mail (off by default, it costs a request per mail).
With pictures in the mail, their text is added: read by the UwUMail server for
its mailboxes, by the system's text recognition for others (not on Linux).
The pictures themselves never go to the model.

## Privacy

- Only what a feature needs goes to the provider: the mail's text (HTML turned
  into text), subject, date, names and addresses; for labels only their names
  and descriptions and the start of the mail. No attachments, no pictures, no
  other mail; quoted history is left out and the text is cut to size.
- The mail is data, not orders: it is quoted between tags it can't close, the
  model gets no tools, and answers that UwUMail acts on (spam verdicts, dates,
  labels) must have a fixed shape and are checked.
- Which provider and model answered is shown with every answer.
- What the provider does with the text is up to its terms. For mail that must
  not leave the house, use a local model.
