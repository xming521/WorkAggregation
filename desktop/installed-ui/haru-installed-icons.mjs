import assert from 'node:assert/strict';
import path from 'node:path';
import { unlinkedFile } from './filesystem-safety.mjs';
import { sameWindowsPath } from './contract.mjs';

// Run in the already verified installed main process. Read only its own PE
// icon and the shortcut whose fixed name was created by this installation.
export async function readInstalledIcons({ app, shell }) {
  const path = require('node:path');
  const exe = app.getPath('exe');
  const shortcut = shell.readShortcutLink(path.join(app.getPath('desktop'), 'OfferPilot Desktop.lnk'));
  const icons = [];
  for (const size of ['small', 'normal']) {
    const icon = await app.getFileIcon(exe, { size });
    if (icon.isEmpty()) throw new Error('Installed executable has no readable icon');
    icons.push({ size, dimensions: icon.getSize(), png: icon.toPNG().toString('base64') });
  }
  return { exe, shortcut, icons };
}

export function verifyShortcutIdentity(result, expectedExe) {
  const canonical = filename => unlinkedFile(path.dirname(filename), path.basename(filename));
  const expected = canonical(expectedExe);
  assert.ok(sameWindowsPath(canonical(result.exe), expected), 'Unexpected running executable');
  assert.ok(sameWindowsPath(canonical(result.shortcut.target), expected), 'Desktop shortcut targets another executable');
  if (result.shortcut.icon) assert.ok(sameWindowsPath(canonical(result.shortcut.icon), expected), 'Unexpected shortcut icon source');
  assert.ok(!result.shortcut.args, 'Unexpected shortcut arguments');
  assert.equal(result.shortcut.iconIndex, 0);
  return true;
}

export function validateInstalledIcon(item) {
  assert.ok(['small', 'normal'].includes(item.size));
  const { width, height } = item.dimensions;
  assert.ok(Number.isInteger(width) && width >= 16 && width <= 256);
  assert.equal(height, width);
  const bytes = Buffer.from(item.png, 'base64');
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.readUInt32BE(16), width);
  assert.equal(bytes.readUInt32BE(20), height);
  return bytes;
}
