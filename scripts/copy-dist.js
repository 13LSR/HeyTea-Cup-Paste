const fs = require('fs');
const path = require('path');

const srcDir = path.resolve(__dirname, '../frontend/dist');
const destDir = path.resolve(__dirname, '../dist');

function copyRecursive(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

if (!fs.existsSync(srcDir)) {
  console.error('[copy-dist] Source directory not found:', srcDir);
  process.exit(1);
}

if (fs.existsSync(destDir)) {
  fs.rmSync(destDir, { recursive: true, force: true });
}

copyRecursive(srcDir, destDir);
console.log(`[copy-dist] Copied build output from ${srcDir} to ${destDir}`);
