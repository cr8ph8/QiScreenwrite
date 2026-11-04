import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
const root = process.cwd();
const binary = process.argv[2];
if (!binary || !fs.existsSync(binary)) throw new Error('Pass the SwiftPM executable path, or run npm run desktop:build.');
// Stage outside synced Documents: file-provider Finder metadata breaks signing.
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'qiscreenwrite-desktop-'));
fs.mkdirSync(path.join(root, 'build-desktop'), {recursive:true});
fs.mkdirSync(output, { recursive: true });
const app = path.join(output, `QiCanIScreenwrite-${Date.now()}.app`);
const contents = path.join(app, 'Contents'), resources = path.join(contents, 'Resources');
fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
fs.mkdirSync(resources);
fs.copyFileSync(binary, path.join(contents, 'MacOS/QiCanIScreenwrite'));
fs.copyFileSync(process.execPath, path.join(resources, 'node'));
fs.chmodSync(path.join(contents, 'MacOS/QiCanIScreenwrite'), 0o755);
fs.chmodSync(path.join(resources, 'node'), 0o755);
for (const name of ['dist-local', 'local/server', 'local/contracts', 'local/accounting', 'local/desktop', 'shared/creative-services']) fs.cpSync(path.join(root, name), path.join(resources, 'runtime', name), { recursive: true });
fs.copyFileSync(path.join(root, 'local/DESKTOP-GUIDE.md'), path.join(resources, 'Desktop Guide.md'));
fs.writeFileSync(path.join(resources, 'runtime/package.json'), '{"type":"module","private":true}\n');
const iconset = path.join(output, 'QiCanIScreenwrite.iconset');
fs.mkdirSync(iconset, { recursive: true });
for (const size of [16,32,128,256,512]) for (const scale of [1,2]) {
  execFileSync('/usr/bin/sips', ['-z', String(size*scale), String(size*scale), path.join(root, 'desktop/Resources/QiCanIScreenwrite.png'), '--out', path.join(iconset, `icon_${size}x${size}${scale===2?'@2x':''}.png`)], { stdio: 'pipe' });
}
execFileSync('/usr/bin/iconutil', ['-c','icns','-o',path.join(resources, 'QiCanIScreenwrite.icns'),iconset]);
fs.writeFileSync(path.join(contents,'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>QiCanIScreenwrite</string>
<key>CFBundleIdentifier</key><string>com.hampton.qicaniscreenwrite.local</string>
<key>CFBundleName</key><string>QiCanIScreenwrite</string>
<key>CFBundleDisplayName</key><string>QiCanIScreenwrite</string>
<key>CFBundleIconFile</key><string>QiCanIScreenwrite.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.9.0</string>
<key>CFBundleVersion</key><string>12</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>CFBundleDocumentTypes</key><array><dict><key>CFBundleTypeName</key><string>Screenplay</string><key>CFBundleTypeRole</key><string>Editor</string><key>LSHandlerRank</key><string>Alternate</string><key>CFBundleTypeExtensions</key><array><string>fountain</string><string>fdx</string></array></dict></array>
</dict></plist>\n`);
// Preserve dependency notices for the bundled frontend and the Node runtime.
const notices = ['QiScreenwrite local desktop build.\n', fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'), fs.readFileSync(path.join(root, 'THIRD_PARTY_LICENSES/shadcn-ui-MIT.txt'), 'utf8')];
for (const entry of fs.readdirSync(path.join(root, 'node_modules'), { withFileTypes: true })) {
  const dirs = entry.name.startsWith('@') ? fs.readdirSync(path.join(root,'node_modules',entry.name)).map(n => `${entry.name}/${n}`) : [entry.name];
  for (const name of dirs) {
    const dir=path.join(root,'node_modules',name);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).filter(n=>/^licen[cs]e(?:\.|$)/i.test(n))) {
      if (fs.statSync(path.join(dir,file)).isFile()) notices.push(`\n${name}\n${fs.readFileSync(path.join(dir,file),'utf8')}`);
    }
  }
}
const nodeLicense = path.join(root, `desktop/Resources/Node-${process.version}.LICENSE`);
if (!fs.existsSync(nodeLicense)) throw new Error(`Bundle the matching Node ${process.version} license before packaging.`);
notices.push(`Node.js ${process.version}\n${fs.readFileSync(nodeLicense, 'utf8')}`);
fs.writeFileSync(path.join(resources,'ThirdPartyNotices.txt'), notices.join('\n'));
const hashes={};
for (const relative of ['MacOS/QiCanIScreenwrite','Resources/node','Resources/QiCanIScreenwrite.icns']) hashes[relative]=crypto.createHash('sha256').update(fs.readFileSync(path.join(contents,relative))).digest('hex');
fs.writeFileSync(path.join(resources,'build-evidence.json'),JSON.stringify({builtAt:new Date().toISOString(),source:'https://github.com/cr8ph8/QiScreenwrite',node:process.version,projectDataBundled:false,unsignedInputSha256:hashes},null,2));
// Clear copied Finder metadata only on this newly generated bundle before signing.
execFileSync('/usr/bin/xattr',['-cr',app]);
execFileSync('/usr/bin/codesign',['--force','--sign','-',path.join(resources,'node')]);
execFileSync('/usr/bin/codesign',['--force','--sign','-',app]);
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app]);
const installedHashes = {};
for (const relative of Object.keys(hashes)) installedHashes[relative] = crypto.createHash('sha256').update(fs.readFileSync(path.join(contents, relative))).digest('hex');
fs.writeFileSync(path.join(root,'build-desktop/latest.json'),JSON.stringify({app,builtAt:new Date().toISOString(),signedPayloadSha256:installedHashes},null,2)+'\n');
console.log(JSON.stringify({app,standalone:true,projectDataBundled:false}));
