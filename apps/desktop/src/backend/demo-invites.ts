import { BackendError } from "./backend";
import type { Message, MailScheduling, ParticipationStatus, SchedulingPerson } from "./types";

/** `days` from today at a local wall time, as the UTC instant the app gets from its core. */
function at(days: number, hour: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const EMMA = "emma.vogt@brightlabs.example";

/**
 * The demo's calendar mail, told apart by the names of their .ics parts: Emma's invitation to the
 * logo review (a Microsoft mailbox, answered through Microsoft), Noah's answer to Mini's game night
 * (a UwUMail server), and a cancellation of the logo review that only looks like it comes from Emma.
 */
export class DemoInvites {
  private status: ParticipationStatus = "needs-action";
  private comment: string | null = null;

  scheduling(message: Message, de: boolean): MailScheduling | null {
    const part = message.attachments.find((attachment) => /\.ics$/i.test(attachment.filename));
    if (!part) return null;
    const me: SchedulingPerson = { email: "mini@pixelstudio.example", name: "Mini", status: this.status };
    const emma: SchedulingPerson = { email: EMMA, name: "Emma Vogt", status: "accepted" };
    const logoReview: MailScheduling = {
      kind: "invitation",
      method: "request",
      title: de ? "Logo-Review, Runde 2" : "Logo review, round 2",
      start: at(2, 10),
      end: at(2, 11),
      allDay: false,
      location: de ? "Bright Labs, Raum 4" : "Bright Labs, room 4",
      organizer: "Emma Vogt",
      organizerEmail: EMMA,
      attendees: [emma, me, { email: "jonas@brightlabs.example", name: "Jonas Brandt", status: "tentative" }],
      moreAttendees: 0,
      repeats: false,
      occurrence: null,
      verified: message.from.email.toLowerCase() === EMMA,
      sender: message.from.email.toLowerCase(),
      senderConfirmed: true,
      status: this.status,
      attendee: null,
      attendeeEmail: null,
      cancelled: false,
      revision: "same",
      inCalendar: true,
      place: "microsoft",
      canAnswer: true,
      canComment: true,
      canRemove: false,
    };
    if (/reply/i.test(part.filename)) {
      return {
        ...logoReview,
        kind: "reply",
        method: "reply",
        title: de ? "Spieleabend" : "Game night",
        start: at(4, 19),
        end: at(4, 23),
        location: de ? "Bei Mini" : "At Mini's",
        organizer: "Mini",
        organizerEmail: "mini@uwumail.example",
        attendees: [],
        verified: true,
        sender: message.from.email.toLowerCase(),
        status: "accepted",
        attendee: message.from.name ?? message.from.email,
        attendeeEmail: message.from.email.toLowerCase(),
        place: "server",
        canAnswer: false,
        canComment: false,
      };
    }
    if (/cancel/i.test(part.filename)) {
      const verified = message.from.email.toLowerCase() === EMMA;
      return {
        ...logoReview,
        method: "cancel",
        verified,
        cancelled: verified,
        canAnswer: false,
        canRemove: verified,
      };
    }
    return { ...logoReview, canAnswer: logoReview.verified };
  }

  respond(message: Message, status: Exclude<ParticipationStatus, "needs-action">, comment?: string) {
    const found = this.scheduling(message, false);
    if (!found?.canAnswer) throw new BackendError("invalid_input", "This invitation can't be answered from here.");
    this.status = status;
    this.comment = comment?.trim() || null;
  }

  /** What the last answer carried along, for tests. */
  lastComment(): string | null {
    return this.comment;
  }

  remove(message: Message) {
    if (!this.scheduling(message, false)?.canRemove) {
      throw new BackendError("invalid_input", "Only an event its organizer cancelled can be removed from here.");
    }
  }
}
