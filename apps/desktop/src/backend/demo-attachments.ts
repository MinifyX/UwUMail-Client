// Generated files for demo attachments, so previews work without a server.

function sunset(): Blob {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b1d4f"/><stop offset="0.55" stop-color="#ff7a8a"/><stop offset="1" stop-color="#ffc58a"/></linearGradient>
<linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6d4a8f"/><stop offset="1" stop-color="#241436"/></linearGradient></defs>
<rect width="1200" height="675" fill="url(#sky)"/><circle cx="600" cy="430" r="120" fill="#ffe3a3" opacity="0.95"/>
<rect y="430" width="1200" height="245" fill="url(#sea)"/>
<path d="M0 520 Q300 490 600 520 T1200 520" stroke="#ffb3c6" stroke-width="4" fill="none" opacity="0.5"/>
<path d="M0 470 L180 380 L320 450 L420 400 L560 470 Z" fill="#2a1838" opacity="0.85"/></svg>`;
  return new Blob([svg], { type: "image/svg+xml" });
}

/** A valid one-page PDF with a title and a few lines (ASCII only). */
function pdf(title: string, lines: string[]): Blob {
  const text = [
    "BT /F1 26 Tf 72 720 Td",
    `(${title}) Tj`,
    "/F1 13 Tf 0 -40 Td 18 TL",
    ...lines.map((line) => `(${line}) '`),
    "ET",
    "0.88 0.11 0.45 rg 72 420 180 90 re f",
    "0.99 0.30 0.55 rg 272 420 180 90 re f",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([out], { type: "application/pdf" });
}

/** A short rising two-tone chime as 16-bit mono WAV. */
function chime(): Blob {
  const rate = 22050;
  const samples = Math.floor(rate * 1.2);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) =>
    [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  write(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i += 1) {
    const t = i / rate;
    const frequency = t < 0.5 ? 660 : 880;
    const envelope = Math.exp(-3 * (t < 0.5 ? t : t - 0.5));
    view.setInt16(44 + i * 2, Math.sin(2 * Math.PI * frequency * t) * envelope * 12000, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

const text = (content: string, type = "text/plain") => new Blob([content], { type: `${type};charset=utf-8` });

export function demoAttachmentBlob(filename: string, mimeType: string): Blob {
  const name = filename.toLowerCase();
  if (mimeType.startsWith("image/")) return sunset();
  if (name.endsWith(".pdf") && !name.endsWith(".exe")) {
    return pdf("Logo-Varianten", [
      "Variante A: klassisch",
      "Variante B: verspielt, Favorit des Teams",
      "Variante C: minimal",
    ]);
  }
  if (name.endsWith(".csv")) {
    return text(
      "Position;Projekt;Status;Dauer (min)\n1;Kaffee & Kuchen Spot;fertig;42\n2;Logo-Animation;läuft;18\n3;UwUMail Trailer;wartet;95\n",
      "text/csv",
    );
  }
  if (name.endsWith(".ics")) {
    return text(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        "SUMMARY:Logo-Review\\, Runde 2",
        "DTSTART:20260918T120000Z",
        "DTEND:20260918T130000Z",
        "LOCATION:Bright Labs\\, Raum 4",
        'ORGANIZER;CN="Emma Vogt":mailto:emma.vogt@brightlabs.example',
        "DESCRIPTION:Wir schauen uns Variante B an.\\nBitte Entwürfe mitbringen.",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
      "text/calendar",
    );
  }
  if (name.endsWith(".vcf")) {
    return text(
      "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Lukas Editz\r\nORG:Pixel Studio\r\nTITLE:Cutter\r\nEMAIL:lukas@pixelstudio.example\r\nTEL:+49 30 1234567\r\nEND:VCARD\r\n",
      "text/vcard",
    );
  }
  if (name.endsWith(".wav") || mimeType.startsWith("audio/")) return chime();
  if (name.endsWith(".exe")) return new Blob([new Uint8Array([0x4d, 0x5a, 0x90, 0x00])], { type: mimeType });
  return text(
    "Notizen zum Logo\n\n- Pink etwas kräftiger\n- Schriftzug enger setzen\n- Favicon in 16 px testen\n\nDeadline: Mittwoch",
  );
}
