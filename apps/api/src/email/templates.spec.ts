import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mailLogo } from './brand.js';
import { MAIL_LOGO } from './mail-logo.js';
import { accountDeletedEmail, escapeHtml, verificationEmail } from './templates.js';

const logo = mailLogo('https://app.test');

describe('email templates', () => {
  it('shows the logo the web app serves, with the name as its alt text', () => {
    const mail = verificationEmail(
      { name: 'Alice', link: 'https://x.test/v?token=t', hours: 24 },
      logo,
    );
    expect(mail.html).toContain(
      `<img src="https://app.test/mail-logo.png" width="${logo.width}" height="${logo.height}" alt="BeSo"`,
    );
    expect(mail.html).toContain('href="https://x.test/v?token=t"');
    expect(mail.text).toContain('https://x.test/v?token=t');
  });

  it('escapes what the member typed, in every template', () => {
    const name = 'A <b>bold</b> "name"';
    expect(verificationEmail({ name, link: 'https://x.test', hours: 1 }, logo).html).toContain(
      escapeHtml(name),
    );
    expect(accountDeletedEmail({ name }, logo).html).not.toContain('<b>bold</b>');
    expect(accountDeletedEmail({ name }, logo).text).toContain(name);
  });

  it('links to a picture the web app ships, drawn at 4× the size the layout shows', async () => {
    // Both sides come from `pnpm brand`: this fails when one was regenerated without the other.
    const png = await readFile(
      fileURLToPath(new URL('../../../web/public/mail-logo.png', import.meta.url)),
    );
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    // IHDR: width, then height, big-endian, right after the signature and the chunk header.
    expect(png.readUInt32BE(20)).toBe(MAIL_LOGO.height * 4);
    expect(Math.abs(png.readUInt32BE(16) / 4 - MAIL_LOGO.width)).toBeLessThanOrEqual(1);
    expect(png.length).toBeLessThan(24 * 1024);
  });
});
