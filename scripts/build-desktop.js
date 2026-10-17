const { build, Platform } = require("electron-builder");
const packageJson = require("../package.json");

function getAppUrl() {
  const configuredUrl = process.env.ORDERGUARD_APP_URL;
  let url;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error("Set ORDERGUARD_APP_URL ke URL HTTPS aplikasi yang sudah di-deploy sebelum membuat installer.");
  }
  if (url.protocol !== "https:" || !url.hostname || url.hostname.endsWith(".example")) {
    throw new Error("ORDERGUARD_APP_URL harus memakai domain HTTPS produksi, bukan placeholder.");
  }
  return url.toString();
}

async function main() {
  const appUrl = getAppUrl();
  await build({
    targets: Platform.WINDOWS.createTarget("nsis"),
    config: {
      ...packageJson.build,
      extraMetadata: {
        ...packageJson.build.extraMetadata,
        orderGuardAppUrl: appUrl,
      },
    },
  });
}

main().catch((error) => {
  console.error("Gagal membuat installer Windows.", error);
  process.exitCode = 1;
});
