export const offers = ['pilot', 'managed', 'scale'] as const;
export const frequencies = ['One-time pilot', 'Daily', 'Weekly', 'Monthly', 'Let’s discuss'] as const;
export const volumes = ['Up to 500 records', '501–5,000 records', '5,001–20,000 records', 'More than 20,000', 'Not sure yet'] as const;
export const formats = ['CSV', 'JSON', 'Let’s discuss an integration'] as const;
export const PRIVACY_VERSION = '2026-10-29';

export interface PilotData {
 offer: typeof offers[number]; websites: string[]; fields: string;
 frequency: typeof frequencies[number]; volume: typeof volumes[number]; format: typeof formats[number];
 name: string; company: string; email: string; notes: string;
}
export interface PilotSubmission extends PilotData { requestId: string; token: string; website_confirm: string }
export class InputError extends Error {
 constructor(public field: string, message: string) { super(message); }
}
const singleLine = /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
function text(value: unknown, field: string, min: number, max: number, multiline = false): string {
 if (typeof value !== 'string') throw new InputError(field, 'Please complete this field.');
 const result = value.trim().normalize('NFC');
 if (result.length < min || result.length > max || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : singleLine).test(result))
  throw new InputError(field, `Please enter ${min ? 'between '+min+' and ' : 'no more than '}${max} characters.`);
 return result;
}
function choice<T extends readonly string[]>(value: unknown, field: string, allowed: T): T[number] {
 if (typeof value !== 'string' || !allowed.includes(value)) throw new InputError(field, 'Please choose one of the available options.');
 return value;
}
export function validateSubmission(input: unknown): PilotSubmission {
 if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('form', 'Please submit a valid enquiry.');
 const data = input as Record<string, unknown>;
 const requestId = text(data.requestId, 'form', 36, 36);
 if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new InputError('form', 'Please reload the form and try again.');
 if (!Array.isArray(data.websites) || data.websites.length < 1 || data.websites.length > 3) throw new InputError('websites', 'Please share between one and three websites.');
 const websites = data.websites.map(raw => {
  const value = text(raw, 'websites', 8, 500);
  let url: URL;
  try { url = new URL(value); } catch { throw new InputError('websites', 'Please use complete http or https website URLs.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(url.hostname) || /^(172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname) || /\.(local|internal)$/.test(url.hostname) || url.hostname.startsWith('['))
   throw new InputError('websites', 'Please share public website URLs without credentials.');
  url.hash = '';
  return url.toString();
 });
 if (new Set(websites).size !== websites.length) throw new InputError('websites', 'Please list each website only once.');
 const email = text(data.email, 'email', 5, 254).toLowerCase();
 if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new InputError('email', 'Please enter a valid email address.');
 return {
  requestId, token: text(data.token, 'verification', 1, 2048), website_confirm: text(data.website_confirm ?? '', 'form', 0, 200),
  offer: choice(data.offer, 'offer', offers), websites, fields: text(data.fields, 'fields', 3, 2000, true),
  frequency: choice(data.frequency, 'frequency', frequencies), volume: choice(data.volume, 'volume', volumes), format: choice(data.format, 'format', formats),
  name: text(data.name, 'name', 2, 120), company: text(data.company, 'company', 2, 160), email, notes: text(data.notes ?? '', 'notes', 0, 2000, true),
 };
}
export function enquiryData(submission: PilotSubmission): PilotData {
 const {requestId: _id, token: _token, website_confirm: _trap, ...data} = submission;
 return data;
}
