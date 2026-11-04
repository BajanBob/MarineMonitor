// The apps carry their own copy of the web app (../www), so they work even if the relay is asleep.
// They talk to the relay at https://marine-monitor-16qf.onrender.com (changeable in Settings) and, on the
// station's own Wi-Fi, straight to the receiver helper over ws:// (that is why cleartext is allowed).
import fs from 'node:fs';
fs.rmSync('www', { recursive: true, force: true });
fs.cpSync('../www', 'www', { recursive: true });
fs.mkdirSync('assets', { recursive: true });
fs.copyFileSync('../www/icon.svg', 'assets/icon.svg');
console.log('Copied www/ into the app');
