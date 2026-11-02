// Builds the signed Android app: npm run dist:android -> dist/claudetop-<version>.apk
// Needs the Android SDK (Android Studio installs it) and android/keystore.properties with the
// release key (never in git: back up android/claudetop-release.jks and keystore.properties,
// phones only accept updates signed with the same key).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const androidDir = path.join(root, 'android');
const { version } = require(path.join(root, 'package.json'));

if (!fs.existsSync(path.join(androidDir, 'keystore.properties'))) {
  console.error('No android/keystore.properties: the release key is missing (see the comment at the top of this script).');
  process.exit(1);
}

// Gradle needs a JDK 17+; Android Studio brings one.
const env = { ...process.env };
const studioJdk = 'C:/Program Files/Android/Android Studio/jbr';
if (process.platform === 'win32' && fs.existsSync(studioJdk)) env.JAVA_HOME = studioJdk;

const gradlew = path.join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
execFileSync(gradlew, ['assembleRelease', '--console=plain'], { cwd: androidDir, env, stdio: 'inherit', shell: process.platform === 'win32' });

const built = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const out = path.join(root, 'dist', `claudetop-${version}.apk`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(built, out);
console.log(`Built ${path.relative(root, out)} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
