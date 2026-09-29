import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoAssist, demoKeyword } from "./demo-assist";
import { buildMessages } from "./demo-data";
import type { Message } from "./types";

function setup(lang: "de" | "en" = "de") {
  const messages: Message[] = buildMessages(lang);
  const changes: boolean[] = [];
  const assist = new DemoAssist(
    lang,
    () => messages,
    (mail) => changes.push(mail),
  );
  return { assist, messages, changes };
}

describe("the demo's assistant", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("makes keywords the way the server does", () => {
    expect(demoKeyword("Bestellungen & Versand", [])).toBe("bestellungen-versand");
    expect(demoKeyword("Persönlich", [])).toBe("persoenlich");
    expect(demoKeyword("Reisen", ["reisen"])).toBe("reisen-2");
    expect(demoKeyword("✈️", ["a"])).toBe("label-2");
  });

  it("starts with labels on the sample mail, each with a reason", () => {
    const { assist, messages } = setup();
    const labels = assist.listLabels();
    expect(labels.map((label) => label.keyword)).toEqual(["rechnungen", "newsletter", "bestellungen-versand"]);
    const order = messages.find((message) => message.subject.startsWith("Deine Bestellung"))!;
    expect(order.keywords).toEqual(["bestellungen-versand"]);
    const [entry] = assist.labelLog([order.id], 10);
    expect(entry).toMatchObject({ emailId: order.id, name: "Bestellungen & Versand", undone: false });
    expect(entry!.reason).not.toBe("");
  });

  it("streams a text in pieces that add up to the answer, with who wrote it", async () => {
    const { assist } = setup();
    const pieces: string[] = [];
    let subject = "";
    const writing = assist.compose(
      { mode: "write", instruction: "Sag Mia für Freitag ab", wantSubject: true },
      { onDelta: (text) => pieces.push(text), onSubject: (value) => (subject = value) },
    );
    await vi.runAllTimersAsync();
    const result = await writing;
    expect(pieces.length).toBeGreaterThan(3);
    expect(pieces.join("")).toBe(result.text);
    expect(result.subject).toBe("Sag Mia für Freitag ab");
    expect(subject).toBe(result.subject);
    expect(result).toMatchObject({ providerName: "Mistral (Server)", model: "mistral-medium-latest" });
    expect(assist.usageReport(1).today[0]).toMatchObject({ providerId: "q1", requests: 1, requestsPerDay: 200 });
  });

  it("stops writing once aborted", async () => {
    const { assist } = setup();
    const controller = new AbortController();
    const pieces: string[] = [];
    const writing = assist.summarize(
      { threadId: "thr-1" },
      {
        signal: controller.signal,
        onDelta: (text) => {
          pieces.push(text);
          if (pieces.length === 2) controller.abort();
        },
      },
    );
    const outcome = expect(writing).rejects.toMatchObject({ name: "AbortError" });
    await vi.runAllTimersAsync();
    await outcome;
    expect(pieces).toHaveLength(2);
  });

  it("needs a text to rewrite and an instruction to write", async () => {
    const { assist } = setup();
    await expect(assist.compose({ mode: "rewrite", preset: "formal", text: " " })).rejects.toMatchObject({
      type: "invalidArguments",
    });
    await expect(assist.compose({ mode: "write" })).rejects.toMatchObject({ type: "invalidArguments" });
  });

  it("reads the game night out of Noah's mail", async () => {
    const { assist, messages } = setup();
    const mail = messages.find((message) => message.subject.startsWith("Spieleabend"))!;
    const reading = assist.extractEvents(mail.id);
    await vi.runAllTimersAsync();
    const { events } = await reading;
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({ title: "Spieleabend am Freitag", allDay: false, timeZone: null, url: null });
    expect(event!.start).toMatch(/T19:00:00$/);
    expect(new Date(event!.start).getDay()).toBe(5);
    expect(event!.end > event!.start).toBe(true);
    expect(event!.quote).toContain("Freitag");
    expect(event!.participants).toEqual([{ name: mail.from.name, email: mail.from.email }]);
  });

  it("calls the fake invoice phishing and shows the server's findings", async () => {
    const { assist, messages } = setup();
    const mail = messages.find((message) => message.subject.startsWith("Ihre Rechnung"))!;
    const checking = assist.spamCheck(mail.id);
    await vi.runAllTimersAsync();
    const check = await checking;
    expect(check.verdict).toBe("phishing");
    expect(check.signals.authentication.dmarc).toBe("fail");
    expect(check.signals.sender).toMatchObject({ earlierMessages: 0, inContacts: false, firstSeen: null });
  });

  it("uses an own provider once chosen, and forgets the choice with the provider", () => {
    const { assist } = setup();
    const own = assist.createProvider({ name: "Mein OpenAI", kind: "openai", apiKey: "sk-demo-1234" });
    expect(own).toMatchObject({ scope: "personal", hasKey: true, keyHint: "…1234", connected: true });
    assist.updateSettings({ features: { compose: { providerId: own.id, model: "gpt-5" } } });
    expect(assist.getSettings().effective.compose).toMatchObject({ providerId: own.id, model: "gpt-5" });
    expect(assist.getSettings().effective.summarize?.providerId).toBe("q1");
    assist.deleteProvider(own.id);
    expect(assist.getSettings().features.compose).toBeNull();
    expect(assist.getSettings().effective.compose?.providerId).toBe("q1");
  });

  it("refuses to change the server's providers", () => {
    const { assist } = setup();
    expect(() => assist.updateProvider("q1", { name: "x" })).toThrow(expect.objectContaining({ type: "forbidden" }));
  });

  it("signs a ChatGPT provider in after a few polls", () => {
    const { assist } = setup();
    const chatgpt = assist.createProvider({ name: "ChatGPT", kind: "chatgpt" });
    expect(chatgpt).toMatchObject({ experimental: true, connected: false });
    const login = assist.chatgptLogin(chatgpt.id);
    expect(login.verificationUri).toMatch(/^https:\/\/[^/]+\.example\.com\//);
    expect(assist.chatgptPoll(chatgpt.id).status).toBe("pending");
    expect(assist.chatgptPoll(chatgpt.id).status).toBe("pending");
    expect(assist.chatgptPoll(chatgpt.id).status).toBe("connected");
    expect(assist.listProviders().find((provider) => provider.id === chatgpt.id)?.connected).toBe(true);
  });

  it("takes a label off with undo and off every mail when it goes", () => {
    const { assist, messages, changes } = setup();
    const order = messages.find((message) => message.subject.startsWith("Deine Bestellung"))!;
    const [entry] = assist.labelLog([order.id], 10);
    assist.undo([entry!.id]);
    expect(order.keywords).toEqual([]);
    expect(assist.labelLog([order.id], 10)[0]?.undone).toBe(true);

    const newsletter = assist.listLabels().find((label) => label.keyword === "newsletter")!;
    assist.deleteLabel(newsletter.id);
    expect(messages.some((message) => message.keywords?.includes("newsletter"))).toBe(false);
    expect(changes).toContain(true);
  });

  it("refuses a second label of the same name", () => {
    const { assist } = setup();
    expect(() => assist.createLabel({ name: "newsletter", description: "", color: null })).toThrow(
      expect.objectContaining({ type: "invalidProperties", properties: ["name"] }),
    );
  });
});
