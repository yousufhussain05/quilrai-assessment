const EMAIL = String.raw`(?<![\w.%+-])[\w.%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,6}[A-Za-z]{2,24}`;
const SSN = String.raw`(?<!\d)(?!000|666|9)\d{3}(?<ssnSep>[ -]?)(?!00)\d{2}\k<ssnSep>(?!0000)\d{4}(?!\d)`;
const CARD =
  String.raw`(?<card>(?<!\d)(?=[2-6])(?:\d{13,19}` +
  String.raw`|\d{4}(?<sep>[ -])\d{4}\k<sep>\d{4}\k<sep>\d{4}` +
  String.raw`|\d{4}(?<amexSep>[ -])\d{6}\k<amexSep>\d{5})(?!\d))`;

const PII = new RegExp(`${EMAIL}|${SSN}|${CARD}`, "g");

const MAX_HELD = 512;

function luhn(number: string): boolean {
  const digits = number.replace(/\D/g, "");
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

function findPii(text: string, from = 0): RegExpExecArray[] {
  const found: RegExpExecArray[] = [];
  PII.lastIndex = from;
  for (let m = PII.exec(text); m; m = PII.exec(text)) {
    if (m.groups?.card === undefined || luhn(m[0])) {
      found.push(m);
    } else {
      // retry one char later, a bad candidate can hide a real card like 1234-4111-1111-1111-1111
      PII.lastIndex = m.index + 1;
    }
  }
  return found;
}

function redactRange(text: string, matches: RegExpExecArray[], from: number, to: number): string {
  let out = "";
  let last = from;
  for (const m of matches) {
    const end = m.index + m[0].length;
    if (end > to) break;
    out += text.slice(last, m.index) + "[REDACTED]";
    last = end;
  }
  return out + text.slice(last, to);
}

export function redact(text: string): string {
  return redactRange(text, findPii(text), 0, text.length);
}

// The end of a chunk might be the first half of an email or card number, so we hold
// back the trailing run of characters that could still be part of a match and only
// send what comes before it. Usually that's just the last word.
export class StreamRedactor {
  private lastSent = ""; // the regex lookbehinds need the character before `held`
  private held = "";

  push(delta: string): string {
    const text = this.lastSent + this.held + delta;
    const from = this.lastSent.length;
    const matches = findPii(text, from);

    let cut = text.length;
    while (cut > from && couldContinue(text, cut - 1)) cut--;
    if (text.length - cut > MAX_HELD) {
      // one giant token (base64 or similar), cut it anyway but not through a match
      cut = text.length - MAX_HELD;
      for (const m of matches) {
        if (m.index < cut && m.index + m[0].length > cut) cut = m.index;
      }
    }

    this.held = text.slice(cut);
    if (cut > from) this.lastSent = text[cut - 1];
    return redactRange(text, matches, from, cut);
  }

  flush(): string {
    const text = this.lastSent + this.held;
    const from = this.lastSent.length;
    this.lastSent = "";
    this.held = "";
    return redactRange(text, findPii(text, from), from, text.length);
  }
}

function couldContinue(text: string, i: number): boolean {
  if (text[i] !== " ") return /[\w.%+@-]/.test(text[i]);
  // a space only counts between digit groups, like "4111 1111"
  return i > 0 && /\d/.test(text[i - 1]) && (i === text.length - 1 || /\d/.test(text[i + 1]));
}
