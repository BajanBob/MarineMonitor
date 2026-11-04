// Runs after `cap add ios`: allow the station receiver on the local network (ws://).
import fs from 'node:fs';
import plist from 'plist';
const p = 'ios/App/App/Info.plist';
const info = plist.parse(fs.readFileSync(p, 'utf8'));
info.NSLocalNetworkUsageDescription = 'Marine Monitor connects to your station receiver on the local network to show ships and alerts it hears directly by radio.';
info.NSAppTransportSecurity = { NSAllowsLocalNetworking: true };
info.ITSAppUsesNonExemptEncryption = false;
fs.writeFileSync(p, plist.build(info));
console.log('iOS project patched for Marine Monitor (sign with your Apple Developer account to install)');
