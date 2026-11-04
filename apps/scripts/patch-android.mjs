// Runs after `cap add android`: internet + local-network access (for the station receiver), version code.
import fs from 'node:fs';
const p = 'android/app/src/main/AndroidManifest.xml';
let m = fs.readFileSync(p, 'utf8');
for (const perm of ['INTERNET', 'ACCESS_NETWORK_STATE']) {
  if (!m.includes(`android.permission.${perm}"`)) m = m.replace('</manifest>', `    <uses-permission android:name="android.permission.${perm}" />\n</manifest>`);
}
m = m.replace(/android:allowBackup="true"/, 'android:allowBackup="false"');
if (!m.includes('usesCleartextTraffic')) m = m.replace('<application', '<application android:usesCleartextTraffic="true"');
fs.writeFileSync(p, m);
const vars = 'android/variables.gradle';
if (fs.existsSync(vars)) {
  let v = fs.readFileSync(vars, 'utf8');
  v = v.replace(/(compileSdkVersion|targetSdkVersion)\s*=\s*(\d+)/g, (all, k, n) => `${k} = ${Math.max(Number(n), 36)}`);
  fs.writeFileSync(vars, v);
}
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const [a, b, c] = version.split('.').map(Number);
const code = a * 10000 + b * 100 + c;
const gradle = 'android/app/build.gradle';
let g = fs.readFileSync(gradle, 'utf8');
g = g.replace(/versionCode\s+\d+/, `versionCode ${code}`).replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);
fs.writeFileSync(gradle, g);
console.log(`Android project patched for Marine Monitor ${version} (code ${code})`);
